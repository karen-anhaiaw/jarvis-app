#!/bin/bash
# Install JARVIS as a macOS app with the reactor orb icon
# Creates ~/Applications/JARVIS.app

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$HOME/Applications/JARVIS.app"
ICON_SVG="$REPO_DIR/app/ui/public/jarvis-icon.svg"

echo "Installing JARVIS.app..."

# Generate .icns from SVG if not already present
ICNS="$REPO_DIR/app/ui/public/jarvis.icns"
if [ ! -f "$ICNS" ]; then
  if command -v rsvg-convert &>/dev/null; then
    echo "Generating icon from SVG..."
    rsvg-convert -w 1024 -h 1024 "$ICON_SVG" > /tmp/jarvis-icon-1024.png
    mkdir -p /tmp/jarvis.iconset
    for size in 16 32 128 256 512; do
      sips -z $size $size /tmp/jarvis-icon-1024.png --out /tmp/jarvis.iconset/icon_${size}x${size}.png > /dev/null 2>&1
      double=$((size * 2))
      sips -z $double $double /tmp/jarvis-icon-1024.png --out /tmp/jarvis.iconset/icon_${size}x${size}@2x.png > /dev/null 2>&1
    done
    iconutil -c icns /tmp/jarvis.iconset -o "$ICNS"
    rm -rf /tmp/jarvis.iconset /tmp/jarvis-icon-1024.png
  else
    echo "Warning: rsvg-convert not found (brew install librsvg). Using placeholder icon."
  fi
fi

# Create app bundle
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy icon
if [ -f "$ICNS" ]; then
  cp "$ICNS" "$APP_DIR/Contents/Resources/jarvis.icns"
fi

# Info.plist
cat > "$APP_DIR/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>jarvis</string>
  <key>CFBundleIconFile</key>
  <string>jarvis</string>
  <key>CFBundleIdentifier</key>
  <string>com.giovanibarili.jarvis</string>
  <key>CFBundleName</key>
  <string>JARVIS</string>
  <key>CFBundleDisplayName</key>
  <string>J.A.R.V.I.S.</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

# Launcher script
cat > "$APP_DIR/Contents/MacOS/jarvis" << LAUNCHER
#!/bin/bash
# Load shell environment (API keys, PATH, etc.)
source "\$HOME/.zshrc" 2>/dev/null || source "\$HOME/.bash_profile" 2>/dev/null || true
REPO_DIR="$REPO_DIR"
JARVIS_DIR="\$REPO_DIR/app"
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
# Redirect this whole shell to the log so bootstrap output is also captured.
exec > /tmp/jarvis.log 2>&1
# Sync ~/.jarvis scaffolding + committed defaults from the repo on every boot.
# Non-fatal: a bootstrap failure must not block the JARVIS launch.
echo "--- bootstrap ---"
"\$REPO_DIR/scripts/bootstrap.sh" || echo "(bootstrap failed, continuing)"
echo "--- jarvis ---"
cd "\$JARVIS_DIR"
exec npx tsx src/main.ts
LAUNCHER

chmod +x "$APP_DIR/Contents/MacOS/jarvis"

# Register with LaunchServices
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR" 2>/dev/null || true

echo ""
echo "JARVIS.app installed at: $APP_DIR"
echo "Launch via Spotlight (Cmd+Space → JARVIS) or Finder → Applications → JARVIS"
