//! Consoles intégrées : Claude Code (`claude`) dans un pseudo-terminal (ConPTY sous Windows).
//! Seule la commande `claude` peut être lancée (pas de shell libre) ; le dossier de travail doit exister.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    sessions: Mutex<HashMap<u32, Session>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
struct DataEvent {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    id: u32,
    code: Option<u32>,
}

impl Ptys {
    pub fn kill_all(&self) {
        let mut map = self.sessions.lock().unwrap();
        for (_, mut s) in map.drain() {
            let _ = s.child.kill();
        }
    }
}

/// Dossiers où une console peut s'ouvrir : workspace, `projectRoots` et `projects` de config/agent.json.
/// Lu ici, côté Rust : l'interface ne peut pas imposer un dossier arbitraire.
fn allowed_roots() -> Vec<PathBuf> {
    let home = crate::sidecar::home();
    let mut roots = vec![home.join("workspace")];
    let cfg = std::fs::read_to_string(home.join("config").join("agent.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Some(cfg) = cfg {
        if let Some(arr) = cfg.get("projectRoots").and_then(|v| v.as_array()) {
            roots.extend(arr.iter().filter_map(|r| r.get("path")?.as_str().map(PathBuf::from)));
        }
        if let Some(map) = cfg.get("projects").and_then(|v| v.as_object()) {
            roots.extend(map.values().filter_map(|p| p.get("path")?.as_str().map(PathBuf::from)));
        }
    }
    roots.into_iter().filter_map(|r| r.canonicalize().ok()).collect()
}

fn is_allowed(dir: &Path) -> bool {
    match dir.canonicalize() {
        Ok(d) => allowed_roots().iter().any(|r| d.starts_with(r)),
        Err(_) => false,
    }
}

fn clamp_size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.clamp(20, 500), rows: rows.clamp(5, 300), pixel_width: 0, pixel_height: 0 }
}

/// Lance Claude Code dans `cwd`. `resume` = reprendre la dernière session de ce dossier (`claude --continue`).
#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<'_, Ptys>, cwd: String, resume: bool, cols: u16, rows: u16) -> Result<u32, String> {
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("dossier introuvable : {cwd}"));
    }
    if !is_allowed(&dir) {
        return Err("dossier non autorisé : seuls le workspace et les projets de la configuration sont acceptés".into());
    }
    let pair = native_pty_system().openpty(clamp_size(cols, rows)).map_err(|e| format!("pty : {e}"))?;

    let program = std::env::var("MYIA_CLAUDE").unwrap_or_else(|_| "claude".into());
    let mut cmd = CommandBuilder::new(program);
    if resume {
        cmd.arg("--continue");
    }
    cmd.cwd(&dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("impossible de lancer Claude Code ({e}). La commande `claude` doit être installée et dans le PATH."))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    state.sessions.lock().unwrap().insert(id, Session { writer, master: pair.master, child });

    // Lecture : on renvoie du texte UTF-8 sans couper un caractère en deux entre deux blocs.
    let h = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(), // octets réellement invalides : on remplace
                    };
                    if valid == 0 {
                        continue;
                    }
                    let chunk: Vec<u8> = pending.drain(..valid).collect();
                    let data = String::from_utf8_lossy(&chunk).into_owned();
                    let _ = h.emit("pty://data", DataEvent { id, data });
                }
            }
        }
    });

    // Surveillance : avec ConPTY, la lecture peut rester bloquée après la fin de `claude`. On détecte la sortie
    // ici, puis on retire la session : fermer le pseudo-terminal débloque le lecteur.
    let h = app.clone();
    std::thread::spawn(move || {
        let code = loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let ptys = h.state::<Ptys>();
            let mut map = ptys.sessions.lock().unwrap();
            match map.get_mut(&id) {
                None => break None, // tuée par pty_kill
                Some(s) => {
                    if let Ok(Some(st)) = s.child.try_wait() {
                        map.remove(&id);
                        break Some(st.exit_code());
                    }
                }
            }
        };
        let _ = h.emit("pty://exit", ExitEvent { id, code });
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("saisie trop longue".into());
    }
    let mut map = state.sessions.lock().unwrap();
    let s = map.get_mut(&id).ok_or("console fermée")?;
    s.writer.write_all(data.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    let s = map.get(&id).ok_or("console fermée")?;
    s.master.resize(clamp_size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Ptys>, id: u32) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}
