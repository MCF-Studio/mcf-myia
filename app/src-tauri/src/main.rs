// Pas de console en plus de la fenêtre en release (Windows).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    myia_lib::run()
}
