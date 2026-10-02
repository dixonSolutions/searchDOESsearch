#!/usr/bin/env bash
# shell-smoke.sh — run the built extension inside a real, headless GNOME Shell
# and drive it with scripts/smoke-driver@searchdoessearch.test: enable, search,
# disable, enable, search. Fails unless the driver gets all the way through.
#
# It starts its own system bus, a dbusmock logind and a session bus, and
# installs into $HOME — so it only runs in a throwaway container. Use
# `make compat IMAGE=fedora:45` locally; the compat workflow runs it in CI.
#
#   scripts/shell-smoke.sh [OUT_DIR]     screenshots and shell.log land here
#
# SDS_SMOKE_ANY_SHELL=1 turns off the Shell's shell-version check, so the
# rawhide canary can run the code on a Shell metadata.json does not claim yet.
set -euo pipefail

UUID="search-does-search@searchdoessearch.github.io"
DRIVER="smoke-driver@searchdoessearch.test"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:-$REPO_DIR/build/smoke}" && cd "${1:-$REPO_DIR/build/smoke}" && pwd)"
TIMEOUT=120

if [[ ! -e /run/.containerenv && ! -e /.dockerenv && -z "${CI:-}" ]]; then
  echo "shell-smoke.sh: refusing to run outside a container — it replaces the" >&2
  echo "system bus and installs into \$HOME. Use: make compat IMAGE=fedora:45" >&2
  exit 2
fi

[[ -f "$REPO_DIR/dist/$UUID/metadata.json" ]] || make -C "$REPO_DIR" build
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$EXT_DIR"
rm -rf "${EXT_DIR:?}/$UUID" "${EXT_DIR:?}/$DRIVER"
cp -a "$REPO_DIR/dist/$UUID" "$REPO_DIR/scripts/$DRIVER" "$EXT_DIR/"

mkdir -p /run/dbus
dbus-uuidgen --ensure
dbus-daemon --system --fork
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
python3 -m dbusmock --template logind --system >"$OUT/dbusmock.log" 2>&1 &
sleep 2

export XDG_RUNTIME_DIR=/tmp/sds-xdg
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
# 48 still starts Xwayland, and aborts if it cannot make its socket here.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
DBUS_SESSION_BUS_ADDRESS="$(dbus-daemon --session --fork --print-address=1)"
export DBUS_SESSION_BUS_ADDRESS
gsettings set org.gnome.shell enabled-extensions "['$UUID', '$DRIVER']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
[[ -n "${SDS_SMOKE_ANY_SHELL:-}" ]] &&
  gsettings set org.gnome.shell disable-extension-version-validation true

LOG="$OUT/shell.log"
SDS_NO_LAUNCH=1 SDS_SMOKE_OUT="$OUT" \
  timeout "$TIMEOUT" gnome-shell --headless --virtual-monitor 1280x800 \
  --wayland-display=wayland-smoke >"$LOG" 2>&1 &
SHELL_PID=$!

for _ in $(seq 1 "$TIMEOUT"); do
  grep -qE 'SDS-SMOKE (DONE|FAIL)' "$LOG" && break
  kill -0 "$SHELL_PID" 2>/dev/null || break
  sleep 1
done
kill "$SHELL_PID" 2>/dev/null || true
wait "$SHELL_PID" 2>/dev/null || true

grep -F 'SDS-SMOKE' "$LOG" || true
# Errors raised from this extension's own code, whichever way the Shell logs them.
if grep -E 'JS ERROR|JS WARNING|Gjs-CRITICAL' -A8 "$LOG" | grep -qE "$UUID|SearchDoesSearch|sds-renderer"; then
  echo "✗ the Shell logged an error from the extension — see $LOG"
  grep -E 'JS ERROR|JS WARNING|Gjs-CRITICAL' -A8 "$LOG" | head -40
  exit 1
fi
if grep -q 'SDS-SMOKE FAIL' "$LOG" || ! grep -q 'SDS-SMOKE DONE' "$LOG"; then
  echo "✗ the smoke run did not finish — last lines of $LOG:"
  tail -n 30 "$LOG"
  exit 1
fi
echo "✓ enable → search → disable → enable → search on $(gnome-shell --version)"
