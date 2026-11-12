mod metrics;
mod ptt;
mod pty;
mod sidecar;
mod tray;
mod update;

use tauri::Manager;


pub fn run() {
    tauri::Builder::default()
        // Instance unique (doit être le premier plugin) : un second lancement ramène la fenêtre existante.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::focus_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(ptt::plugin())
        .manage(sidecar::Sidecar::default())
        .manage(metrics::Metrics::default())
        .manage(pty::Ptys::default())
        .manage(update::Updates::default())
        .manage(ptt::Ptt::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::sidecar_send,
            sidecar::sidecar_restart,
            sidecar::sidecar_status,
            metrics::system_metrics,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            update::update_status,
            update::update_check,
            ptt::ptt_set,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = app.state::<sidecar::Sidecar>().start(&handle) {
                eprintln!("[myia] sidecar : {e}");
            }
            update::start(&handle);
            if let Err(e) = tray::install(app) {
                eprintln!("[myia] zone de notification : {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erreur au lancement de MyIA")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::Ptys>().kill_all();
                app.state::<sidecar::Sidecar>().stop();
            }
        });
}
