//! Touche « parler à MASTER » (appuyer pour parler), globale : active même quand la fenêtre est cachée.
//!
//! La touche est enregistrée ICI, côté Rust : la page n'a pas la permission d'enregistrer des raccourcis globaux (elle
//! ne pourrait donc pas écouter le clavier hors de l'app). Elle reçoit seulement `ptt://state` (vrai = enfoncée,
//! faux = relâchée) pour la touche choisie, et choisit cette touche parmi une liste fermée (`ptt_set`).

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct Ptt {
    current: Mutex<Option<Shortcut>>,
}

/// Touches permises seules : F1–F24, Pause, Insert, Scroll Lock. Avec Ctrl/Alt/Shift : aussi lettres, chiffres, espace.
fn allowed(accel: &str) -> bool {
    let parts: Vec<&str> = accel.split('+').map(str::trim).collect();
    let Some((key, mods)) = parts.split_last() else { return false };
    let mods_ok = mods.iter().all(|m| matches!(m.to_ascii_lowercase().as_str(), "ctrl" | "control" | "alt" | "shift"));
    let mut uniq = mods.iter().map(|m| m.to_ascii_lowercase()).collect::<Vec<_>>();
    uniq.sort();
    uniq.dedup();
    if !mods_ok || uniq.len() != mods.len() || mods.len() > 3 {
        return false;
    }
    let k = key.to_ascii_uppercase();
    let function = k.len() >= 2 && k.starts_with('F') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n));
    let special = matches!(k.as_str(), "PAUSE" | "INSERT" | "SCROLLLOCK");
    let simple = k == "SPACE" || (k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()));
    // Alt+F4 ferme les fenêtres : ne jamais le capturer.
    if k == "F4" && uniq.iter().any(|m| m == "alt") {
        return false;
    }
    function || special || (simple && !mods.is_empty())
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            let current = *app.state::<Ptt>().current.lock().unwrap();
            if current.as_ref() == Some(shortcut) {
                let _ = app.emit_to("main", "ptt://state", event.state() == ShortcutState::Pressed);
            }
        })
        .build()
}

/// Change la touche (vide = désactivée). Erreur si elle n'est pas permise ou déjà prise par une autre application.
#[tauri::command]
pub fn ptt_set(app: AppHandle, state: State<'_, Ptt>, accelerator: String) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut current = state.current.lock().unwrap();
    if let Some(old) = current.take() {
        let _ = gs.unregister(old);
    }
    let accel = accelerator.trim();
    if accel.is_empty() {
        return Ok(());
    }
    if !allowed(accel) {
        return Err(format!("touche non permise : {accel} (F1–F24, Pause, Inser, Arrêt défil, ou Ctrl/Alt/Maj + touche)"));
    }
    let shortcut: Shortcut = accel.parse().map_err(|e| format!("touche invalide : {e}"))?;
    gs.register(shortcut).map_err(|e| format!("touche déjà utilisée par une autre application ? ({e})"))?;
    *current = Some(shortcut);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn touches_permises() {
        for ok in ["F9", "f12", "Pause", "Ctrl+Alt+Space", "Ctrl+Shift+M", "Ctrl+F4"] {
            assert!(allowed(ok), "{ok}");
        }
        for ko in ["Alt+F4", "A", "Space", "Enter", "Ctrl+Ctrl+A", "Win+F9", "Ctrl+Alt+Shift+Ctrl+A", "F25", "", "Ctrl+"] {
            assert!(!allowed(ko), "{ko}");
        }
    }
}
