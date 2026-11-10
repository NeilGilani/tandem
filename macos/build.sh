#!/usr/bin/env bash
# Builds dist/Tandem.app (Apple silicon) and dist/Tandem-mac.zip.
#   macos/build.sh            build
#   macos/build.sh --open     build and open the app
# Bundles the official Node binary, so the app doesn't need Node installed.
# Requires the Xcode command line tools (swiftc).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION="v26.11.1"
VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo 0.2.0)"
BUILD="$ROOT/macos/.build"
DIST="$ROOT/dist"
APP="$DIST/Tandem.app"

mkdir -p "$BUILD" "$DIST"
rm -rf "$APP"

echo "→ Compiling the app"
swiftc -O -target arm64-apple-macos13.0 "$ROOT/macos/Tandem/main.swift" -o "$BUILD/Tandem"

echo "→ Drawing the icon"
rm -rf "$BUILD/AppIcon.iconset"
swift "$ROOT/macos/icon.swift" "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$BUILD/AppIcon.icns"

echo "→ Getting Node $NODE_VERSION"
NODE_TGZ="node-$NODE_VERSION-darwin-arm64.tar.gz"
if [ ! -f "$BUILD/$NODE_TGZ" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ" -o "$BUILD/$NODE_TGZ.part"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$BUILD/SHASUMS256.txt"
  EXPECTED="$(grep " $NODE_TGZ\$" "$BUILD/SHASUMS256.txt" | cut -d' ' -f1)"
  ACTUAL="$(shasum -a 256 "$BUILD/$NODE_TGZ.part" | cut -d' ' -f1)"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "Node checksum mismatch" >&2; exit 1; }
  mv "$BUILD/$NODE_TGZ.part" "$BUILD/$NODE_TGZ"
fi
rm -rf "$BUILD/node"
mkdir -p "$BUILD/node"
tar -xzf "$BUILD/$NODE_TGZ" -C "$BUILD/node" --strip-components 1

echo "→ Assembling Tandem.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/node/bin" "$APP/Contents/Resources/tandem"
cp "$BUILD/Tandem" "$APP/Contents/MacOS/Tandem"
cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$BUILD/node/bin/node" "$APP/Contents/Resources/node/bin/node"
cp "$BUILD/node/LICENSE" "$APP/Contents/Resources/node/LICENSE"
for d in server web mcp bin laptop; do cp -R "$ROOT/$d" "$APP/Contents/Resources/tandem/$d"; done
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$APP/Contents/Resources/tandem/"
(cd "$APP/Contents/Resources/tandem" && PATH="$BUILD/node/bin:$PATH" "$BUILD/node/bin/npm" ci --omit=dev --no-audit --no-fund --silent)

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Tandem</string>
  <key>CFBundleDisplayName</key><string>Tandem</string>
  <key>CFBundleIdentifier</key><string>com.neilgilani.tandem</string>
  <key>CFBundleExecutable</key><string>Tandem</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Tandem uses the microphone when you talk to your Bots.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Tandem turns what you say into messages for your Bots.</string>
  <key>NSAppleEventsUsageDescription</key><string>Tandem can bring a Bot’s browser window to the front when you take over.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
EOF

echo "→ Signing (ad hoc)"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1

echo "→ Zipping"
rm -f "$DIST/Tandem-mac.zip"
ditto -c -k --keepParent "$APP" "$DIST/Tandem-mac.zip"
echo "Built $APP ($(du -sh "$APP" | cut -f1)), zip $(du -h "$DIST/Tandem-mac.zip" | cut -f1)"
[ "${1:-}" = "--open" ] && open "$APP" || true
