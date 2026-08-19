#!/bin/bash

# Bump the version across every version file.
# Usage: ./scripts/bump-version.sh [version]
# With no argument, increments the patch of the current root package.json version.
#
# The root package.json is the single source of truth. Everything else is kept
# in sync with it:
#   - package.json                                  (root, the source of truth)
#   - apps/client/src-tauri/tauri.conf.json
#   - apps/client/src-tauri/Cargo.toml              (the [package] version key)
#   - apps/client/src-tauri/Cargo.lock              (only the [[package]] entry
#                                                    whose name is "app")
#   - every workspace member's package.json         (apps/*, packages/*)
#
# Cargo.lock matters because a version disagreeing with Cargo.toml makes the
# next cargo build rewrite it and dirty the tree mid-CI. The workspace members
# are private and unpublished, so their version changes nothing at build time;
# they are bumped so one release is one version across the repo rather than a
# release number on the client and a permanent 0.0.0 on the engine that built
# it.

set -e

# Resolve repo root so the script works from any directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CURRENT_VERSION="$(grep -Po '"version"\s*:\s*"\K[0-9]+\.[0-9]+\.[0-9]+' package.json | head -1)"

if [ -z "$CURRENT_VERSION" ]; then
    echo "Error: could not read the current version from package.json"
    exit 1
fi

echo "Current version: $CURRENT_VERSION"

if [ -n "$1" ]; then
    NEW_VERSION="$1"
else
    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
    NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
fi

echo "New version: $NEW_VERSION"

# Rewrite only the FIRST "version" key in a JSON file. A manifest's own version
# is the first one by convention; a dependency named "version" further down must
# not be caught by a bare global substitution.
set_json_version() {
    sed -i "0,/\"version\": \".*\"/s//\"version\": \"$NEW_VERSION\"/" "$1"
    echo "Updated $1"
}

# package.json — the source of truth.
set_json_version package.json

# apps/client/src-tauri/tauri.conf.json
set_json_version apps/client/src-tauri/tauri.conf.json

# apps/client/src-tauri/Cargo.toml — the [package] version key.
sed -i "s/^version = \".*\"/version = \"$NEW_VERSION\"/" apps/client/src-tauri/Cargo.toml
echo "Updated apps/client/src-tauri/Cargo.toml"

# apps/client/src-tauri/Cargo.lock — only the [[package]] entry named "app".
awk -v new_version="$NEW_VERSION" '
    /^\[\[package\]\]/ { in_package = 1; is_app = 0 }
    in_package && /^name = "app"$/ { is_app = 1 }
    in_package && is_app && /^version = / {
        sub(/version = ".*"/, "version = \"" new_version "\"")
        in_package = 0
    }
    { print }
' apps/client/src-tauri/Cargo.lock > apps/client/src-tauri/Cargo.lock.tmp
mv apps/client/src-tauri/Cargo.lock.tmp apps/client/src-tauri/Cargo.lock
echo "Updated apps/client/src-tauri/Cargo.lock"

# Every workspace member, so one release is one version across the repo. Globbed
# rather than listed so a new workspace is picked up without editing this script.
for manifest in apps/*/package.json packages/*/package.json; do
    [ -f "$manifest" ] || continue
    set_json_version "$manifest"
done

echo "Version bumped to $NEW_VERSION"