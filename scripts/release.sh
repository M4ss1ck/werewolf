#!/bin/bash

# Release script for Werewolf
#
# Usage:
#   ./scripts/release.sh <version> [--dry-run]
#
# What it does:
#   1. Loads optional config from .env (AI changelog settings).
#   2. Ensures you are on a release/v<version> branch (creates it if needed).
#   3. Bumps the version across package.json, Cargo.toml, Cargo.lock and tauri.conf.json.
#   4. Generates a CHANGELOG.md section for commits since the last tag
#      (AI-assisted if configured, otherwise a grouped commit list).
#   5. Commits the bump + changelog, creates an annotated tag, and pushes
#      the release branch and the tag.
#
# AI changelog is fully optional: with no .env config it falls back to a
# plain grouped commit list and never errors out.
#
# This repo currently has no git remote, so the push step is skipped with a
# warning when `git remote` is empty; the local commit and tag stay intact.
#
# See .env.example and the "Releasing" section of README.md for details.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status()  { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# Resolve repo root so the script works from any directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Load optional config from .env (used for AI changelog settings).
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

# --- Parse arguments -------------------------------------------------------
VERSION=""
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        -h|--help)
            echo "Usage: $0 <version> [--dry-run]"
            echo "Example: $0 0.1.1"
            echo "         $0 0.1.1 --dry-run"
            exit 0
            ;;
        -*)
            print_error "Unknown option: $arg"
            exit 1
            ;;
        *)
            if [ -z "$VERSION" ]; then
                VERSION="$arg"
            else
                print_error "Unexpected argument: $arg"
                exit 1
            fi
            ;;
    esac
done

if [ -z "$VERSION" ]; then
    print_error "Please provide a version number"
    echo "Usage: $0 <version> [--dry-run]"
    echo "Example: $0 0.1.1"
    exit 1
fi

if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    print_error "Invalid version format. Please use semantic versioning (e.g., 1.0.0)"
    exit 1
fi

if ! git rev-parse --git-dir > /dev/null 2>&1; then
    print_error "Not in a git repository"
    exit 1
fi

RELEASE_BRANCH="release/v$VERSION"
TAG="v$VERSION"

if [ "$DRY_RUN" = true ]; then
    print_warning "Running in --dry-run mode: no files, commits, tags or pushes will be made."
fi

# --- Changelog generation --------------------------------------------------
#
# Collects commits since the last tag and turns them into a markdown changelog
# section. When CHANGELOG_AI_MODEL and BOT_AI_API_KEY are both set the section
# is written by an AI model through the existing bot provider; otherwise (or on
# any failure) it falls back to a grouped commit list.

# Group raw commits by Conventional Commit prefix. Used as the AI input and as
# the no-AI fallback output.
generate_fallback_changelog() {
    local range="$1"
    local added="" changed="" fixed="" other=""
    local line type subject

    while IFS= read -r line; do
        [ -z "$line" ] && continue
        # Strip an optional "type(scope): " or "type: " prefix.
        if [[ "$line" =~ ^([a-z]+)(\([^\)]*\))?!?:\ (.*)$ ]]; then
            type="${BASH_REMATCH[1]}"
            subject="${BASH_REMATCH[3]}"
        else
            type="other"
            subject="$line"
        fi
        case "$type" in
            feat)            added+="- ${subject}"$'\n' ;;
            fix)             fixed+="- ${subject}"$'\n' ;;
            perf|refactor)   changed+="- ${subject}"$'\n' ;;
            chore|docs|test|build|ci|style) ;; # noise, skip
            *)               other+="- ${subject}"$'\n' ;;
        esac
    done < <(git log --no-merges --pretty=tformat:'%s' "$range")

    local out=""
    [ -n "$added" ]   && out+="### Added"$'\n'"$added"$'\n'
    [ -n "$changed" ] && out+="### Changed"$'\n'"$changed"$'\n'
    [ -n "$fixed" ]   && out+="### Fixed"$'\n'"$fixed"$'\n'
    [ -n "$other" ]   && out+="### Other"$'\n'"$other"$'\n'
    [ -z "$out" ]     && out="### Changed"$'\n'"- Maintenance release."$'\n'

    printf '%s' "$out"
}

# Build the instruction shared by the AI changelog call.
build_ai_prompt() {
    local range="$1"
    local commits
    commits="$(git log --no-merges --pretty=format:'- %s%n%b' "$range")"
    cat <<EOF
You are writing the changelog for version $VERSION of "Werewolf", a
server-authoritative live social-deduction game.
Below is the raw git commit log since the previous release. Produce a concise,
professional changelog section in Markdown following the "Keep a Changelog" style.

Rules:
- Output ONLY the category sections, each starting with "### " (e.g. "### Added",
  "### Changed", "### Fixed", "### Removed"). Do NOT include a version header.
- Group related commits, rewrite messages into clear user-facing notes, and drop
  pure noise (version bumps, CI tweaks, formatting-only changes).
- One bullet per change, present tense, no commit hashes, no trailing period needed.
- If nothing user-facing changed, output a single "### Changed" with one bullet.
- Do not add any prose before or after the sections.

Commit log:
$commits
EOF
}

# Call the OpenAI-compatible /chat/completions endpoint of the bot provider.
# Args: base_url, api_key, model, prompt. Prints the assistant message text.
call_chat_completions() {
    local base_url="$1" api_key="$2" model="$3" prompt="$4"
    local payload response
    base_url="${base_url%/}"
    payload="$(jq -n --arg model "$model" --arg content "$prompt" \
        '{model: $model, temperature: 0.3, messages: [{role: "user", content: $content}]}')"
    response="$(curl -sS --fail "$base_url/chat/completions" \
        -H "Authorization: Bearer $api_key" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)" || {
        print_warning "Request to $base_url failed." >&2
        return 1
    }
    printf '%s' "$response" | jq -r '.choices[0].message.content // empty'
}

# Returns the changelog section body (the "### ..." blocks, no version header).
generate_changelog() {
    local range="$1"
    local prompt result

    if [ -n "${CHANGELOG_AI_MODEL:-}" ] && [ -n "${BOT_AI_API_KEY:-}" ]; then
        prompt="$(build_ai_prompt "$range")"
        result="$(call_chat_completions "${BOT_AI_BASE_URL:-https://opencode.ai/zen/go/v1}" \
            "$BOT_AI_API_KEY" "$CHANGELOG_AI_MODEL" "$prompt")" || result=""
        # Trim whitespace; require a real section ("### ") in the output.
        result="$(printf '%s' "$result" | sed -e 's/[[:space:]]*$//')"
        if [ -n "$result" ] && printf '%s' "$result" | grep -q '^### '; then
            print_status "Changelog generated with AI model '$CHANGELOG_AI_MODEL'." >&2
            printf '%s\n' "$result"
            return 0
        fi
        print_warning "AI changelog unavailable; falling back to a grouped commit list." >&2
    fi

    generate_fallback_changelog "$range"
}

# --- Determine commit range ------------------------------------------------
LAST_TAG="$(git tag --list 'v*' --sort=-version:refname | head -n1)"
if [ -n "$LAST_TAG" ]; then
    RANGE="$LAST_TAG..HEAD"
    print_status "Generating changelog for commits in $RANGE"
else
    LAST_CHANGELOG_COMMIT="$(git log -n1 --format='%H' -- CHANGELOG.md)"
    if [ -n "$LAST_CHANGELOG_COMMIT" ]; then
        RANGE="$LAST_CHANGELOG_COMMIT..HEAD"
        print_warning "No previous tag found; using commits since the last CHANGELOG.md update."
    else
        RANGE="HEAD"
        print_warning "No previous tag or changelog history found; using full history."
    fi
fi

CHANGELOG_SECTION="$(generate_changelog "$RANGE")"
TODAY="$(date +%Y-%m-%d)"
NEW_ENTRY="## [$VERSION] - $TODAY"$'\n\n'"$CHANGELOG_SECTION"

# --- Dry run: show what would happen and stop ------------------------------
if [ "$DRY_RUN" = true ]; then
    echo
    echo -e "${BLUE}=== Dry run summary ===${NC}"
    echo "Version:        $VERSION"
    echo "Release branch: $RELEASE_BRANCH (current: $(git rev-parse --abbrev-ref HEAD))"
    echo "Tag:            $TAG"
    echo "Commit range:   $RANGE"
    echo
    echo -e "${BLUE}=== Generated CHANGELOG entry ===${NC}"
    echo
    printf '%s\n' "$NEW_ENTRY"
    echo
    print_warning "Dry run complete. Nothing was changed."
    exit 0
fi

# --- From here on we mutate the repo; require a clean tree -----------------
if ! git diff-index --quiet HEAD --; then
    print_warning "You have uncommitted changes. Please commit or stash them first."
    git status --porcelain
    exit 1
fi

# --- Ensure we are on the release branch -----------------------------------
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$RELEASE_BRANCH" ]; then
    if git show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
        print_status "Switching to existing branch $RELEASE_BRANCH"
        git checkout "$RELEASE_BRANCH"
    else
        print_status "Creating release branch $RELEASE_BRANCH"
        git checkout -b "$RELEASE_BRANCH"
    fi
else
    print_status "Already on $RELEASE_BRANCH"
fi

# --- Bump version ----------------------------------------------------------
print_status "Bumping version to $VERSION"
./scripts/bump-version.sh "$VERSION"

# --- Update CHANGELOG.md ---------------------------------------------------
print_status "Updating CHANGELOG.md"
CHANGELOG_HEADER="# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
"

if [ -f CHANGELOG.md ]; then
    # Insert the new entry right after the header, before the first existing entry.
    TMP_CHANGELOG="$(mktemp)"
    EXISTING_BODY="$(awk 'found || /^## \[/{found=1; print}' CHANGELOG.md)"
    {
        printf '%s\n' "$CHANGELOG_HEADER"
        printf '%s\n\n' "$NEW_ENTRY"
        [ -n "$EXISTING_BODY" ] && printf '%s\n' "$EXISTING_BODY"
    } > "$TMP_CHANGELOG"
    mv "$TMP_CHANGELOG" CHANGELOG.md
else
    {
        printf '%s\n' "$CHANGELOG_HEADER"
        printf '%s\n' "$NEW_ENTRY"
    } > CHANGELOG.md
fi

# --- Commit, tag, push -----------------------------------------------------
print_status "Creating git commit"
git add package.json apps/client/src-tauri/Cargo.toml apps/client/src-tauri/Cargo.lock apps/client/src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore: bump version to $VERSION"

print_status "Creating git tag $TAG"
git tag -a "$TAG" -m "Release $TAG"

echo
print_warning "Ready to push the release branch and tag to the remote repository."
echo "Branch: $RELEASE_BRANCH"
echo "Tag:    $TAG"
echo

# This repo has no remote yet; skip the push with a clear warning.
if [ -z "$(git remote)" ]; then
    print_warning "No git remote configured; skipping the push."
    print_warning "The release branch and tag were created locally."
    exit 0
fi

read -p "Do you want to push these changes? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_status "Pushing $RELEASE_BRANCH"
    git push -u origin "$RELEASE_BRANCH"
    print_status "Pushing tag $TAG"
    git push origin "$TAG"

    print_status "✅ Release $TAG has been pushed!"
    echo
    print_status "Next steps:"
    print_status "  1. Open a PR from $RELEASE_BRANCH into main and merge it."
    print_status "  2. Review the release notes (they come from CHANGELOG.md)."
else
    print_warning "Release cancelled. No changes were pushed."
    print_warning "To undo local changes, run:"
    echo "  git reset --hard HEAD~1"
    echo "  git tag -d $TAG"
fi
