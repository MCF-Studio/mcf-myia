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

/// Réglage `claude.bypassPermissions` de config/agent.json (Paramètres → Général). Lu ici, côté Rust, à chaque
/// lancement : un appel venu de l'interface ne peut pas l'imposer pour une console. Absent ou illisible = désactivé.
fn bypass_permissions() -> bool {
    std::fs::read_to_string(crate::sidecar::home().join("config").join("agent.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|cfg| cfg.get("claude")?.get("bypassPermissions")?.as_bool())
        .unwrap_or(false)
}

/// Contexte donné à Claude Code en local : même valeur que CLAUDE_LOCAL_CTX côté cœur (llm.ts).
const LOCAL_CTX: u32 = 32_768;

/// Variante Ollama créée par le cœur pour Claude Code (même calcul que claudeLocalOllamaModel, llm.ts).
fn local_model_name(model: &str) -> String {
    let clean: String = model
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .take(100)
        .collect();
    format!("myia-claude:{clean}")
}

fn valid_model(m: &str, extra: &[char]) -> bool {
    !m.is_empty()
        && m.len() <= 160
        && m.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || extra.contains(&c))
}

/// Variables d'environnement d'une console Claude Code locale, et identifiant du modèle.
type LocalEnv = (Vec<(&'static str, String)>, String);

/// Claude Code sur le modèle local du moteur actif : llama-server et Ollama exposent l'API Messages d'Anthropic.
/// Tout est lu ICI, côté Rust : adresse (toujours la machine elle-même), modèle (celui de la config) et clé (coffre
/// Windows pour llama.cpp). L'interface ne peut donc pas envoyer Claude Code vers un autre serveur.
/// Renvoie les variables d'environnement et l'identifiant du modèle (passé aussi en `--model`).
fn local_claude_env() -> Result<LocalEnv, String> {
    let cfg = std::fs::read_to_string(crate::sidecar::home().join("config").join("agent.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let llm = cfg.get("llm");
    let engine = llm.and_then(|l| l.get("engine")).and_then(|v| v.as_str()).unwrap_or("ollama");
    let model = llm
        .and_then(|l| l.get("model"))
        .and_then(|v| v.as_str())
        .unwrap_or(if engine == "llamacpp" { "Qwen3-8B-Q4_K_M" } else { "qwen3:8b" })
        .to_string();

    let (base, token, id) = if engine == "llamacpp" {
        if !valid_model(&model, &[]) {
            return Err(format!("nom de modèle llama.cpp invalide : {model}"));
        }
        let port = llm.and_then(|l| l.get("llamacpp")?.get("port")?.as_u64()).unwrap_or(11435);
        if !(1024..=65535).contains(&port) {
            return Err("port llama.cpp invalide".into());
        }
        let token = keyring::Entry::new("MyIA", "llamacpp_api_key")
            .and_then(|e| e.get_password())
            .map_err(|_| "clé du serveur llama.cpp introuvable : démarre llama.cpp depuis MyIA une première fois".to_string())?;
        (format!("http://127.0.0.1:{port}"), token, model)
    } else {
        if !valid_model(&model, &[':', '/']) {
            return Err(format!("nom de modèle Ollama invalide : {model}"));
        }
        // Ollama doit rester local (même règle que la config du cœur) : jamais une adresse distante.
        let base = llm
            .and_then(|l| l.get("baseUrl"))
            .and_then(|v| v.as_str())
            .unwrap_or("http://127.0.0.1:11434")
            .trim_end_matches('/')
            .to_string();
        let local = ["http://127.0.0.1:", "http://localhost:"].iter().any(|p| {
            base.strip_prefix(p).is_some_and(|port| !port.is_empty() && port.len() <= 5 && port.chars().all(|c| c.is_ascii_digit()))
        });
        if !local {
            return Err("adresse d'Ollama non locale : refusée pour Claude Code".into());
        }
        // Ollama n'a pas de clé : Claude Code en exige une, n'importe laquelle.
        (base, "ollama".to_string(), local_model_name(&model))
    };
    let vars = vec![
        ("ANTHROPIC_BASE_URL", base),
        ("ANTHROPIC_AUTH_TOKEN", token),
        ("ANTHROPIC_MODEL", id.clone()),
        ("ANTHROPIC_DEFAULT_MODEL", id.clone()),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", id.clone()),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", id.clone()),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", id.clone()),
        ("CLAUDE_CODE_SUBAGENT_MODEL", id.clone()),
        // Vrai contexte du modèle local (Claude Code supposerait 200 k), pas de phase de réflexion.
        ("CLAUDE_CODE_MAX_CONTEXT_TOKENS", LOCAL_CTX.to_string()),
        ("MAX_THINKING_TOKENS", "0".into()),
        // Rien d'autre ne part vers Internet (télémétrie, rapports d'erreur, mises à jour automatiques).
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1".into()),
    ];
    Ok((vars, id))
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
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, Ptys>,
    cwd: String,
    resume: bool,
    cols: u16,
    rows: u16,
    model: Option<String>,
    prompt: Option<String>,
) -> Result<u32, String> {
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
    // Mode sans demande d'autorisation : seulement si l'utilisateur l'a activé dans les réglages.
    if bypass_permissions() {
        cmd.arg("--dangerously-skip-permissions");
    }
    // Modèle : liste fermée d'alias Claude Code (même liste que le cœur, vérifié par claude-coach.test.ts), ou « local » (modèle llama.cpp de MyIA, voir local_claude_env).
    let mut local_env = None;
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        if m == "local" {
            let (vars, id) = local_claude_env()?;
            cmd.arg("--model");
            cmd.arg(id);
            local_env = Some(vars);
        } else {
            if !["haiku", "sonnet", "opus", "fable"].contains(&m.as_str()) {
                return Err(format!("modèle inconnu : {m}"));
            }
            cmd.arg("--model");
            cmd.arg(m);
        }
    }
    // Tâche de départ : un seul argument (pas de shell), une seule ligne, bornée.
    if let Some(p) = prompt.map(|p| p.replace(['\r', '\n'], " ").trim().to_string()).filter(|p| !p.is_empty()) {
        if p.len() > 8000 {
            return Err("tâche trop longue (8000 caractères max)".into());
        }
        if p.starts_with('-') {
            return Err("une tâche ne peut pas commencer par « - »".into());
        }
        cmd.arg(p);
    }
    cmd.cwd(&dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(vars) = local_env {
        // Une clé Anthropic de l'environnement ne doit pas partir vers le serveur local (ni passer avant lui).
        cmd.env_remove("ANTHROPIC_API_KEY");
        for (k, v) in vars {
            cmd.env(k, v);
        }
    }

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
