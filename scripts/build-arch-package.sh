#!/bin/bash
# Script to build Arch Linux package using Docker
# This can be run from any Linux distribution (Mint, Ubuntu, Fedora, etc.)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
echo "Project root: $PROJECT_ROOT"
BUILD_DIR="$SCRIPT_DIR/arch-package"
OUTPUT_DIR="$PROJECT_ROOT/apps/client/src-tauri/target/release/bundle/arch"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Arch Linux Package Builder ===${NC}"

# Get version from package.json
VERSION=$(grep -Po '"version":\s*"\K[^"]+' "$PROJECT_ROOT/package.json" | head -1)
echo -e "${YELLOW}Building version: $VERSION${NC}"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Locate the Tauri build artifacts. A local `bun run build:arch` builds with an
# explicit --target, so everything lands under the target-triple directory; CI
# instead stages the downloaded artifacts in the plain release directory. Accept
# whichever exists rather than forcing one of the two to be wrong.
TAURI_DIR="$PROJECT_ROOT/apps/client/src-tauri"
if [[ -f "$TAURI_DIR/target/x86_64-unknown-linux-gnu/release/werewolf" ]]; then
    RELEASE_DIR="$TAURI_DIR/target/x86_64-unknown-linux-gnu/release"
else
    RELEASE_DIR="$TAURI_DIR/target/release"
fi

# The binary is "werewolf" because tauri.conf.json sets mainBinaryName; the cargo
# crate is still "app", so without that the deb would install /usr/bin/app.
BINARY_PATH="$RELEASE_DIR/werewolf"
ICON_PATH="$TAURI_DIR/icons/128x128.png"
# Capitalised because productName is "Werewolf", which is what tauri names the
# deb and the .desktop entry after.
DEB_DIR="$RELEASE_DIR/bundle/deb/Werewolf_${VERSION}_amd64"
DESKTOP_PATH="$DEB_DIR/usr/share/applications/Werewolf.desktop"

if [[ ! -f "$BINARY_PATH" ]]; then
    echo -e "${RED}Error: Binary not found at $BINARY_PATH${NC}"
    echo -e "${YELLOW}Run 'bun run build:arch' first to generate the release artifacts.${NC}"
    exit 1
fi

if [[ ! -f "$DESKTOP_PATH" ]]; then
    echo -e "${YELLOW}Warning: .desktop file not found at expected path.${NC}"
    echo -e "${YELLOW}Creating a basic .desktop file...${NC}"
    
    # Create a basic .desktop file
    mkdir -p "$(dirname "$DESKTOP_PATH")"
    cat > "$DESKTOP_PATH" << EOF
[Desktop Entry]
Name=Werewolf
Comment=Live social deduction with friends
Exec=werewolf
Icon=werewolf
Terminal=false
Type=Application
Categories=Game;
StartupWMClass=werewolf
EOF
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Create a temporary build context
TEMP_BUILD_DIR=$(mktemp -d)
trap "rm -rf $TEMP_BUILD_DIR" EXIT

echo -e "${YELLOW}Preparing build context...${NC}"

# Copy necessary files to temp build directory
cp "$BINARY_PATH" "$TEMP_BUILD_DIR/werewolf"
cp "$ICON_PATH" "$TEMP_BUILD_DIR/werewolf.png"
cp "$DESKTOP_PATH" "$TEMP_BUILD_DIR/werewolf.desktop"
cp "$BUILD_DIR/Dockerfile" "$TEMP_BUILD_DIR/"

# Create PKGBUILD with correct version
cat > "$TEMP_BUILD_DIR/PKGBUILD" << EOF
# Maintainer: M4ss1ck
pkgname=werewolf-bin
pkgver=$VERSION
pkgrel=1
pkgdesc="Server-authoritative live social deduction game"
arch=('x86_64')
url="https://github.com/M4ss1ck/werewolf"
license=('MIT')
# Tauri v2 dependencies
depends=('webkit2gtk-4.1' 'gtk3' 'libappindicator-gtk3')
provides=('werewolf')
conflicts=('werewolf')

# Sources are provided as pre-built artifacts
source=("werewolf"
        "werewolf.png"
        "werewolf.desktop")

# We skip checksums for local builds
sha256sums=('SKIP' 'SKIP' 'SKIP')

package() {
    # 1. Install the binary
    install -Dm755 "\${srcdir}/werewolf" "\${pkgdir}/usr/bin/werewolf"

    # 2. Install the icon
    install -Dm644 "\${srcdir}/werewolf.png" "\${pkgdir}/usr/share/icons/hicolor/128x128/apps/werewolf.png"

    # 3. Install the .desktop file
    install -Dm644 "\${srcdir}/werewolf.desktop" "\${pkgdir}/usr/share/applications/werewolf.desktop"
}
EOF

echo -e "${YELLOW}Building Docker image...${NC}"
docker build -t werewolf-arch-builder "$TEMP_BUILD_DIR"

echo -e "${YELLOW}Running makepkg in container...${NC}"
docker run --rm \
    -v "$TEMP_BUILD_DIR:/build-src:ro" \
    -v "$OUTPUT_DIR:/output" \
    --user root \
    werewolf-arch-builder \
    bash -c "
        # Copy source files to writable directory and fix permissions
        cp -r /build-src/* /home/builder/build/ && \
        chown -R builder:builder /home/builder/build /output && \
        cd /home/builder/build && \
        su builder -c 'makepkg -sf --noconfirm' && \
        cp *.pkg.tar.zst /output/ 2>/dev/null || cp *.pkg.tar.* /output/
    "

# Check if package was created
PKG_FILE=$(ls -1 "$OUTPUT_DIR"/werewolf-bin-*.pkg.tar.* 2>/dev/null | head -1)

if [[ -n "$PKG_FILE" ]]; then
    echo -e "${GREEN}=== Success! ===${NC}"
    echo -e "${GREEN}Package created: $PKG_FILE${NC}"
    echo ""
    echo -e "To install on Arch Linux:"
    echo -e "  ${YELLOW}sudo pacman -U $(basename "$PKG_FILE")${NC}"
else
    echo -e "${RED}Error: Package was not created.${NC}"
    exit 1
fi
