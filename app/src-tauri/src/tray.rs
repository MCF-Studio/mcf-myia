//! Icône de MyIA dans la zone de notification de Windows (près de l'horloge).
//! Clic gauche : ramener la fenêtre au premier plan. Clic droit : menu (ouvrir une vue, quitter).
//! Les vues proposées forment une liste fermée (VIEWS).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};

/// Vues ouvrables depuis le menu (identifiant = celui de l'interface, libellé = texte du menu).
const VIEWS: [(&str, &str); 6] = [
    ("overview", "Vue d'ensemble"),
    ("conversations", "Conversations"),
    ("agents", "Agents"),
    ("teams", "Équipes"),
    ("models", "Modèles"),
    ("settings", "Paramètres"),
];

/// Ramène la fenêtre principale au premier plan (même réduite ou masquée).
pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Affiche une vue dans la fenêtre principale. `view` vient toujours de VIEWS.
fn open_view(app: &AppHandle, view: &'static str) {
    focus_main(app);
    let _ = app.emit("app://navigate", view);
}

pub fn install(app: &App) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Ouvrir MyIA", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, label) in VIEWS {
        menu.append(&MenuItem::with_id(app, format!("view:{id}"), label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quitter MyIA", true, None::<&str>)?)?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("MyIA")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => focus_main(app),
            // Passe par la sortie normale de l'app : consoles et cœur sont arrêtés proprement (lib.rs).
            "quit" => app.exit(0),
            id => {
                let wanted = id.strip_prefix("view:").unwrap_or_default();
                if let Some((view, _)) = VIEWS.iter().find(|(v, _)| *v == wanted) {
                    open_view(app, view);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                focus_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
