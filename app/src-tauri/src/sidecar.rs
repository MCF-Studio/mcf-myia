//! Sidecar Node (agent/dist/server/main.js) : le cœur de MyIA, en JSON-RPC sur stdio.
//! Rust ne fait que relayer les lignes : la validation des requêtes est faite par le sidecar.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
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

/// Dossier racine de MyIA (contient agent/, config/, data/).
/// MYIA_HOME en priorité ; sinon, en build debug, la racine du dépôt ; sinon le dossier de l'exécutable.
pub fn home() -> PathBuf {
    if let Ok(h) = std::env::var("MYIA_HOME") {
        return PathBuf::from(h);
    }
    // Racine du dépôt : en développement SEULEMENT (une release ne charge jamais de code depuis un chemin de build).
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        if dev.join("agent").exists() {
            return dev.canonicalize().unwrap_or(dev);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// canonicalize() renvoie des chemins \\?\C:\… sous Windows : Node les accepte mal.
fn plain(p: &Path) -> String {
    let s = p.display().to_string();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

impl Sidecar {
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let home = home();
        let script = home.join("agent").join("dist").join("server").join("main.js");
        if !script.exists() {
            let msg = format!("{} introuvable : lance « npm run build » dans agent/", plain(&script));
            *self.last_error.lock().unwrap() = Some(msg.clone());
            return Err(msg);
        }
        let node = std::env::var("MYIA_NODE").unwrap_or_else(|_| "node".into());
        let mut cmd = Command::new(node);
        cmd.arg(plain(&script))
            .current_dir(plain(&home))
            .env("MYIA_HOME", plain(&home))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            let msg = format!("impossible de lancer Node ({e}). Node 22+ doit être dans le PATH, ou MYIA_NODE défini.");
            *self.last_error.lock().unwrap() = Some(msg.clone());
            msg
        })?;

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
