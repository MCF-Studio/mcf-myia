//! Export d'un fichier texte (thème, agent, workflow) par une fenêtre « Enregistrer sous ».
//!
//! Un lien de téléchargement dans la page ne suffit pas : la WebView n'affiche aucune fenêtre et le fichier n'arrive
//! nulle part. C'est donc ce côté qui ouvre la fenêtre et écrit. La page fournit un nom proposé et le texte ; le
//! chemin, lui, n'est choisi que par l'utilisateur dans la fenêtre du système : la page ne peut pas écrire ailleurs.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Plafond du texte exporté (un workflow avec ses scripts et ses fiches reste très en dessous).
const MAX_BYTES: usize = 32 * 1024 * 1024;

/// Nom proposé dans la fenêtre : un nom de fichier simple, sans dossier ni caractère interdit par Windows.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "export.json".into()
    } else {
        cleaned.chars().take(120).collect()
    }
}

/// Ouvre « Enregistrer sous » et écrit le texte. Rend le chemin écrit, ou `None` si l'utilisateur a annulé.
#[tauri::command]
pub async fn export_text(app: AppHandle, filename: String, text: String) -> Result<Option<String>, String> {
    if text.len() > MAX_BYTES {
        return Err("fichier trop volumineux pour être exporté".into());
    }
    let name = safe_name(&filename);
    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Some(ext) = name.rsplit_once('.').map(|(_, e)| e.to_string()) {
        dialog = dialog.add_filter(format!("Fichier .{ext}"), &[ext.as_str()]);
    }
    if let Some(dir) = dirs_download(&app) {
        dialog = dialog.set_directory(dir);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| format!("chemin invalide : {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("écriture impossible : {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Dossier Téléchargements de l'utilisateur, proposé par défaut.
fn dirs_download(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().download_dir().ok().filter(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn nom_simple_conserve() {
        assert_eq!(safe_name("mon-theme.theme.json"), "mon-theme.theme.json");
    }

    #[test]
    fn dossiers_et_caracteres_interdits_retires() {
        assert_eq!(safe_name("..\\..\\a:b?.json"), "-..-a-b-.json");
        assert_eq!(safe_name("   "), "export.json");
        assert_eq!(safe_name("..."), "export.json");
    }
}
