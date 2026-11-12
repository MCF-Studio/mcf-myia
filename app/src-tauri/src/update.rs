//! Mises à jour automatiques (tauri-plugin-updater).
//!
//! Au démarrage, l'app lit `latest.json` de la dernière release GitHub. Si une version plus récente existe, elle
//! télécharge l'installateur, vérifie sa signature avec la clé publique embarquée (tauri.conf.json), l'installe et
//! redémarre. Tout se passe ici, côté Rust : la page n'a aucun accès réseau et ne peut ni choisir l'adresse ni
//! fournir un fichier. Un installateur non signé par la clé de MCF Studio est refusé.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

/// `state` : idle | checking | current | available | downloading | installing | error.
/// `available` : version plus récente publiée mais pas installée (build de développement, qui ne s'installe jamais).
#[derive(Serialize, Clone)]
pub struct UpdateStatus {
    state: &'static str,
    version: Option<String>,
    percent: Option<u8>,
    error: Option<String>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self { state: "idle", version: None, percent: None, error: None }
    }
}

#[derive(Default)]
pub struct Updates {
    status: Mutex<UpdateStatus>,
    busy: AtomicBool,
}

fn set(app: &AppHandle, state: &'static str, version: Option<String>, percent: Option<u8>, error: Option<String>) {
    let status = UpdateStatus { state, version, percent, error };
    *app.state::<Updates>().status.lock().unwrap() = status.clone();
    let _ = app.emit("update://status", status);
}

async fn run(app: &AppHandle) -> Result<(), String> {
    set(app, "checking", None, None, None);
    // Avant de lancer l'installateur : fermer les consoles et le cœur, sinon node.exe reste verrouillé
    // et l'installateur ne peut pas le remplacer.
    let h = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            h.state::<crate::pty::Ptys>().kill_all();
            h.state::<crate::sidecar::Sidecar>().stop();
        })
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        set(app, "current", None, None, None);
        return Ok(());
    };

    let version = update.version.clone();
    set(app, "downloading", Some(version.clone()), Some(0), None);
    let (h1, v1) = (app.clone(), version.clone());
    let (h2, v2) = (app.clone(), version.clone());
    let mut received: u64 = 0;
    let mut last: u8 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let pct = match total {
                    Some(t) if t > 0 => (received.saturating_mul(100) / t).min(100) as u8,
                    _ => 0,
                };
                if pct != last {
                    last = pct;
                    set(&h1, "downloading", Some(v1.clone()), Some(pct), None);
                }
            },
            move || set(&h2, "installing", Some(v2.clone()), Some(100), None),
        )
        .await
        .map_err(|e| e.to_string())?;

    // Sous Windows, l'installateur a déjà fermé l'app. Ailleurs, on redémarre sur la nouvelle version.
    app.restart();
}

/// Une seule recherche à la fois. En cas d'échec (pas de réseau, GitHub indisponible), l'app continue normalement.
async fn check(app: AppHandle) {
    let updates = app.state::<Updates>();
    if updates.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = run(&app).await {
        eprintln!("[myia] mise à jour : {e}");
        set(&app, "error", None, None, Some(e));
    }
    updates.busy.store(false, Ordering::SeqCst);
}

/// En développement : on regarde seulement si une version plus récente est publiée, sans rien télécharger ni installer
/// (un build local n'est pas une version publiée).
async fn peek(app: AppHandle) {
    set(&app, "checking", None, None, None);
    let found = match app.updater_builder().build() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match found {
        Ok(Some(u)) => set(&app, "available", Some(u.version.clone()), None, None),
        Ok(None) => set(&app, "current", None, None, None),
        Err(e) => set(&app, "error", None, None, Some(e)),
    }
}

/// Recherche au démarrage. En développement, simple consultation (voir `peek`).
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        tauri::async_runtime::spawn(peek(app.clone()));
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(check(app));
}

#[tauri::command]
pub fn update_status(state: State<'_, Updates>) -> UpdateStatus {
    state.status.lock().unwrap().clone()
}

/// Recherche manuelle (Paramètres → Système). Installe et redémarre si une version plus récente existe.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    if cfg!(debug_assertions) {
        return Err("les mises à jour sont désactivées en développement".into());
    }
    check(app.clone()).await;
    let status = app.state::<Updates>().status.lock().unwrap().clone();
    Ok(status)
}
