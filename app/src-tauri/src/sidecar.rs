//! Sidecar Node (agent/dist/server/main.js) : le cœur de MyIA, en JSON-RPC sur stdio.
//! Rust ne fait que relayer les lignes : la validation des requêtes est faite par le sidecar.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const MAX_LINE: usize = 4 * 1024 * 1024;
const LOG_MAX: u64 = 5 * 1024 * 1024;

#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
pub struct SidecarStatus {
    running: bool,
    pid: Option<u32>,
    home: String,
    error: Option<String>,
}

/// Où trouver le cœur et où ranger les données.
///
/// Installé (release) : Node et le cœur sont embarqués dans les ressources de l'app, les données vont dans
/// `%APPDATA%/fr.mcfstudio.myia`. En développement (debug) : `node` du PATH, cœur et données à la racine du dépôt.
/// MYIA_HOME force le dossier de données dans les deux cas.
struct Layout {
    node: PathBuf,
    script: PathBuf,
    home: PathBuf,
}

static HOME: OnceLock<PathBuf> = OnceLock::new();

/// Dossier de données de MyIA (config/, data/, workspace/…), fixé au premier démarrage du cœur.
pub fn home() -> PathBuf {
    HOME.get().cloned().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(debug_assertions)]
fn layout(_app: &AppHandle) -> Result<Layout, String> {
    // Racine du dépôt : en développement SEULEMENT (une release ne charge jamais de code depuis un chemin de build).
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    let dev = dev.canonicalize().unwrap_or(dev);
    Ok(Layout {
        node: std::env::var("MYIA_NODE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("node")),
        script: dev.join("agent").join("dist").join("server").join("main.js"),
        home: std::env::var("MYIA_HOME").map(PathBuf::from).unwrap_or(dev),
    })
}

#[cfg(not(debug_assertions))]
fn layout(app: &AppHandle) -> Result<Layout, String> {
    use tauri::Manager;
    let res = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources").join("sidecar");
    let home = match std::env::var("MYIA_HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    Ok(Layout { node: res.join("node.exe"), script: res.join("main.mjs"), home })
}

/// canonicalize() renvoie des chemins \\?\C:\… sous Windows : Node les accepte mal.
fn plain(p: &Path) -> String {
    let s = p.display().to_string();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

impl Sidecar {
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let fail = |msg: String| {
            *self.last_error.lock().unwrap() = Some(msg.clone());
            Err(msg)
        };
        let l = match layout(app) {
            Ok(l) => l,
            Err(e) => return fail(format!("emplacement du cœur introuvable : {e}")),
        };
        if !l.script.exists() {
            return fail(if cfg!(debug_assertions) {
                format!("{} introuvable : lance « npm run build » dans agent/", plain(&l.script))
            } else {
                "installation incomplète : le cœur de MyIA est absent, réinstalle l'application".into()
            });
        }
        if let Err(e) = fs::create_dir_all(&l.home) {
            return fail(format!("impossible de créer {} : {e}", plain(&l.home)));
        }
        let _ = HOME.set(l.home.clone());
        let home = l.home.clone();
        let version = app.package_info().version.to_string();
        let mut cmd = Command::new(&l.node);
        cmd.arg(plain(&l.script))
            .current_dir(plain(&home))
            .env("MYIA_HOME", plain(&home))
            .env("MYIA_VERSION", version)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if cfg!(debug_assertions) => {
                return fail(format!("impossible de lancer Node ({e}). Node 22+ doit être dans le PATH, ou MYIA_NODE défini."))
            }
            Err(e) => return fail(format!("impossible de lancer le cœur de MyIA ({e}) : réinstalle l'application")),
        };

        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        *self.stdin.lock().unwrap() = child.stdin.take();
        *self.child.lock().unwrap() = Some(child);
        *self.last_error.lock().unwrap() = None;

        // stdout : une ligne JSON-RPC = un événement pour le front.
        let h = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) if !l.is_empty() => {
                        let _ = h.emit("sidecar://message", l);
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let _ = h.emit("sidecar://exit", ());
        });

        // stderr : journal fichier (runtime/app-sidecar.log), remis à zéro au-delà de 5 Mo.
        let log_path = home.join("runtime").join("app-sidecar.log");
        let h = app.clone();
        std::thread::spawn(move || {
            if let Some(dir) = log_path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            if fs::metadata(&log_path).map(|m| m.len() > LOG_MAX).unwrap_or(false) {
                let _ = fs::remove_file(&log_path);
            }
            let mut file = OpenOptions::new().create(true).append(true).open(&log_path).ok();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(f) = file.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
                let _ = h.emit("sidecar://log", line);
            }
        });
        Ok(())
    }

    /// Fermer stdin demande au sidecar de s'arrêter proprement ; on le tue après 3 s.
    pub fn stop(&self) {
        self.stdin.lock().unwrap().take();
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(3) {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.lock().unwrap().as_ref().map(|c| c.id())
    }

    fn running(&self) -> bool {
        match self.child.lock().unwrap().as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }
}

#[tauri::command]
pub fn sidecar_send(line: String, state: State<'_, Sidecar>) -> Result<(), String> {
    if line.len() > MAX_LINE {
        return Err("message trop long".into());
    }
    if line.contains('\n') || line.contains('\r') {
        return Err("message invalide (saut de ligne)".into());
    }
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("le cœur MyIA n'est pas lancé")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("envoi impossible : {e}"))
}

#[tauri::command]
pub fn sidecar_restart(app: AppHandle, state: State<'_, Sidecar>) -> Result<(), String> {
    state.stop();
    state.start(&app)
}

#[tauri::command]
pub fn sidecar_status(state: State<'_, Sidecar>) -> SidecarStatus {
    SidecarStatus {
        running: state.running(),
        pid: state.pid(),
        home: plain(&home()),
        error: state.last_error.lock().unwrap().clone(),
    }
}
