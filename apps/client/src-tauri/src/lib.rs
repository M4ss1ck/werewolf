#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Google refuses OAuth inside an embedded webview, so sign-in opens the
    // system browser (opener) and the server deep-links the result back into
    // the app (deep-link). See apps/server/src/routes/auth-handoff.ts.
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_deep_link::init())
    .setup(|app| {
      // Desktop Linux and Windows only resolve werewolf:// once the binary is
      // registered as its handler. Doing it at runtime keeps a dev build
      // working without installing a .desktop entry by hand; on a packaged
      // install the bundle already declares it.
      #[cfg(any(windows, target_os = "linux"))]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        let _ = app.deep_link().register_all();
      }

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
