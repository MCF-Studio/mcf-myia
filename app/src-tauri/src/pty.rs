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

/// Espaces de travail des agents (config/agents.json) ou des équipes (config/teams.json) : champ `workspace` de
/// chaque entrée de la liste `key`. Écrits par le cœur après contrôle (access.ts → checkWorkspace).
fn workspaces_of(file: &Path, key: &str) -> Vec<PathBuf> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get(key)?.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.get("workspace")?.as_str().map(PathBuf::from))
        .collect()
}

/// Dossiers où une console peut s'ouvrir : workspace, `projectRoots` et `projects` de config/agent.json, et les
/// espaces de travail des agents et des équipes.
/// Lu ici, côté Rust : l'interface ne peut pas imposer un dossier arbitraire.
fn allowed_roots() -> Vec<PathBuf> {
    let home = crate::sidecar::home();
    let mut roots = vec![home.join("workspace")];
    roots.extend(workspaces_of(&home.join("config").join("agents.json"), "agents"));
    roots.extend(workspaces_of(&home.join("config").join("teams.json"), "teams"));
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

/// Section `claude` de config/agent.json (absente ou illisible = valeurs par défaut).
fn claude_cfg() -> serde_json::Value {
    std::fs::read_to_string(crate::sidecar::home().join("config").join("agent.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|cfg| cfg.get("claude").cloned())
        .unwrap_or(serde_json::Value::Null)
}

/// Modèle des sous-agents (`claude.subagentModel`) : liste fermée, sinon celui de la console.
fn subagent_model(claude: &serde_json::Value) -> Option<&'static str> {
    match claude.get("subagentModel").and_then(|v| v.as_str()) {
        Some("haiku") => Some("haiku"),
        Some("sonnet") => Some("sonnet"),
        Some("opus") => Some("opus"),
        _ => None,
    }
}

/// Serveurs MCP des consoles (`claude.consoleMcp`).
#[derive(Debug, PartialEq)]
enum McpMode {
    /// Comportement de Claude Code : tous les serveurs configurés.
    All,
    None,
    Only(Vec<String>),
}

fn valid_server_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn mcp_mode(claude: &serde_json::Value) -> McpMode {
    let m = claude.get("consoleMcp");
    match m.and_then(|m| m.get("mode")).and_then(|v| v.as_str()) {
        Some("none") => McpMode::None,
        Some("only") => McpMode::Only(
            m.and_then(|m| m.get("servers"))
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).filter(|n| valid_server_name(n)).map(String::from).take(50).collect())
                .unwrap_or_default(),
        ),
        _ => McpMode::All,
    }
}

/// Forme comparable d'un chemin de dossier (~/.claude.json range les projets en « G:/Projet »).
fn path_key(p: &str) -> String {
    p.trim_start_matches(r"\\?\").replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Serveurs gardés pour une console ouverte dans `cwd` : portée utilisateur, puis portée locale de ce dossier (qui
/// l'emporte, comme dans Claude Code). Jamais le .mcp.json du dépôt : ces serveurs-là demandent l'accord de
/// l'utilisateur dans Claude Code, une configuration passée en --mcp-config contournerait cet accord.
fn mcp_servers_for(claude_json: &serde_json::Value, cwd: &str, keep: &[String]) -> serde_json::Map<String, serde_json::Value> {
    let mut out = serde_json::Map::new();
    let mut take = |servers: Option<&serde_json::Value>| {
        if let Some(map) = servers.and_then(|v| v.as_object()) {
            for (name, def) in map {
                if keep.iter().any(|k| k == name) && def.is_object() {
                    out.insert(name.clone(), def.clone());
                }
            }
        }
    };
    take(claude_json.get("mcpServers"));
    let want = path_key(cwd);
    if let Some(projects) = claude_json.get("projects").and_then(|v| v.as_object()) {
        for (dir, p) in projects {
            if path_key(dir) == want {
                take(p.get("mcpServers"));
            }
        }
    }
    out
}

/// Dossier des configurations MCP propres à chaque console (supprimées à sa fermeture).
fn mcp_dir() -> PathBuf {
    crate::sidecar::home().join("data").join("claude-mcp")
}

/// Fichier --mcp-config d'une console : aucun serveur, ou les serveurs choisis. Il peut contenir les variables
/// d'environnement des serveurs (souvent des jetons) : même dossier utilisateur que ~/.claude.json, et supprimé dès
/// que la console se ferme ; les restes d'une app coupée net sont effacés à la première console suivante.
fn write_mcp_config(id: u32, cwd: &str, mode: &McpMode) -> Result<Option<PathBuf>, String> {
    static CLEAN: std::sync::Once = std::sync::Once::new();
    let dir = mcp_dir();
    CLEAN.call_once(|| {
        let _ = std::fs::remove_dir_all(&dir);
    });
    let servers = match mode {
        McpMode::All => return Ok(None),
        McpMode::None => serde_json::Map::new(),
        McpMode::Only(keep) => {
            let home = std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
                .ok_or("dossier utilisateur introuvable")?;
            let raw = std::fs::read_to_string(home.join(".claude.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .unwrap_or(serde_json::Value::Null);
            mcp_servers_for(&raw, cwd, keep)
        }
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("configuration MCP : {e}"))?;
    let file = dir.join(format!("console-{id}.json"));
    let body = serde_json::json!({ "mcpServers": servers }).to_string();
    std::fs::write(&file, body).map_err(|e| format!("configuration MCP : {e}"))?;
    Ok(Some(file))
}

/// Autres IA de code en console, en liste FERMÉE : identifiant, programme, option qui passe une tâche de départ
/// (None = argument positionnel). Chacune garde sa propre connexion et ses propres règles d'autorisation.
const OTHER_CLIS: &[(&str, &str, Option<&str>, &str)] = &[
    ("codex", "codex", None, "OpenAI Codex CLI (npm i -g @openai/codex)"),
    ("gemini", "gemini", Some("--prompt-interactive"), "Gemini CLI (npm i -g @google/gemini-cli)"),
    ("opencode", "opencode", Some("--prompt"), "opencode (npm i -g opencode-ai)"),
    ("qwen", "qwen", Some("--prompt-interactive"), "Qwen Code (npm i -g @qwen-code/qwen-code)"),
];

/// Cherche un programme dans le PATH : .exe d'abord, puis .cmd (scripts installés par npm).
fn find_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in ["exe", "cmd"] {
            let f = dir.join(format!("{name}.{ext}"));
            if f.is_file() {
                return Some(f);
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct CliInfo {
    id: &'static str,
    label: &'static str,
    installed: bool,
}

/// Consoles d'IA disponibles sur ce PC (Claude Code compris).
#[tauri::command]
pub fn pty_clis() -> Vec<CliInfo> {
    let mut out = vec![CliInfo { id: "claude", label: "Claude Code", installed: find_program("claude").is_some() }];
    for (id, program, _, label) in OTHER_CLIS {
        out.push(CliInfo { id, label, installed: find_program(program).is_some() });
    }
    out
}

fn other_cli_command(id: &str, prompt: Option<&str>) -> Result<CommandBuilder, String> {
    let (_, program, prompt_flag, label) = OTHER_CLIS.iter().find(|c| c.0 == id).ok_or_else(|| format!("console inconnue : {id}"))?;
    let path = find_program(program).ok_or_else(|| format!("{label} n'est pas installé (ou pas dans le PATH)"))?;
    let is_cmd = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    let mut cmd = if is_cmd {
        // Un .cmd passe par cmd.exe, qui réinterprète la ligne : aucun texte libre ne doit l'accompagner.
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/d", "/c"]);
        c.arg(path.as_os_str());
        c
    } else {
        CommandBuilder::new(path.as_os_str())
    };
    if let Some(p) = prompt.map(|p| p.replace(['\r', '\n'], " ").trim().to_string()).filter(|p| !p.is_empty()) {
        if is_cmd {
            return Err(format!("{label} : la tâche de départ n'est pas prise en charge pour cette installation, tape-la dans la console"));
        }
        if p.len() > 8000 || p.starts_with('-') {
            return Err("tâche refusée (8000 caractères max, ne commence pas par « - »)".into());
        }
        if let Some(flag) = prompt_flag {
            cmd.arg(flag);
        }
        cmd.arg(p);
    }
    Ok(cmd)
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
    // Champ vide = valeur par défaut (config/agent.json liste toutes les options, vides tant qu'elles ne sont pas remplies).
    let engine = llm.and_then(|l| l.get("engine")).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("ollama");
    let model = llm
        .and_then(|l| l.get("model"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
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
            .filter(|s| !s.is_empty())
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

/// Fenêtre de regroupement de la sortie : Claude Code redessine son écran par petits morceaux (animation, sous-agents,
/// barre d'état). Un événement par lecture saturait l'interface dès plusieurs consoles ouvertes ; on envoie au plus un
/// bloc toutes les FLUSH_MS (ou dès FLUSH_BYTES), ce qui reste invisible à l'œil.
const FLUSH_MS: u64 = 12;
const FLUSH_BYTES: usize = 256 * 1024;

/// Regroupe les blocs reçus de `rx` et les passe à `send` en texte UTF-8, sans jamais couper un caractère en deux.
/// Se termine (après avoir tout envoyé) quand le lecteur s'arrête.
fn pump_output(rx: std::sync::mpsc::Receiver<Vec<u8>>, mut send: impl FnMut(String)) {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::{Duration, Instant};
    let mut pending: Vec<u8> = Vec::new();
    let mut open = true;
    while open {
        // Attente du premier bloc, sans limite : une console inactive ne coûte rien.
        match rx.recv() {
            Ok(b) => pending.extend_from_slice(&b),
            Err(_) => break,
        }
        let deadline = Instant::now() + Duration::from_millis(FLUSH_MS);
        while pending.len() < FLUSH_BYTES {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(left) {
                Ok(b) => pending.extend_from_slice(&b),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    open = false;
                    break;
                }
            }
        }
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            // Caractère incomplet en fin de bloc : on le garde pour le bloc suivant.
            Err(e) if e.error_len().is_none() && open => e.valid_up_to(),
            Err(_) => pending.len(), // octets réellement invalides : remplacés
        };
        if valid > 0 {
            let chunk: Vec<u8> = pending.drain(..valid).collect();
            send(String::from_utf8_lossy(&chunk).into_owned());
        }
    }
    if !pending.is_empty() {
        send(String::from_utf8_lossy(&pending).into_owned());
    }
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
    cli: Option<String>,
) -> Result<u32, String> {
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("dossier introuvable : {cwd}"));
    }
    if !is_allowed(&dir) {
        return Err("dossier non autorisé : seuls le workspace, les projets de la configuration et les espaces de travail des agents sont acceptés".into());
    }
    let pair = native_pty_system().openpty(clamp_size(cols, rows)).map_err(|e| format!("pty : {e}"))?;

    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    // Autre IA (Codex, Gemini CLI, opencode, Qwen Code) : son programme, sans les options propres à Claude Code.
    let other = cli.as_deref().filter(|c| *c != "claude");
    let (cmd, mcp_file) = if let Some(c) = other {
        let mut cmd = other_cli_command(c, prompt.as_deref())?;
        cmd.cwd(&dir);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        (cmd, None)
    } else {
        let claude = claude_cfg();
        let mcp_file = write_mcp_config(id, &cwd, &mcp_mode(&claude))?;
        let program = std::env::var("MYIA_CLAUDE").unwrap_or_else(|_| "claude".into());
        let mut cmd = CommandBuilder::new(program);
        if resume {
            cmd.arg("--continue");
        }
        // Serveurs MCP choisis dans les réglages : seuls ceux du fichier (chemin géré par l'app, jamais par l'interface).
        if let Some(f) = &mcp_file {
            // Forme « = » : --mcp-config prend plusieurs valeurs, la tâche de départ serait sinon lue comme un fichier.
            let mut opt = std::ffi::OsString::from("--mcp-config=");
            opt.push(f.as_os_str());
            cmd.arg("--strict-mcp-config");
            cmd.arg(opt);
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
        // Sous-agents sur un modèle plus léger (réglage) ; en local, local_claude_env fixe déjà le modèle local.
        if local_env.is_none() {
            if let Some(m) = subagent_model(&claude) {
                cmd.env("CLAUDE_CODE_SUBAGENT_MODEL", m);
            }
        }
        if let Some(vars) = local_env {
            // Une clé Anthropic de l'environnement ne doit pas partir vers le serveur local (ni passer avant lui).
            cmd.env_remove("ANTHROPIC_API_KEY");
            for (k, v) in vars {
                cmd.env(k, v);
            }
        }
        (cmd, mcp_file)
    };

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        if let Some(f) = &mcp_file {
            let _ = std::fs::remove_file(f);
        }
        format!("impossible de lancer Claude Code ({e}). La commande `claude` doit être installée et dans le PATH.")
    })?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    state.sessions.lock().unwrap().insert(id, Session { writer, master: pair.master, child });

    // Lecture : un fil lit le pseudo-terminal, un autre regroupe la sortie et l'envoie à l'interface (voir pump_output).
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let h = app.clone();
    std::thread::spawn(move || pump_output(rx, |data| {
        let _ = h.emit("pty://data", DataEvent { id, data });
    }));

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
        if let Some(f) = &mcp_file {
            let _ = std::fs::remove_file(f);
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn pump(chunks: Vec<Vec<u8>>) -> Vec<String> {
        let (tx, rx) = mpsc::channel();
        for c in chunks {
            tx.send(c).unwrap();
        }
        drop(tx);
        let mut out = Vec::new();
        pump_output(rx, |s| out.push(s));
        out
    }

    #[test]
    fn regroupe_les_petits_blocs() {
        let out = pump((0..100).map(|i| format!("{i};").into_bytes()).collect());
        assert_eq!(out.len(), 1, "tous les blocs déjà arrivés partent en un seul envoi");
        assert!(out[0].starts_with("0;1;2;") && out[0].ends_with("99;"));
    }

    #[test]
    fn ne_coupe_pas_un_caractere() {
        let e = "é".as_bytes().to_vec();
        let (tx, rx) = mpsc::channel();
        let h = std::thread::spawn(move || {
            let mut out = Vec::new();
            pump_output(rx, |s| out.push(s));
            out
        });
        tx.send([b"a".as_slice(), &e[..1]].concat()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(40));
        tx.send(e[1..].to_vec()).unwrap();
        drop(tx);
        let out = h.join().unwrap();
        assert_eq!(out.concat(), "aé");
        assert!(out.iter().all(|s| !s.contains('\u{FFFD}')));
    }

    #[test]
    fn mode_mcp() {
        use serde_json::json;
        assert_eq!(mcp_mode(&json!(null)), McpMode::All);
        assert_eq!(mcp_mode(&json!({ "consoleMcp": { "mode": "none" } })), McpMode::None);
        assert_eq!(
            mcp_mode(&json!({ "consoleMcp": { "mode": "only", "servers": ["blender", "a b", "x"] } })),
            McpMode::Only(vec!["blender".into(), "x".into()])
        );
        assert_eq!(subagent_model(&json!({ "subagentModel": "haiku" })), Some("haiku"));
        assert_eq!(subagent_model(&json!({ "subagentModel": "gpt" })), None);
    }

    #[test]
    fn serveurs_gardes() {
        use serde_json::json;
        let cfg = json!({
            "mcpServers": { "blender": { "command": "uvx" }, "playwright": { "command": "npx" } },
            "projects": {
                "G:/Jeu": { "mcpServers": { "godot": { "command": "g" }, "blender": { "command": "local" } } },
                "G:/Autre": { "mcpServers": { "secret": { "command": "s" } } }
            }
        });
        let keep = vec!["blender".to_string(), "godot".to_string(), "secret".to_string()];
        let out = mcp_servers_for(&cfg, r"G:\Jeu\", &keep);
        assert_eq!(out.len(), 2);
        assert_eq!(out["blender"]["command"], "local", "la portée locale l'emporte");
        assert!(out.contains_key("godot"));
        assert!(!out.contains_key("playwright"), "non choisi");
        assert!(!out.contains_key("secret"), "déclaré pour un autre dossier");
        assert_eq!(path_key(r"\\?\G:\Jeu"), "g:/jeu");
    }
}
