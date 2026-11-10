#!/bin/sh
# Boot a Bot's laptop: screen, desktop, remote view and the browser.
export DISPLAY=:1
export HOME="${HOME:-/tmp/home}"
mkdir -p "$HOME/Desktop" "$HOME/Downloads" "$HOME/.config"
W="${SCREEN_W:-1280}" H="${SCREEN_H:-800}"

Xvfb :1 -screen 0 "${W}x${H}x24" -nolisten tcp -ac >/dev/null 2>&1 &
for i in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.1; done 2>/dev/null
xsetroot -solid '#1f2a3d'
openbox >/dev/null 2>&1 &
tint2 >/dev/null 2>&1 &

# The screen, for watching and taking over (localhost inside the laptop; published to the Mac only).
x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -localhost -quiet -noxdamage >/dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

# The browser. Kept lean: few renderer processes, no background throttling.
start_browser() {
  chromium --no-sandbox --test-type --remote-debugging-port=9222 --user-data-dir="$HOME/.chromium" \
    --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic \
    --renderer-process-limit=3 --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows --disable-features=Translate,MediaRouter,OptimizationHints \
    --window-position=0,0 --window-size="${W},$((H - 30))" about:blank >/dev/null 2>&1
}
( while true; do start_browser; sleep 1; done ) &
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 >/dev/null 2>&1 &

wait
