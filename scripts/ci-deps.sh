#!/usr/bin/env bash
# ci-deps.sh — install what `make check` and scripts/shell-smoke.sh need, on
# the Debian, Ubuntu and Fedora images the compat workflow runs on. As root.
#
# python3-dbusmock stands in for logind: the Shell will not start without it
# on the system bus (49+ asks for it from TimeLimitsManager at startup).
set -euo pipefail

# CI brings its own Node with actions/setup-node; Debian's npm alone is a few
# hundred packages.
NODE=(nodejs npm)
command -v npm >/dev/null && NODE=()

if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -q -y --no-install-recommends \
    ca-certificates git make unzip procps "${NODE[@]}" \
    gnome-shell gjs gir1.2-webkit2-4.1 libglib2.0-bin \
    dbus-daemon dbus-bin python3-dbusmock libgl1-mesa-dri fonts-noto-core
elif command -v dnf >/dev/null; then
  dnf -y -q install --setopt=install_weak_deps=False \
    git make unzip procps-ng findutils "${NODE[@]}" \
    gnome-shell gjs mutter webkit2gtk4.1 glib2 \
    dbus-daemon dbus-tools python3-dbusmock mesa-dri-drivers google-noto-sans-fonts
else
  echo "ci-deps.sh: neither apt-get nor dnf found" >&2
  exit 1
fi
gnome-shell --version
