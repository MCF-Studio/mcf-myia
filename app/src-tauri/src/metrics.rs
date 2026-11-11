//! Ressources de la machine pour la vue d'ensemble : CPU, RAM, GPU NVIDIA, processus Ollama et cœur MyIA.

use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{ProcessesToUpdate, System};
use tauri::State;

use crate::sidecar::Sidecar;

pub struct Metrics {
    /// None si sysinfo n'a pas pu s'initialiser : les métriques restent à zéro, l'app continue.
    sys: Mutex<Option<System>>,
    /// None = pas encore testé ; Some(false) = nvidia-smi absent, on n'insiste pas.
    has_nvidia: Mutex<Option<bool>>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self { sys: Mutex::new(System::new().ok()), has_nvidia: Mutex::new(None) }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    name: String,
    utilization: f32,
    memory_used_mb: f32,
    memory_total_mb: f32,
    temperature_c: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    name: String,
    pid: u32,
    cpu: f32,
    memory: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetrics {
    cpu_usage: f32,
    cpu_cores: usize,
    cpu_brand: String,
    memory_used: u64,
    memory_total: u64,
    gpus: Vec<Gpu>,
    processes: Vec<Proc>,
    os: String,
    uptime_secs: u64,
}

fn nvidia() -> Option<Vec<Gpu>> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    Some(
        text.lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split(',').map(str::trim).collect();
                if f.len() < 5 {
                    return None;
                }
                Some(Gpu {
                    name: f[0].to_string(),
                    utilization: f[1].parse().unwrap_or(0.0),
                    memory_used_mb: f[2].parse().unwrap_or(0.0),
                    memory_total_mb: f[3].parse().unwrap_or(0.0),
                    temperature_c: f[4].parse().ok(),
                })
            })
            .collect(),
    )
}

#[tauri::command]
pub fn system_metrics(state: State<'_, Metrics>, sidecar: State<'_, Sidecar>) -> SystemMetrics {
    let sidecar_pid = sidecar.pid();
    let mut guard = state.sys.lock().unwrap();
    let Some(sys) = guard.as_mut() else {
        return SystemMetrics {
            cpu_usage: 0.0,
            cpu_cores: 0,
            cpu_brand: String::new(),
            memory_used: 0,
            memory_total: 0,
            gpus: Vec::new(),
            processes: Vec::new(),
            os: String::new(),
            uptime_secs: 0,
        };
    };
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut processes: Vec<Proc> = sys
        .processes()
        .iter()
        .filter_map(|(pid, p)| {
            let name = p.name().to_string_lossy().to_string();
            // Moteurs locaux : Ollama, ou llama.cpp direct (llama-server, routeur et ses processus de modèle).
            let lower = name.to_lowercase();
            let is_ollama = lower.starts_with("ollama") || lower.starts_with("llama-server");
            let is_sidecar = Some(pid.as_u32()) == sidecar_pid;
            if !is_ollama && !is_sidecar {
                return None;
            }
            Some(Proc {
                name: if is_sidecar { "MyIA (cœur)".into() } else { name },
                pid: pid.as_u32(),
                cpu: p.cpu_usage(),
                memory: p.memory(),
            })
        })
        .collect();
    processes.sort_by_key(|p| std::cmp::Reverse(p.memory));

    let cpu_brand = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let cpu_usage = sys.global_cpu_usage();
    let cpu_cores = sys.cpus().len();
    let memory_used = sys.used_memory();
    let memory_total = sys.total_memory();
    drop(guard);

    let mut has = state.has_nvidia.lock().unwrap();
    let gpus = if *has == Some(false) { None } else { nvidia() };
    if has.is_none() {
        *has = Some(gpus.is_some());
    }

    SystemMetrics {
        cpu_usage,
        cpu_cores,
        cpu_brand,
        memory_used,
        memory_total,
        gpus: gpus.unwrap_or_default(),
        processes,
        os: System::long_os_version().unwrap_or_default(),
        uptime_secs: System::uptime().unwrap_or(0),
    }
}
