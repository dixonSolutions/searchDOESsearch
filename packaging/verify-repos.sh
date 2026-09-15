#!/usr/bin/env bash
# Verify a built Pages site the way a client will: serve it over HTTP, check both
# signatures against the published key alone, and make apt actually consume it.
#
# This runs in CI before the site is deployed. A repository that builds but whose
# signature does not verify is worse than no repository — every user's next
# `apt update` fails, and they cannot tell an expired key from a compromise.
#
#   ./packaging/verify-repos.sh [--site DIR] [--port N]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/packaging/common.sh"

SITE="${ROOT}/build/pages"
PORT=8899
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) SITE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "verify-repos: unknown option $1" >&2; exit 2 ;;
  esac
done

[[ -f "${SITE}/KEY.gpg" ]] || { echo "verify-repos: no KEY.gpg in ${SITE}" >&2; exit 1; }

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }

echo "verify-repos: checking ${SITE}"

# ── Signatures, against nothing but the published public key ────────────────
# gpgv takes a keyring, not a keybox, so dearmour into one first. Using only
# KEY.gpg proves a user who trusts that URL can verify what we publish.
KEYRING="${WORK}/trusted.gpg"
gpg --batch --yes --dearmor --output "$KEYRING" < "${SITE}/KEY.gpg"

gpgv --keyring "$KEYRING" "${SITE}/deb/dists/stable/InRelease" >/dev/null 2>&1 \
  && pass "apt InRelease signature verifies" || fail "apt InRelease signature does NOT verify"

gpgv --keyring "$KEYRING" "${SITE}/deb/dists/stable/Release.gpg" "${SITE}/deb/dists/stable/Release" >/dev/null 2>&1 \
  && pass "apt Release.gpg signature verifies" || fail "apt Release.gpg signature does NOT verify"

gpgv --keyring "$KEYRING" "${SITE}/rpm/repodata/repomd.xml.asc" "${SITE}/rpm/repodata/repomd.xml" >/dev/null 2>&1 \
  && pass "dnf repomd.xml signature verifies" || fail "dnf repomd.xml signature does NOT verify"

# ── The .rpm header signature, checked against an rpmdb holding only our key ──
RPM_FILE="$(find "${SITE}/rpm" -maxdepth 1 -name '*.rpm' -print -quit)"
[[ -n "$RPM_FILE" ]] || fail "no .rpm in ${SITE}/rpm"
RPMDB="${WORK}/rpmdb"
mkdir -p "$RPMDB"
rpm --dbpath "$RPMDB" --initdb
rpm --dbpath "$RPMDB" --import "${SITE}/KEY.gpg"
RPM_REPORT="$(rpm --dbpath "$RPMDB" -Kv "$RPM_FILE" 2>&1 || true)"
if grep -qi 'nokey\|not ok\|BAD' <<<"$RPM_REPORT"; then
  echo "$RPM_REPORT" >&2
  fail "rpm signature does not verify against the published key"
fi
grep -qi 'signature.*: ok\|signature, key id.*: ok' <<<"$RPM_REPORT" \
  && pass "rpm header signature verifies against the published key" \
  || { echo "$RPM_REPORT" >&2; fail "rpm carries no verifiable signature"; }

# ── apt, for real ───────────────────────────────────────────────────────────
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SITE" >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${PORT}/KEY.gpg" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:${PORT}/KEY.gpg" >/dev/null || fail "test HTTP server never came up"

APT_ROOT="${WORK}/apt"
mkdir -p "${APT_ROOT}"/etc/apt/{sources.list.d,preferences.d,apt.conf.d,trusted.gpg.d} \
         "${APT_ROOT}"/var/lib/apt/lists/partial \
         "${APT_ROOT}"/var/lib/dpkg \
         "${APT_ROOT}"/var/cache/apt/archives/partial
: > "${APT_ROOT}/var/lib/dpkg/status"
cp "$KEYRING" "${APT_ROOT}/etc/apt/trusted.gpg.d/searchdoessearch.gpg"
cat > "${APT_ROOT}/etc/apt/sources.list.d/searchdoessearch.sources" <<SOURCES
Types: deb
URIs: http://127.0.0.1:${PORT}/deb
Suites: stable
Components: main
Architectures: all amd64
Signed-By: ${APT_ROOT}/etc/apt/trusted.gpg.d/searchdoessearch.gpg
SOURCES

apt_opts=(
  -o "Dir=${APT_ROOT}"
  -o "Dir::State=${APT_ROOT}/var/lib/apt"
  -o "Dir::State::status=${APT_ROOT}/var/lib/dpkg/status"
  -o "Dir::Cache=${APT_ROOT}/var/cache/apt"
  -o "Dir::Etc=${APT_ROOT}/etc/apt"
  -o "Dir::Etc::sourcelist=${APT_ROOT}/etc/apt/sources.list.d/searchdoessearch.sources"
  -o "Dir::Etc::sourceparts=/dev/null"
  -o "Dir::Etc::trusted=${APT_ROOT}/etc/apt/trusted.gpg.d/searchdoessearch.gpg"
  -o "Dir::Etc::trustedparts=${APT_ROOT}/etc/apt/trusted.gpg.d"
  -o "Debug::NoLocking=1"
  -o "APT::Sandbox::User=root"
  -o "APT::Get::AllowUnauthenticated=0"
)

UPDATE_LOG="${WORK}/apt-update.log"
if ! apt-get "${apt_opts[@]}" update >"$UPDATE_LOG" 2>&1; then
  cat "$UPDATE_LOG" >&2
  fail "apt-get update against the repository failed"
fi
if grep -qiE 'NO_PUBKEY|not signed|GPG error|is not trusted' "$UPDATE_LOG"; then
  cat "$UPDATE_LOG" >&2
  fail "apt does not trust the repository signature"
fi
pass "apt-get update succeeds and the repository is trusted"

POLICY="$(apt-cache "${apt_opts[@]}" policy "$PKG_NAME" 2>/dev/null || true)"
grep -q "Candidate: ${VERSION}" <<<"$POLICY" \
  && pass "apt offers ${PKG_NAME} ${VERSION}" \
  || { echo "$POLICY" >&2; fail "apt does not offer ${PKG_NAME} ${VERSION}"; }

# Downloading proves the pool path, size and checksum in Packages are all right.
( cd "$WORK" && apt-get "${apt_opts[@]}" download "$PKG_NAME" >/dev/null 2>&1 ) \
  && pass "apt downloads the package and its checksum matches" \
  || fail "apt could not download the package (pool path or checksum is wrong)"

echo "verify-repos: all checks passed"
