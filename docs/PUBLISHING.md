# Publishing Guide — Search Does Search

This project ships through three channels, in descending order of how much we
push people at them:

| Channel | What it gives the user | Built by |
|---|---|---|
| **APT and DNF repositories** on GitHub Pages | System-wide install, upgrades arriving with the rest of their system updates, and a declared dependency on the WebKit2 4.1 typelib the renderer needs | `.github/workflows/pages.yml` |
| **extensions.gnome.org** | Per-user install and GNOME's own automatic updates | `release.yml`, dispatched with `publish_ego` |
| **GitHub Releases** (`.zip`, `.deb`, `.rpm`) | A download with no repository and no root, for people who want neither of the above — but nothing updates it for them | `release.yml` on a `v*` tag |

---

## The package repositories

`packaging/` builds both repositories into one Pages site:

```
/                        index.html — the install instructions users land on
/KEY.gpg                 the public signing key, fetched by apt and dnf alike
/deb/dists/stable/...    APT: InRelease, Release.gpg, Packages per architecture
/deb/pool/main/g/...     the .deb itself
/rpm/repodata/...        DNF: repomd.xml + repomd.xml.asc
/rpm/*.rpm               the .rpm, header-signed with the same key
/searchdoessearch.repo   a drop-in for /etc/yum.repos.d
```

Locally:

```bash
make deb rpm
make repos SDS_KEY_ID=<your key id>
make verify-repos
```

`make verify-repos` is the one that matters. It serves the site over HTTP,
verifies both signatures using nothing but the published `KEY.gpg`, checks the
`.rpm` against an rpmdb holding only that key, and then makes a real `apt-get
update` consume the repository and download the package. A repository that
builds but does not verify is worse than no repository: every user's next
`apt update` fails, and they cannot tell an expired key from a compromise.

### System scope, and what it costs

A packaged extension installs to `/usr/share/gnome-shell/extensions/`. That is
what lets apt and dnf own the upgrade, and it has three consequences worth
stating plainly:

- GNOME's own extension updater will not touch it. The distribution is the
  update channel now.
- A user cannot uninstall it individually, only disable it. On rpm-ostree
  systems it needs layering.
- It must ship **no** `schemas/` subfolder inside the extension directory.
  `gnome-shell` falls back to its own prefix for a system extension only when
  the directory carries none (`sharedInternals.js`, `getSettings`), so a
  packaged local copy would silently shadow the upgraded schema. Both package
  builders move the schema to `/usr/share/glib-2.0/schemas` and `release.yml`
  fails the build if either package regrows one.

The packages deliberately do not enable the extension. A new system extension
is only picked up by a fresh session, so the postinst tells the user to log out
and run `gnome-extensions enable`.

---

## The signing key

One key signs the APT `Release`, the DNF `repomd.xml` and the `.rpm` header. Its
public half is committed as `packaging/KEY.gpg` **and** served from the Pages
site, so a user can fetch it from either and compare fingerprints. CI checks the
two match and fails the build if a rotation left the tree behind.

Create it once, and give GitHub Actions the private half:

```bash
gpg --batch --gen-key <<'BATCH'
%no-protection
Key-Type: RSA
Key-Length: 4096
Name-Real: Search Does Search Repository Signing
Name-Email: repo-signing@searchdoessearch.github.io
Expire-Date: 0
%commit
BATCH

KEY_ID=$(gpg --batch --with-colons --list-secret-keys --keyid-format LONG \
  repo-signing@searchdoessearch.github.io | awk -F: '$1 == "sec" { print $5; exit }')

gpg --armor --export "$KEY_ID" > packaging/KEY.gpg      # commit this
gpg --armor --export-secret-keys "$KEY_ID" > .repo-signing-private.asc  # never commit; back it up

gh secret set SDS_GPG_PRIVATE_KEY < .repo-signing-private.asc
printf '%s' "$KEY_ID" | gh secret set SDS_GPG_KEY_ID
```

`.repo-signing-private.asc` is gitignored. It is the only thing that cannot be
regenerated: losing it means every existing client has to import a new key by
hand, which looks exactly like an attack from where they are standing.

Rotating the key means re-running the above with a new key, committing the new
`packaging/KEY.gpg`, and telling users — there is no graceful rotation for a
repository signing key.

---

## Publishing to extensions.gnome.org (EGO)

Extensions hosted at [extensions.gnome.org](https://extensions.gnome.org) go through a **manual code review** by GNOME maintainers. This guide walks through the requirements and submission process.

---

## Pre-Submission Checklist

### Required
- [ ] `metadata.json` has a valid, unique `uuid` in `name@domain` format
- [ ] `metadata.json` lists all supported `shell-version` values
- [ ] Extension enables and disables cleanly without errors in `journalctl`
- [ ] All references are nulled in `disable()` — no memory leaks
- [ ] No use of `eval()`, `Function()`, or dynamic code execution
- [ ] Description discloses that fallback queries are sent to the configured engine
- [ ] `Gio.AppInfo.launch_default_for_uri` used (not hardcoded browser paths)
- [ ] The `.gschema.xml` source is included; GNOME 44+ compiles it on install
- [ ] No `version` field in `metadata.json` — EGO assigns it; `version-name` is ours
- [ ] Every runtime module is in the zip, `panel/sds-renderer.js` included
      (`release.yml` checks this; an extension missing it installs and does nothing)

### Reviewed as possibly machine-generated
EGO's review guidelines reject submissions showing "large amounts of unnecessary
code, inconsistent code style, imaginary API usage, comments serving as LLM
prompts, or other indications of AI-generated output". Using AI as a tool is
explicitly allowed; the bar is that the author can "justify and explain the code
they submit". Before uploading:

- [ ] No leftover "Generated with AI" notice anywhere in the zip
- [ ] No try/catch around calls that cannot throw, and no optional chaining on
      guaranteed methods
- [ ] Every `_destroyed`-style guard is one you can justify — `rendererClient.ts`
      has one, and it covers the subprocess and bus-name callbacks that its
      `Gio.Cancellable` does not
- [ ] The tree is internally consistent: no references to files that no longer
      exist, no `shell-version` claim that contradicts the README

### Recommended
- [ ] Works on both X11 and Wayland
- [ ] Works across all listed `shell-version` values
- [ ] Has a meaningful icon (uses a system symbolic icon)
- [ ] Settings defaults are sensible
- [ ] No console spam — only log on errors and lifecycle events

---

## Build the Submission Package

```bash
# 1. Final build
make build

# 2. Create the .zip package
make pack
```

This produces `search-does-search@searchdoessearch.github.io.shell-extension.zip` in the project root.

The zip must contain (at its root, not in a subfolder):
```
extension.js
searchProvider.js
browserLauncher.js
metadata.json
schemas/
schemas/org.gnome.shell.extensions.search-does-search.gschema.xml
```

---

## Automated release pipeline

Every pull request and commit to `main` runs `.github/workflows/release.yml`,
type-checks the extension, builds the ZIP, verifies its runtime contents, and
uploads the ZIP as a workflow artifact. A `v*` tag also creates a GitHub release.

The workflow can upload to EGO when manually dispatched with `publish_ego`
enabled. Configure repository secrets `EGO_USER` and `EGO_PASSWORD` first. The
upload accepts the EGO terms of service and still enters GNOME's manual review.

## Submit to extensions.gnome.org

1. Create an account at [extensions.gnome.org](https://extensions.gnome.org)
2. Go to [extensions.gnome.org/upload](https://extensions.gnome.org/upload/)
3. Upload the `.zip` file
4. Fill in the description, screenshots, and changelog
5. Submit for review

**Review timeline:** Manual review typically takes **a few days to a few weeks** depending on maintainer availability.

---

## Review Requirements (from GNOME Guidelines)

The GNOME review team checks for:

| Category | What they look for |
|---|---|
| **Security** | No `eval()`, no arbitrary code execution, no unsafe subprocess calls |
| **Privacy** | No data sent to external servers without user consent |
| **API correctness** | Only public GNOME Shell APIs used (no `_private` member access) |
| **Lifecycle** | Clean enable/disable with no lingering state |
| **Compatibility** | Works with all listed shell versions |
| **Code quality** | Readable, maintainable code |

Full guidelines: [wiki.gnome.org/Projects/GnomeShell/Extensions/ReviewGuidelines](https://wiki.gnome.org/Projects/GnomeShell/Extensions/ReviewGuidelines)

---

## Versioning

When publishing updates:

1. Bump `version` (integer) in `metadata.json`
2. Update `version-name` (string) for human display
3. Rebuild and repackage
4. Upload the new zip on EGO — it will go through review again

```json
{
  "version": 2,
  "version-name": "1.1.0"
}
```

---

## GitHub Releases (Recommended)

Keep releases on GitHub alongside EGO submissions so users can track changes:

```bash
git tag v1.0.0
git push origin v1.0.0
# Then create a GitHub Release and attach the .zip
```

---

## Common Rejection Reasons

| Issue | Fix |
|---|---|
| Accessing `_private` GNOME Shell members | Use only public API |
| `disable()` doesn't clean up properly | Null all stored references and disconnect all signals |
| Missing schema XML | Pack with `gnome-extensions pack --schema=...` (`make pack` does) |
| A subprocess the reviewer did not expect | Say up front why the renderer is out-of-process: the Shell cannot host WebKit. It is spawned with `spawnv`, no shell, and the only shell-side spawn is `xdg-open` with `GLib.shell_quote` |
| Using deprecated APIs | Check the GNOME Shell changelog for your target versions |
| Hardcoded paths or assumptions | Use GIO APIs; never assume `/usr/bin/firefox` etc. |
