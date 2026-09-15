#!/usr/bin/env bash
# Render the landing page for the Pages site: the install instructions a user
# lands on when they visit the repository URL, and the key fingerprint they can
# check the signature against.
#
#   ./packaging/render-index.sh <OUT_DIR> <KEY_FPR> <DEB_NAME> <RPM_NAME>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT}/packaging/common.sh"

OUT_DIR="$1"; KEY_FPR="$2"; DEB_NAME="$3"; RPM_NAME="$4"
# Grouped in fours, the way gpg prints it, so it can be compared by eye.
FPR_PRETTY="$(echo "$KEY_FPR" | sed 's/.\{4\}/& /g; s/ $//')"

cat > "${OUT_DIR}/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Search Does Search — package repositories</title>
<style>
  :root { color-scheme: light dark; --fg:#16181d; --bg:#fbfbfa; --muted:#5b6170;
          --line:#e2e2df; --code-bg:#f2f2ef; --accent:#3a5bc7; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e6e7ea; --bg:#16181d; --muted:#9aa1b0; --line:#2b2f38;
            --code-bg:#1f232b; --accent:#8fa9ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 ui-sans-serif,system-ui,"Cantarell",sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 5rem; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing:-.02em; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; }
  p.tagline { color: var(--muted); margin: 0 0 2rem; font-size: 1.05rem; }
  pre { background: var(--code-bg); border:1px solid var(--line); border-radius: 8px;
        padding: .85rem 1rem; overflow-x: auto; font-size: .875rem; line-height:1.5; }
  code { font-family: ui-monospace,"JetBrains Mono",monospace; }
  a { color: var(--accent); }
  .fpr { font-family: ui-monospace,monospace; font-size:.8rem; word-break: break-all; color: var(--muted); }
  footer { margin-top: 3rem; padding-top: 1.25rem; border-top:1px solid var(--line); color:var(--muted); font-size:.875rem; }
</style>
<main>
  <h1>Search Does Search</h1>
  <p class="tagline">${SUMMARY} — a glance at a results page without opening a
  browser. Signed package repositories for APT and DNF.</p>

  <h2>Debian / Ubuntu</h2>
<pre><code>sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL ${PAGES_URL}/KEY.gpg | sudo tee /etc/apt/keyrings/searchdoessearch.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/searchdoessearch.asc] ${PAGES_URL}/deb stable main" \\
  | sudo tee /etc/apt/sources.list.d/searchdoessearch.list > /dev/null
sudo apt update
sudo apt install ${PKG_NAME}</code></pre>

  <h2>Fedora / RHEL / openSUSE</h2>
<pre><code>sudo curl -fsSL -o /etc/yum.repos.d/searchdoessearch.repo ${PAGES_URL}/searchdoessearch.repo
sudo dnf install ${PKG_NAME}</code></pre>

  <h2>Then enable it</h2>
  <p>A packaged extension is installed system-wide but never enabled for you.
  Log out and back in so the new session picks it up, then:</p>
<pre><code>gnome-extensions enable ${UUID}</code></pre>

  <h2>Signing key</h2>
  <p>Both repositories are signed by this key, published at
  <a href="${PAGES_URL}/KEY.gpg">KEY.gpg</a>:</p>
  <p class="fpr">${FPR_PRETTY}</p>

  <h2>Direct downloads</h2>
  <p>Prefer no repository at all? Every release carries the same artifacts:
  <a href="${HOMEPAGE}/releases/latest">GitHub Releases</a> — the
  <code>.shell-extension.zip</code> for a per-user install, plus
  <a href="${PAGES_URL}/deb/pool/main/g/${PKG_NAME}/${DEB_NAME}">${DEB_NAME}</a>
  and <a href="${PAGES_URL}/rpm/${RPM_NAME}">${RPM_NAME}</a>.</p>

  <footer>
    <a href="${HOMEPAGE}">Source on GitHub</a> · version ${VERSION} · MIT
  </footer>
</main>
HTML

echo "render-index: wrote ${OUT_DIR}/index.html"
