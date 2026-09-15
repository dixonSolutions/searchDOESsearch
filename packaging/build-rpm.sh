#!/usr/bin/env bash
# Build the .rpm from an already-built dist/ tree.
#
#   ./packaging/build-rpm.sh [OUTDIR]     (default: build/packages)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/packaging/common.sh"

OUT_DIR="${1:-${ROOT}/build/packages}"
DIST_DIR="${ROOT}/dist/${UUID}"
TOPDIR="${ROOT}/build/rpmbuild"

[[ -d "$DIST_DIR" ]] || { echo "build-rpm: no dist tree at $DIST_DIR — run 'make build' first" >&2; exit 1; }

rm -rf "$TOPDIR"
mkdir -p "${TOPDIR}"/{BUILD,RPMS,SOURCES,SPECS,SRPMS} "$OUT_DIR"

# %setup -q -c unpacks into a directory it creates, so the tarball is flat: the
# extension's files at the top level, plus the docs the %files section installs.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r "${DIST_DIR}/." "${STAGE}/"
cp "${ROOT}/LICENSE" "${ROOT}/README.md" "${STAGE}/"
tar -czf "${TOPDIR}/SOURCES/${PKG_NAME}-${VERSION}.tar.gz" -C "$STAGE" .

rpmbuild \
  --define "_topdir ${TOPDIR}" \
  --define "sds_version ${VERSION}" \
  --define "sds_release ${RELEASE}" \
  --define "dist %{nil}" \
  -bb "${ROOT}/packaging/${PKG_NAME}.spec" >"${TOPDIR}/rpmbuild.log" 2>&1 || {
    echo "build-rpm: rpmbuild failed" >&2
    tail -40 "${TOPDIR}/rpmbuild.log" >&2
    exit 1
  }

RPM="$(find "${TOPDIR}/RPMS" -name '*.rpm' -print -quit)"
[[ -n "$RPM" ]] || { echo "build-rpm: rpmbuild produced no package" >&2; exit 1; }

cp "$RPM" "$OUT_DIR/"
echo "${OUT_DIR}/$(basename "$RPM")"
