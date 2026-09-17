#!/usr/bin/env bash
# nested-test.sh
#
# Builds the extension from the working tree, installs it, and runs it in a
# throwaway nested GNOME Shell — so a code change can be tested without logging
# out. GNOME caches extension ES modules for the life of a session, so
# `gnome-extensions disable && enable` on the host reloads nothing; a second
# shell on its own D-Bus session is the only way to load changed code now.
#
# Headed by default (a devkit window on your desktop); --headless paints into a
# virtual monitor with no window, for SSH, a locked screen, or gdr capture.
#
#   ./scripts/nested-test.sh                  build, install, headed session
#   ./scripts/nested-test.sh --headless       no window; virtual monitor
#   ./scripts/nested-test.sh --headless --gdr start gdrd against that session
#   ./scripts/nested-test.sh --no-build       reuse what is already installed
#
# GNOME 50 notes (Ubuntu 26.04, Shell/mutter 50.1):
#   * `--nested` is gone — mutter 50 dropped the X11-nested backend.
#   * `--headless` names the *backend*, not the visibility. The headed path is
#     `--headless --devkit` plus a mutter-devkit viewer we launch ourselves
#     against the HOST session; without --devkit mutter spawns its own viewer on
#     the nested DISPLAY, which dies on the MIT-MAGIC-COOKIE and takes the shell
#     with it.
#   * Do NOT pass --virtual-monitor alongside --devkit: devkit adds a monitor
#     sized to its window, and an explicit one becomes primary, so the top bar
#     renders on the monitor you cannot see. Resize the window instead.
#
# The default profile is isolated under the log directory: extension files,
# dconf, cookies and caches stay out of the live desktop. --shared-profile is an
# explicit opt-in to the old behavior of testing the user's installed profile.

set -euo pipefail

UUID="search-does-search@searchdoessearch.github.io"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Defaults ────────────────────────────────────────────────────────────────
HEADED=1                 # --headless flips this
DO_BUILD=1
DO_ENABLE=1
ISOLATED=1
START_GDR=0
GDR_PORT=7339
SIZE="1280x800"
WL_DISPLAY="wayland-sds"
LOG_DIR="${TMPDIR:-/tmp}/sds-nested"
ALLOW_LAUNCH=0           # renderer opening real browsers in the test session
DEBUG=0
VERBOSE=0                # stream every shell log line, not just ours
TIMEOUT=0                # seconds; 0 = run until Ctrl+C or the shell exits

# ── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}→${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

  --headless          No devkit window: a virtual monitor session instead.
                      Use over SSH, from a locked screen, or with --gdr.
  --size WxH          Virtual monitor size in --headless (default $SIZE).
  --gdr[=PORT]        --headless only: run gdrd against the nested session on
                      127.0.0.1:PORT (default $GDR_PORT) so gdr_* tools can see it.
                      Reads GDR_TOKEN, or generates and prints one.
  --no-build          Skip compilation; use the built dist in the isolated profile.
  --shared-profile    Use/install the live user profile (changes real settings).
  --no-enable         Do not enable the extension in the nested session.
  --allow-launch      Let the renderer open real browsers (default: SDS_NO_LAUNCH=1).
  --debug             SDS_DEBUG=1 in the session (frame timings, scroll events).
  --verbose           Stream every shell log line, not just this extension's.
  --wayland-display N Wayland socket name for the nested session (default $WL_DISPLAY).
  --timeout SECONDS   Shut the session down after SECONDS (0 = until Ctrl+C).
  --log-dir DIR       Where to write session logs (default $LOG_DIR).
  -h, --help          This message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --headless)          HEADED=0 ;;
    --headed)            HEADED=1 ;;
    --size)              SIZE="$2"; shift ;;
    --size=*)            SIZE="${1#*=}" ;;
    --gdr)               START_GDR=1 ;;
    --gdr=*)             START_GDR=1; GDR_PORT="${1#*=}" ;;
    --no-build)          DO_BUILD=0 ;;
    --shared-profile)    ISOLATED=0 ;;
    --no-enable)         DO_ENABLE=0 ;;
    --allow-launch)      ALLOW_LAUNCH=1 ;;
    --debug)             DEBUG=1 ;;
    --verbose)           VERBOSE=1 ;;
    --wayland-display)   WL_DISPLAY="$2"; shift ;;
    --wayland-display=*) WL_DISPLAY="${1#*=}" ;;
    --timeout)           TIMEOUT="$2"; shift ;;
    --timeout=*)         TIMEOUT="${1#*=}" ;;
    --log-dir)           LOG_DIR="$2"; shift ;;
    --log-dir=*)         LOG_DIR="${1#*=}" ;;
    -h|--help)           usage; exit 0 ;;
    *) error "Unknown option: $1"; usage >&2; exit 2 ;;
  esac
  shift
done

[[ $HEADED -eq 1 && $START_GDR -eq 1 ]] && {
  error "--gdr needs --headless: gdrd captures nothing from a devkit viewer window."
  exit 2
}

# ── Preflight ───────────────────────────────────────────────────────────────
DEVKIT_BIN="/usr/libexec/mutter-devkit"
# Prefer the distro dbus-daemon: a Homebrew one on PATH can be a different build
# than the shell's libdbus.
DBUS_DAEMON="$(command -v /usr/bin/dbus-daemon || command -v dbus-daemon || true)"

preflight() {
  local missing=()
  for cmd in gnome-shell gnome-extensions gdbus; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  [[ -n "$DBUS_DAEMON" ]] || missing+=("dbus-daemon")
  if [[ $DO_BUILD -eq 1 ]]; then
    for cmd in node npm glib-compile-schemas make; do
      command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
  fi
  if [[ $HEADED -eq 1 && ! -x "$DEVKIT_BIN" ]]; then
    error "$DEVKIT_BIN not found — the headed session needs it."
    echo "  sudo apt install mutter-dev-bin      (or run with --headless)"
    exit 1
  fi
  if [[ $START_GDR -eq 1 ]] && ! command -v gdrd &>/dev/null; then
    missing+=("gdrd")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing required tools: ${missing[*]}"
    exit 1
  fi
  if [[ $HEADED -eq 1 && -z "${WAYLAND_DISPLAY:-}" ]]; then
    error "No host WAYLAND_DISPLAY — there is no desktop to put the devkit window on."
    echo "  Run with --headless instead."
    exit 1
  fi
}

# ── Cleanup: PID-scoped, never by name ──────────────────────────────────────
# A name-based kill here would reach the host's gnome-shell and take down the
# real desktop. Only the pids this script started are ever signalled.
SHELL_PID=""; VIEWER_PID=""; GDR_PID=""; BUS_PID=""; TAIL_PID=""

stop_pid() {
  local pid="$1" name="$2"
  [[ -n "$pid" ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  info "Stopping $name ($pid)"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  header "Shutting the nested session down"
  stop_pid "$TAIL_PID"   "log stream"
  stop_pid "$GDR_PID"    "gdrd"
  stop_pid "$VIEWER_PID" "devkit viewer"
  stop_pid "$SHELL_PID"  "nested gnome-shell"
  stop_pid "$BUS_PID"    "session bus"
  [[ -n "${SHELL_LOG:-}" ]] && echo "  Session log kept at $SHELL_LOG"
  success "Done — the host session was not touched"
}

# ── Wait helpers ────────────────────────────────────────────────────────────
bus_name_owned() {
  gdbus call --session \
    --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.NameHasOwner "$1" 2>/dev/null | grep -q true
}

wait_for_name() {
  local name="$1" secs="$2"
  for _ in $(seq 1 $(( secs * 4 ))); do
    bus_name_owned "$name" && return 0
    # No point waiting on a name whose process already died.
    [[ -n "$SHELL_PID" ]] && ! kill -0 "$SHELL_PID" 2>/dev/null && return 1
    sleep 0.25
  done
  return 1
}

# ── Build + install ─────────────────────────────────────────────────────────
build_and_install() {
  header "Building the working tree"
  local rev
  rev="$(git -C "$REPO_DIR" describe --always --dirty 2>/dev/null || echo 'not a git checkout')"
  info "Source: $REPO_DIR ($rev)"
  # `make install` type-checks, compiles TS, compiles the schema, and clears the
  # target first — a stale .js the shell can still import is a debugging trap.
  make -C "$REPO_DIR" install EXT_DIR="$INSTALL_DIR"
  success "Installed to $INSTALL_DIR"
}

# ── Main ────────────────────────────────────────────────────────────────────
preflight
mkdir -p "$LOG_DIR"
LOG_DIR="$(cd "$LOG_DIR" && pwd)"
if [[ $ISOLATED -eq 1 ]]; then
  PROFILE_ROOT="${SDS_NESTED_ROOT:-$LOG_DIR/profile}"
  mkdir -p "$PROFILE_ROOT"/{config,data,cache,state}
  PROFILE_ROOT="$(cd "$PROFILE_ROOT" && pwd)"
  export XDG_CONFIG_HOME="$PROFILE_ROOT/config"
  export XDG_DATA_HOME="$PROFILE_ROOT/data"
  export XDG_CACHE_HOME="$PROFILE_ROOT/cache"
  export XDG_STATE_HOME="$PROFILE_ROOT/state"
  info "Isolated profile: $PROFILE_ROOT"
fi
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
if [[ $DO_BUILD -eq 1 ]]; then
  build_and_install
elif [[ $ISOLATED -eq 1 ]]; then
  [[ -f "$REPO_DIR/dist/$UUID/extension.js" ]] || { error "No build found; run without --no-build"; exit 1; }
  mkdir -p "$INSTALL_DIR"
  cp -r "$REPO_DIR/dist/$UUID/." "$INSTALL_DIR/"
  glib-compile-schemas "$INSTALL_DIR/schemas"
fi

mkdir -p "$LOG_DIR"
SHELL_LOG="$LOG_DIR/nested-shell-$(date +%H%M%S).log"

trap cleanup EXIT INT TERM

header "Starting a private session bus"
# --print-address and --print-pid both land on stdout; order is not documented,
# so classify the lines rather than assuming.
while read -r line; do
  case "$line" in
    unix:*)     BUS_ADDRESS="$line" ;;
    [0-9]*)     BUS_PID="$line" ;;
  esac
done < <("$DBUS_DAEMON" --session --print-address=1 --print-pid=1 --fork)
[[ -n "${BUS_ADDRESS:-}" ]] || { error "dbus-daemon printed no address"; exit 1; }
export DBUS_SESSION_BUS_ADDRESS="$BUS_ADDRESS"
success "Bus up (pid ${BUS_PID:-?})"
# Export a reproducible command environment without printing live-user paths
# as if they were the isolated profile.
{
  for key in DBUS_SESSION_BUS_ADDRESS XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME; do
    printf 'export %s=%q\n' "$key" "${!key:-}"
  done
  printf 'export WAYLAND_DISPLAY=%q\n' "$WL_DISPLAY"
} > "$LOG_DIR/session.env"
if [[ $ISOLATED -eq 1 ]]; then
  gsettings set org.gnome.shell disable-user-extensions false
fi


header "Starting the nested GNOME Shell"
# A shell that has just been asked to quit still holds its wayland socket for a
# moment, and mutter aborts outright ("unable to lock lockfile") rather than
# waiting. Give the previous run a few seconds to let go, then step aside.
lock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/$WL_DISPLAY.lock"
if [[ -e "$lock" ]]; then
  info "Waiting for $WL_DISPLAY to be released"
  for _ in $(seq 1 20); do
    [[ -e "$lock" ]] || break
    sleep 0.5
  done
  if [[ -e "$lock" ]]; then
    WL_DISPLAY="$WL_DISPLAY-$$"
    warn "Still held — using $WL_DISPLAY instead"
  fi
fi

printf 'export WAYLAND_DISPLAY=%q\n' "$WL_DISPLAY" >> "$LOG_DIR/session.env"

SHELL_ENV=(
  "DBUS_SESSION_BUS_ADDRESS=$BUS_ADDRESS"
  "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
)
# Keep the renderer from opening real browsers on stray clicks in a test session.
[[ $ALLOW_LAUNCH -eq 0 ]] && SHELL_ENV+=("SDS_NO_LAUNCH=1")
[[ $DEBUG -eq 1 ]]        && SHELL_ENV+=("SDS_DEBUG=1")

if [[ $HEADED -eq 1 ]]; then
  HOST_WAYLAND="$WAYLAND_DISPLAY"
  info "Mode: headed (devkit window on the host desktop)"
  # -u DISPLAY/-u WAYLAND_DISPLAY: the headless backend needs neither, and
  # leaving the host's values set leaks them to apps launched in the session.
  env -u DISPLAY -u WAYLAND_DISPLAY "${SHELL_ENV[@]}" \
    gnome-shell --headless --devkit --wayland-display="$WL_DISPLAY" \
    >"$SHELL_LOG" 2>&1 &
else
  info "Mode: headless (virtual monitor $SIZE, no window)"
  env -u DISPLAY -u WAYLAND_DISPLAY "${SHELL_ENV[@]}" \
    gnome-shell --headless --virtual-monitor "$SIZE" --wayland-display="$WL_DISPLAY" \
    >"$SHELL_LOG" 2>&1 &
fi
SHELL_PID=$!

if ! wait_for_name org.gnome.Shell 60; then
  error "The nested shell never took org.gnome.Shell — last log lines:"
  tail -n 25 "$SHELL_LOG" >&2
  exit 1
fi
success "Nested shell up (pid $SHELL_PID, WAYLAND_DISPLAY=$WL_DISPLAY)"

# ── The viewer (headed only) ────────────────────────────────────────────────
if [[ $HEADED -eq 1 ]]; then
  if ! wait_for_name org.gnome.Mutter.Devkit 30; then
    error "org.gnome.Mutter.Devkit never appeared — is this shell < 50?"
    tail -n 25 "$SHELL_LOG" >&2
    exit 1
  fi
  info "Launching the devkit viewer against the host session"
  # The viewer is a GTK4 client of the HOST compositor that draws the nested
  # one: host WAYLAND_DISPLAY, private bus.
  env -u DISPLAY -u XAUTHORITY \
    WAYLAND_DISPLAY="$HOST_WAYLAND" \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
    GDK_BACKEND=wayland \
    DBUS_SESSION_BUS_ADDRESS="$BUS_ADDRESS" \
    "$DEVKIT_BIN" >>"$LOG_DIR/devkit-viewer.log" 2>&1 &
  VIEWER_PID=$!
  sleep 1
  if ! kill -0 "$VIEWER_PID" 2>/dev/null; then
    error "The viewer exited immediately — see $LOG_DIR/devkit-viewer.log"
    exit 1
  fi
  success "Viewer up (pid $VIEWER_PID) — resize its window to resize the session"
fi

# ── The extension ───────────────────────────────────────────────────────────
if [[ $DO_ENABLE -eq 1 ]]; then
  header "Enabling $UUID in the nested session"
  if gnome-extensions enable "$UUID" 2>/dev/null; then
    sleep 1
    state="$(gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/^ *State: *//p')"
    if [[ "$state" == ACTIVE* ]]; then
      success "State: $state"
    else
      warn "State: ${state:-unknown} — the shell log will say why"
      grep -iE 'searchdoessearch|search-does-search|JS ERROR' "$SHELL_LOG" | tail -n 15 || true
    fi
  else
    warn "gnome-extensions enable failed — is the extension installed? (drop --no-build)"
  fi
fi

# ── Hand over ───────────────────────────────────────────────────────────────
if [[ $START_GDR -eq 1 ]]; then
  header "Starting gdrd for the nested session"
  GDR_TOKEN="${GDR_TOKEN:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )}"
  IFS=x read -r GDR_W GDR_H <<<"$SIZE"
  env "DBUS_SESSION_BUS_ADDRESS=$BUS_ADDRESS" \
      "WAYLAND_DISPLAY=$WL_DISPLAY" \
      "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
      "GDR_TOKEN=$GDR_TOKEN" \
    gdrd --bind "127.0.0.1:$GDR_PORT" --connector Meta-0 --eager-display \
         --width "$GDR_W" --height "$GDR_H" >>"$LOG_DIR/gdrd.log" 2>&1 &
  GDR_PID=$!
  sleep 2
  if kill -0 "$GDR_PID" 2>/dev/null; then
    success "gdrd on 127.0.0.1:$GDR_PORT (pid $GDR_PID)"
    echo "  Register it once:  gdr_device_add {id: \"sds\", local: true, port: $GDR_PORT, token: \"$GDR_TOKEN\"}"
  else
    warn "gdrd exited — see $LOG_DIR/gdrd.log"
    GDR_PID=""
  fi
fi

header "Session ready"
cat <<EOF
  Bus       : $DBUS_SESSION_BUS_ADDRESS
  Wayland   : $WL_DISPLAY
  Shell log : $SHELL_LOG

  Run something inside it:
    DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS' WAYLAND_DISPLAY=$WL_DISPLAY \\
      gnome-extensions list --enabled

  Ctrl+C stops the session (and only the processes this script started).
EOF

# Stream the log: ours by default, everything with --verbose.
# The filter goes through a process substitution rather than a pipeline, so that
# $! is tail's own pid: `cmd | grep &` records grep, and the orphaned tail then
# outlives cleanup still holding this terminal's stdout open. --pid=$$ is a
# second belt: tail also exits on its own once this script is gone.
if [[ $VERBOSE -eq 1 ]]; then
  tail -n +1 -f --pid=$$ "$SHELL_LOG" &
else
  tail -n +1 -f --pid=$$ "$SHELL_LOG" \
    > >(grep --line-buffered -iE 'searchdoessearch|search-does-search|JS ERROR|GJS ERROR') &
fi
TAIL_PID=$!

if [[ "$TIMEOUT" -gt 0 ]]; then
  info "Auto-shutdown in ${TIMEOUT}s"
  ( sleep "$TIMEOUT"; kill -TERM $$ 2>/dev/null ) &
fi

# Exit when the shell does; the EXIT trap tears the rest down.
wait "$SHELL_PID" || true
warn "The nested shell exited"
