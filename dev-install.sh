#!/usr/bin/env bash
# dev-install.sh
#
# Builds and installs the extension locally for testing.
# Runs entirely offline — no publishing required.
#
# Usage:
#   ./dev-install.sh           — build, install, enable
#   ./dev-install.sh --uninstall   — disable and remove
#   ./dev-install.sh --logs        — tail live GNOME Shell logs
#   ./dev-install.sh --status      — show extension state

set -euo pipefail

UUID="search-does-search@searchdoessearch.github.io"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
DIST_DIR="$(cd "$(dirname "$0")" && pwd)/dist/$UUID"

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}→${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Helpers ─────────────────────────────────────────────────────────────────

check_deps() {
  local missing=()
  for cmd in node npm glib-compile-schemas gnome-extensions; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing required tools: ${missing[*]}"
    echo "  Install with: sudo apt install nodejs npm libglib2.0-bin gnome-shell-extension-manager"
    exit 1
  fi
}

build() {
  header "Building extension…"

  info "Compiling TypeScript → JavaScript"
  npm run compile

  info "Compiling GSettings schema"
  glib-compile-schemas "$DIST_DIR/schemas/"

  success "Build complete"
}

install_ext() {
  header "Installing to $INSTALL_DIR"

  mkdir -p "$INSTALL_DIR"
  cp -r "$DIST_DIR/." "$INSTALL_DIR/"

  success "Files copied"
}

enable_ext() {
  header "Enabling extension…"

  # gnome-extensions enable only works if the extension directory exists
  if gnome-extensions enable "$UUID" 2>/dev/null; then
    success "Extension enabled"
  else
    warn "Could not enable via gnome-extensions (may need a shell restart first)"
    echo "  After restarting the shell, run: gnome-extensions enable $UUID"
  fi
}

restart_hint() {
  header "Restart GNOME Shell to pick up changes"
  echo ""
  echo -e "  ${BOLD}Wayland (Ubuntu default):${RESET}"
  echo "    Log out and back in, OR open a new terminal and run:"
  echo -e "    ${CYAN}dbus-run-session -- gnome-shell --nested --wayland${RESET}"
  echo ""
  echo -e "  ${BOLD}X11:${RESET}"
  echo "    Press Alt+F2, type 'r', press Enter"
  echo ""
  echo -e "  After restarting, enable the extension:"
  echo -e "    ${CYAN}gnome-extensions enable $UUID${RESET}"
  echo ""
}

uninstall_ext() {
  header "Uninstalling extension…"
  gnome-extensions disable "$UUID" 2>/dev/null && success "Disabled" || true
  if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    success "Removed $INSTALL_DIR"
  else
    warn "Nothing to remove — extension was not installed"
  fi
}

show_logs() {
  header "Tailing GNOME Shell logs (Ctrl+C to stop)…"
  echo -e "  Filtering for: ${CYAN}SearchDoesSearch${RESET}\n"
  journalctl -f -o cat /usr/bin/gnome-shell \
    | grep --line-buffered -i "SearchDoesSearch\|search-does-search\|GJS ERROR\|JS ERROR"
}

show_status() {
  header "Extension status"
  if [[ -d "$INSTALL_DIR" ]]; then
    success "Installed at: $INSTALL_DIR"
    ls "$INSTALL_DIR"
    echo ""
    gnome-extensions info "$UUID" 2>/dev/null || warn "gnome-extensions info failed (shell may need restart)"
  else
    warn "Not installed (run ./dev-install.sh to install)"
  fi
}

# ── Entry point ──────────────────────────────────────────────────────────────

case "${1:-}" in
  --uninstall)
    uninstall_ext
    ;;
  --logs)
    show_logs
    ;;
  --status)
    show_status
    ;;
  --help|-h)
    echo "Usage: $0 [--uninstall | --logs | --status | --help]"
    echo ""
    echo "  (no args)     Build, install, and enable the extension locally"
    echo "  --uninstall   Disable and remove the local installation"
    echo "  --logs        Tail live GNOME Shell logs filtered to this extension"
    echo "  --status      Show install location and extension state"
    ;;
  "")
    check_deps
    build
    install_ext
    enable_ext
    restart_hint
    ;;
  *)
    error "Unknown option: $1  (try --help)"
    exit 1
    ;;
esac
