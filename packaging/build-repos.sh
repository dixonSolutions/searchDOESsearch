#!/usr/bin/env bash
# Assemble the signed APT and DNF repositories that GitHub Pages serves.
#
# Both repositories live under one Pages site:
#   /deb   APT — dists/stable/main, pool/, InRelease + Release.gpg
#   /rpm   DNF — flat package dir, repodata/, repomd.xml.asc, signed packages
#   /KEY.gpg          the public signing key, which both clients fetch
#   /searchdoessearch.repo   a drop-in for /etc/yum.repos.d
#
# The signing key must already be in the keyring this runs against: locally that
# is your own GNUPGHOME, in CI a throwaway one the workflow imports the secret
# into. Everything else here is derived, so the same script produces the same
# site on a laptop and on a runner.
#
#   ./packaging/build-repos.sh --key <KEYID> --out <DIR> [--deb F] [--rpm F]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/packaging/common.sh"

KEY_ID=""
OUT_DIR="${ROOT}/build/pages"
DEB_FILE=""
RPM_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key) KEY_ID="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --deb) DEB_FILE="$2"; shift 2 ;;
    --rpm) RPM_FILE="$2"; shift 2 ;;
    *) echo "build-repos: unknown option $1" >&2; exit 2 ;;
  esac
done

[[ -n "$KEY_ID" ]] || { echo "build-repos: --key <KEYID> is required" >&2; exit 2; }

# Default to whatever the package builders just produced.
[[ -n "$DEB_FILE" ]] || DEB_FILE="$(find "${ROOT}/build/packages" -name '*.deb' -print -quit 2>/dev/null || true)"
[[ -n "$RPM_FILE" ]] || RPM_FILE="$(find "${ROOT}/build/packages" -name '*.rpm' -print -quit 2>/dev/null || true)"
[[ -f "$DEB_FILE" ]] || { echo "build-repos: no .deb found (build it first)" >&2; exit 1; }
[[ -f "$RPM_FILE" ]] || { echo "build-repos: no .rpm found (build it first)" >&2; exit 1; }

for tool in apt-ftparchive createrepo_c rpmsign gpg; do
  command -v "$tool" >/dev/null || { echo "build-repos: missing required tool: $tool" >&2; exit 1; }
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# ── The public key, which is the whole trust story ──────────────────────────
# Armoured, at a stable URL, fetched by apt (signed-by) and dnf (gpgkey) alike.
gpg --batch --yes --armor --export "$KEY_ID" > "${OUT_DIR}/KEY.gpg"
[[ -s "${OUT_DIR}/KEY.gpg" ]] || { echo "build-repos: exported an empty public key for $KEY_ID" >&2; exit 1; }
KEY_FPR="$(gpg --batch --with-colons --list-keys "$KEY_ID" | awk -F: '$1 == "fpr" { print $10; exit }')"

# ── APT ─────────────────────────────────────────────────────────────────────
APT_ROOT="${OUT_DIR}/deb"
POOL="pool/main/g/${PKG_NAME}"
mkdir -p "${APT_ROOT}/${POOL}"
cp "$DEB_FILE" "${APT_ROOT}/${POOL}/"

# Architecture: all packages belong in binary-all, but apt clients only look
# there when the Release file says so — and some still expect a per-architecture
# index to exist. Publishing the same index under each costs a few KB and
# removes a class of "no Packages file" failures on older releases.
ARCHES="all amd64 arm64"
(
  cd "$APT_ROOT"
  for arch in $ARCHES; do
    mkdir -p "dists/stable/main/binary-${arch}"
  done
  apt-ftparchive packages pool > "dists/stable/main/binary-all/Packages"
  for arch in $ARCHES; do
    [[ "$arch" == all ]] || cp "dists/stable/main/binary-all/Packages" "dists/stable/main/binary-${arch}/Packages"
    gzip -9kf "dists/stable/main/binary-${arch}/Packages"
  done

  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin="Search Does Search" \
    -o APT::FTPArchive::Release::Label="Search Does Search" \
    -o APT::FTPArchive::Release::Suite="stable" \
    -o APT::FTPArchive::Release::Codename="stable" \
    -o APT::FTPArchive::Release::Components="main" \
    -o APT::FTPArchive::Release::Architectures="${ARCHES}" \
    -o APT::FTPArchive::Release::Description="${SUMMARY}" \
    release dists/stable > "dists/stable/Release"

  # InRelease (inline signature) is what modern apt fetches; Release.gpg is kept
  # for clients that still ask for the detached form.
  gpg --batch --yes --local-user "$KEY_ID" --clearsign -o "dists/stable/InRelease" "dists/stable/Release"
  gpg --batch --yes --local-user "$KEY_ID" --armor --detach-sign -o "dists/stable/Release.gpg" "dists/stable/Release"
)

# ── DNF ─────────────────────────────────────────────────────────────────────
# Order matters: signing rewrites the package header, so it must happen before
# createrepo_c records the checksum, or every download fails verification.
RPM_ROOT="${OUT_DIR}/rpm"
mkdir -p "$RPM_ROOT"
cp "$RPM_FILE" "$RPM_ROOT/"
RPM_COPY="${RPM_ROOT}/$(basename "$RPM_FILE")"

# rpm's default %__gpg_sign_cmd already does the right thing for a key with no
# passphrase; overriding it is how you end up passing gpg an argument it reads as
# a filename. GPG_TTY is unset on a runner, and rpmsign warns about that.
GPG_TTY="" rpmsign --define "_gpg_name ${KEY_ID}" --addsign "$RPM_COPY" >/dev/null

# rpm 4.20 writes a header signature and no separate payload signature, so ask
# what the package actually carries rather than reading the Signature summary
# line, which is empty either way.
# rpm -Kv exits non-zero whenever the signing key is not in the rpm database,
# which it never is on a build machine — so capture the report and read it,
# rather than piping it and letting pipefail turn NOKEY into a build failure.
SIG_REPORT="$(rpm -Kv "$RPM_COPY" 2>&1 || true)"
if ! grep -qiE 'openpgp.*signature|(rsa|dsa)/[a-z0-9]+ signature' <<<"$SIG_REPORT"; then
  echo "build-repos: rpmsign did not sign ${RPM_COPY}" >&2
  echo "$SIG_REPORT" >&2
  exit 1
fi

createrepo_c --quiet "$RPM_ROOT"
gpg --batch --yes --local-user "$KEY_ID" --armor --detach-sign "${RPM_ROOT}/repodata/repomd.xml"

# ── Client drop-ins ─────────────────────────────────────────────────────────
cat > "${OUT_DIR}/searchdoessearch.repo" <<REPO
[searchdoessearch]
name=Search Does Search
baseurl=${PAGES_URL}/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=${PAGES_URL}/KEY.gpg
REPO

cat > "${OUT_DIR}/searchdoessearch.sources" <<SOURCES
Types: deb
URIs: ${PAGES_URL}/deb
Suites: stable
Components: main
Architectures: all amd64 arm64
Signed-By: /etc/apt/keyrings/searchdoessearch.asc
SOURCES

# Pages would otherwise run the site through Jekyll, which drops files and
# directories whose names begin with an underscore or a dot.
touch "${OUT_DIR}/.nojekyll"

bash "${ROOT}/packaging/render-index.sh" "$OUT_DIR" "$KEY_FPR" "$(basename "$DEB_FILE")" "$(basename "$RPM_FILE")"

echo "build-repos: site at ${OUT_DIR} (key ${KEY_FPR})"
