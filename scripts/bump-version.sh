#!/bin/bash

# Bump the version across every version file.
# Usage: ./scripts/bump-version.sh [version]
# With no argument, increments the patch of the current root package.json version.
#
# The root package.json is the single source of truth. The other three files are
# kept in sync so a Tauri build never rewrites Cargo.lock mid-CI:
#   - package.json                                  (root, the source of truth)
#   - apps/client/src-tauri/tauri.conf.json
#   - apps/client/src-tauri/Cargo.toml              (the [package] version key)
#   - apps/client/src-tauri/Cargo.lock              (only the [[package]] entry
#                                                    whose name is "app")
# Workspace members (apps/client/package.json, packages/*/package.json) are
# private and unpublished; they stay at 0.0.0 and are never touched.

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

# package.json — the source of truth.
sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" package.json
echo "Updated package.json"

# apps/client/src-tauri/tauri.conf.json
sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" apps/client/src-tauri/tauri.conf.json
echo "Updated apps/client/src-tauri/tauri.conf.json"

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

echo "Version bumped to $NEW_VERSION"