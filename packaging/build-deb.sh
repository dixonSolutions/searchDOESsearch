#!/usr/bin/env bash
# Build the .deb from an already-built dist/ tree.
#
# Produces an Architecture: all package — the extension is JavaScript, and the
# renderer is GJS, so there is nothing compiled to vary by architecture.
#
#   ./packaging/build-deb.sh [OUTDIR]     (default: build/packages)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/packaging/common.sh"

OUT_DIR="${1:-${ROOT}/build/packages}"
DIST_DIR="${ROOT}/dist/${UUID}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[[ -d "$DIST_DIR" ]] || { echo "build-deb: no dist tree at $DIST_DIR — run 'make build' first" >&2; exit 1; }

# ── Payload ─────────────────────────────────────────────────────────────────
install -d "${STAGE}${EXT_INSTALL_DIR}" "${STAGE}${SCHEMA_INSTALL_DIR}"
cp -r "${DIST_DIR}/." "${STAGE}${EXT_INSTALL_DIR}/"

# A system extension must have no schemas/ subfolder: gnome-shell only falls
# back to its own prefix when the extension directory does not carry one, and a
# stale local copy would shadow the packaged schema after an upgrade.
mv "${STAGE}${EXT_INSTALL_DIR}/schemas/${SCHEMA_FILE}" "${STAGE}${SCHEMA_INSTALL_DIR}/${SCHEMA_FILE}"
rm -rf "${STAGE}${EXT_INSTALL_DIR}/schemas"
# Source maps point at src/*.ts, which is not shipped; they only bloat the package.
find "${STAGE}${EXT_INSTALL_DIR}" -name '*.js.map' -delete

install -d "${STAGE}/usr/share/doc/${PKG_NAME}"
install -m644 "${ROOT}/README.md" "${STAGE}/usr/share/doc/${PKG_NAME}/README.md"
install -m644 "${ROOT}/LICENSE" "${STAGE}/usr/share/doc/${PKG_NAME}/copyright"

# dist/ inherits the developer's umask (often 0664) and mktemp -d makes the root
# 0700; a package must carry the same modes on every machine that builds it.
chmod 755 "$STAGE"
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
# The renderer carries a shebang, so it is a script and must look like one.
chmod 755 "${STAGE}${EXT_INSTALL_DIR}/panel/sds-renderer.js"

INSTALLED_SIZE="$(du -sk "$STAGE" | cut -f1)"

# ── Control ─────────────────────────────────────────────────────────────────
install -d "${STAGE}/DEBIAN"
{
  echo "Package: ${PKG_NAME}"
  echo "Version: ${VERSION}"
  echo "Architecture: all"
  echo "Maintainer: ${MAINTAINER}"
  echo "Installed-Size: ${INSTALLED_SIZE}"
  echo "Depends: gnome-shell (>= 48~), gjs, gir1.2-webkit2-4.1, gir1.2-gtk-3.0"
  echo "Recommends: xdg-utils"
  echo "Section: gnome"
  echo "Priority: optional"
  echo "Homepage: ${HOMEPAGE}"
  echo "Description: ${SUMMARY}"
  sed 's/^$/./; s/^/ /' <<<"${DESCRIPTION}"
} > "${STAGE}/DEBIAN/control"

cat > "${STAGE}/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e

if [ "$1" = configure ]; then
    # libglib2.0-0 owns a file trigger on this directory, so this is usually
    # redundant — but derivatives without the trigger would otherwise install a
    # schema gnome-shell cannot read, and recompiling twice costs nothing.
    if command -v glib-compile-schemas >/dev/null 2>&1; then
        glib-compile-schemas /usr/share/glib-2.0/schemas || true
    fi

    cat <<'EOM'

Search Does Search is installed system-wide but not enabled.

  gnome-extensions enable search-does-search@searchdoessearch.github.io

A new system extension is only picked up by a fresh session: log out and back
in (Wayland), or Alt+F2 then 'r' (X11), before enabling it.
EOM
fi

exit 0
POSTINST
chmod 755 "${STAGE}/DEBIAN/postinst"

cat > "${STAGE}/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e

if [ "$1" = remove ] || [ "$1" = purge ]; then
    if command -v glib-compile-schemas >/dev/null 2>&1; then
        glib-compile-schemas /usr/share/glib-2.0/schemas || true
    fi
fi

exit 0
POSTRM
chmod 755 "${STAGE}/DEBIAN/postrm"

# ── Build ───────────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
# Drop older builds of this package: leaving them means a later step can pick up
# a stale version, and publishing yesterday's package is worse than failing.
find "$OUT_DIR" -maxdepth 1 -name "${PKG_NAME}_*.deb" -delete
DEB="${OUT_DIR}/${PKG_NAME}_${VERSION}-${RELEASE}_all.deb"
# Reproducible: dpkg-deb stamps mtimes, so pin them to the source commit date.
SOURCE_DATE="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --pretty=%ct 2>/dev/null || date +%s)}"
find "$STAGE" -exec touch -h -d "@${SOURCE_DATE}" {} +
dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null

echo "$DEB"
