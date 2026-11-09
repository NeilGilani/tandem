#!/usr/bin/env bash
# Tandem installer — https://github.com/NeilGilani/tandem
#   curl -fsSL https://raw.githubusercontent.com/NeilGilani/tandem/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/NeilGilani/tandem.git"
DIR="${TANDEM_DIR:-$HOME/tandem}"
bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); red=$(printf '\033[31m'); reset=$(printf '\033[0m')
say() { printf '%s\n' "$*"; }
die() { printf '%sError:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

say "${bold}Installing Tandem${reset}"

[ "$(uname -s)" = "Darwin" ] || say "${dim}Tandem is built for macOS. Other systems may work without the Mac apps and Keychain.${reset}"
command -v git >/dev/null || die "git is required. Install the Xcode command line tools: xcode-select --install"

if ! command -v node >/dev/null; then
  if command -v brew >/dev/null; then say "Installing Node with Homebrew…"; brew install node; else die "Node 22.13+ is required: https://nodejs.org"; fi
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  die "Node $(node -v) is too old. Tandem needs 22.13 or newer (brew upgrade node)."
fi

if ! command -v claude >/dev/null; then
  die "Claude Code is required. Install it, run 'claude' once to sign in, then run this again:
    curl -fsSL https://claude.ai/install.sh | bash"
fi

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR…"
  git -C "$DIR" pull --ff-only --quiet
else
  [ -e "$DIR" ] && die "$DIR already exists. Set TANDEM_DIR to install somewhere else."
  say "Downloading to $DIR…"
  git clone --quiet --depth 1 "$REPO" "$DIR"
fi

say "Installing dependencies…"
(cd "$DIR" && npm install --silent --no-audit --no-fund)
chmod +x "$DIR/bin/tandem"

# Put `tandem` on the PATH when there's a user bin folder for it.
for BIN in "$HOME/.local/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
  if [ -d "$BIN" ] && [ -w "$BIN" ] && [[ ":$PATH:" == *":$BIN:"* ]]; then
    ln -sf "$DIR/bin/tandem" "$BIN/tandem"; LINKED="$BIN/tandem"; break
  fi
done

"$DIR/bin/tandem" install
for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:4747/api/computer/status >/dev/null 2>&1 && break; sleep 0.5; done
command -v open >/dev/null && open "http://127.0.0.1:4747" || true

say ""
say "${bold}Tandem is running at http://127.0.0.1:4747${reset}"
say "It runs in the background and starts when you log in."
say "${dim}Commands: ${LINKED:+tandem}${LINKED:-$DIR/bin/tandem} open | status | logs | uninstall${reset}"
