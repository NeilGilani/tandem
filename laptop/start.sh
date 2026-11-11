#!/bin/sh
# Boot a Bot's laptop and keep it healthy: screen, desktop, taskbar, remote view and the
# browser. A watchdog restarts anything that stops, and logs it to ~/.tandem/laptop.log.
export DISPLAY=:1
export HOME="${HOME:-/tmp/home}"
mkdir -p "$HOME/Desktop" "$HOME/Downloads" "$HOME/.config" "$HOME/.tandem"
LOG="$HOME/.tandem/laptop.log"
W="${SCREEN_W:-1280}" H="${SCREEN_H:-800}"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
up() { pgrep -x "$1" >/dev/null 2>&1; }

start_screen() {
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  Xvfb :1 -screen 0 "${W}x${H}x24" -nolisten tcp -ac >>"$LOG" 2>&1 &
  for i in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.1; done
  xsetroot -solid '#1f2a3d'
}

# The browser. Kept lean: few renderer processes, no background throttling.
start_browser() {
  rm -f "$HOME/.chromium/SingletonLock" "$HOME/.chromium/SingletonSocket" "$HOME/.chromium/SingletonCookie"
  chromium --no-sandbox --test-type --remote-debugging-port=9222 --user-data-dir="$HOME/.chromium" \
    --no-first-run --no-default-browser-check --hide-crash-restore-bubble --disable-session-crashed-bubble --disable-dev-shm-usage --password-store=basic \
    --renderer-process-limit=3 --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows --disable-features=Translate,MediaRouter,OptimizationHints \
    --window-position=0,0 --window-size="${W},$((H - 30))" about:blank >>"$LOG" 2>&1 &
}

log "laptop starting"
start_screen
first=1
while true; do
  if ! up Xvfb; then [ -z "$first" ] && log "screen stopped; restarting it"; start_screen; fi
  up openbox || { [ -z "$first" ] && log "window manager stopped; restarting it"; openbox >>"$LOG" 2>&1 & }
  up tint2 || tint2 >/dev/null 2>&1 &
  # The screen, for watching and taking over (localhost inside the laptop; published to the Mac only).
  up x11vnc || { [ -z "$first" ] && log "remote view stopped; restarting it"; x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -localhost -quiet -noxdamage >>"$LOG" 2>&1 & }
  pgrep -f websockify >/dev/null 2>&1 || websockify --web /usr/share/novnc 6080 localhost:5900 >>"$LOG" 2>&1 &
  up chromium || { [ -z "$first" ] && log "browser stopped; restarting it"; start_browser; }
  up socat || socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 >/dev/null 2>&1 &
  first=
  sleep 3
done
