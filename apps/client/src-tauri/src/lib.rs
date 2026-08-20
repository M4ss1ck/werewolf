#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  // Must be the FIRST plugin registered. Without it the OS starts a second
  // instance to deliver a werewolf:// deep link and the window the user is
  // looking at never receives the session; with it, the URL is forwarded to the
  // running instance instead. Desktop only — Android delivers links via intents.
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));

  builder
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
