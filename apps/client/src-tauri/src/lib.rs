// The desktop sign-in handoff. Mobile keeps the deep-link path: an intent is
// the platform norm on Android, and loopback is the option Google is
// deprecating for mobile client types.
#[cfg(desktop)]
mod auth_listener;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  // Must be the FIRST plugin registered. Without it the OS starts a second
  // instance to deliver a werewolf:// deep link and the window the user is
  // looking at never receives the session; with it, the URL is forwarded to the
  // running instance instead. Desktop only — Android delivers links via intents.
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    use tauri::Manager;
    // The `deep-link` feature has already handed the URL to the deep-link
    // plugin by the time this runs, so sign-in completes on its own. What is
    // left is to raise the window: the click that delivered the link happened
    // in the user's browser, so without this the app signs in *behind* the
    // browser and the user sees nothing happen at all.
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.set_focus();
    }
  }));

  #[cfg(desktop)]
  let builder =
    builder.invoke_handler(tauri::generate_handler![auth_listener::start_auth_handoff]);

  builder
    // Google refuses OAuth inside an embedded webview, so sign-in opens the
    // system browser (opener) and the server deep-links the result back into
    // the app (deep-link). See apps/server/src/routes/auth-handoff.ts.
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_deep_link::init())
    .setup(|app| {
      // Unconditional, including release. A packaged artifact is the only build
      // where the browser-to-app handoff can fail, so gating this on
      // debug_assertions left exactly the failing case with no logs at all.
      // Writes to stdout and the OS log directory; never to the webview.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;

      // Desktop Linux and Windows only resolve werewolf:// once the binary is
      // registered as its handler. Doing it at runtime keeps a dev build
      // working without installing a .desktop entry by hand; on a packaged
      // install the bundle already declares it.
      #[cfg(any(windows, target_os = "linux"))]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(error) = app.deep_link().register_all() {
          // Not fatal: a packaged install already declares the scheme. But a
          // silent failure here means werewolf:// resolves to nothing and
          // sign-in hangs with no way to tell why, so say so.
          log::warn!("could not register the werewolf:// scheme: {error}");
        }
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
