#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use url::Url;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let command = app
                .shell()
                .sidecar("clone-ai-daemon")
                .map_err(|error| format!("Unable to create the local Clone AI daemon: {error}"))?;
            let (mut events, child) = command
                .spawn()
                .map_err(|error| format!("Unable to start the local Clone AI daemon: {error}"))?;
            let handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                // Keeping the child inside this task ties the daemon lifetime to the desktop shell.
                let _child = child;
                while let Some(event) = events.recv().await {
                    if let CommandEvent::Stdout(bytes) = event {
                        let line = String::from_utf8_lossy(&bytes);
                        if let Some(url) = line.trim().strip_prefix("CLONE_AI_READY ") {
                            if let Ok(url) = Url::parse(url) {
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.navigate(url);
                                }
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("clone-ai desktop shell failed");
}
