#!/usr/bin/env bash
set -euo pipefail

# Build a single installable .deb, so a change can be tried on a real packaged
# build without pushing a tag and waiting for the whole release workflow — and
# without a broken version ending up on the releases page.
#
# This is the local equivalent of the build-linux job, minus the other bundle
# targets and the GitHub upload.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

TARGET=x86_64-unknown-linux-gnu
BUNDLE_DIR="apps/client/src-tauri/target/$TARGET/release/bundle/deb"

# Same optional .env the release script reads, so the origin can live there
# instead of being retyped on every build.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# The client bakes its server origin in at BUILD time (apps/client/src/api/origin.ts).
# Unset, the app resolves /api against tauri://localhost and reaches nothing —
# with no error on screen. That failure is expensive to diagnose from the
# outside, so refuse to build rather than hand over a package that cannot work.
if [[ -z "${VITE_SERVER_ORIGIN:-}" ]]; then
  cat >&2 <<'EOF'
build:deb failed: VITE_SERVER_ORIGIN is not set.

The packaged client needs to know where the server is, at build time. Set it
for this build:

  VITE_SERVER_ORIGIN=https://your-server.example.com bun run build:deb

or put it in .env, which this script reads:

  VITE_SERVER_ORIGIN=https://your-server.example.com
EOF
  exit 1
fi

case "$VITE_SERVER_ORIGIN" in
  https://* | http://*) ;;
  *)
    printf 'build:deb failed: VITE_SERVER_ORIGIN must include the scheme, got %s\n' \
      "$VITE_SERVER_ORIGIN" >&2
    exit 1
    ;;
esac

printf 'Building a .deb against %s\n' "$VITE_SERVER_ORIGIN"

# --bundles deb keeps this to the one artifact worth installing locally; the
# appimage and rpm targets roughly triple the wall clock for no extra signal.
VITE_SERVER_ORIGIN="$VITE_SERVER_ORIGIN" \
  bun run --cwd apps/client tauri build --target "$TARGET" --bundles deb

DEB=$(ls -t "$BUNDLE_DIR"/*.deb 2>/dev/null | head -1 || true)
if [[ -z "$DEB" ]]; then
  printf 'build:deb failed: the build reported success but no .deb landed in %s\n' \
    "$BUNDLE_DIR" >&2
  exit 1
fi

printf '\nBuilt %s\n\nInstall it with:\n  sudo dpkg -i %s\n' "$DEB" "$DEB"
