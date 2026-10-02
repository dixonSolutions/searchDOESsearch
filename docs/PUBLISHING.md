# Publishing Guide — Search Does Search

This project ships through three channels, in descending order of how much we
push people at them:

| Channel | What it gives the user | Built by |
|---|---|---|
| **APT and DNF repositories** on GitHub Pages | System-wide install, upgrades arriving with the rest of their system updates, and a declared dependency on the WebKit2 4.1 typelib the renderer needs | `.github/workflows/pages.yml` |
| **extensions.gnome.org** | Per-user install and GNOME's own automatic updates | `release.yml`, on merging a version bump |
| **GitHub Releases** (`.zip`, `.deb`, `.rpm`) | A download with no repository and no root, for people who want neither of the above — but nothing updates it for them | `release.yml`, on merging a version bump |

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
- [ ] Works across all listed `shell-version` values — `compat.yml` runs each one
      live, and fails if one is listed without a test image
- [ ] No `shell-version` newer than the latest stable Shell (plus at most one
      development release): EGO rejects claims on future versions
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

## Releasing

A release is a pull request that changes `version-name`:

```bash
git switch -c release-1.1.0 origin/main
scripts/release.sh bump 1.1.0     # metadata.json, package.json, package-lock.json
git push -u origin release-1.1.0  # and open the pull request
```

Merging it does the rest. On every push to `main`, `release.yml` reads
`version-name`; if there is no `v<version-name>` tag yet, that commit is a
release:

1. **package** — type-check, `make pack`, the `.deb` and `.rpm`, and the content
   checks. On every pull request too, along with a check that the three
   version fields agree.
2. **compat** — `compat.yml`, called from the release: every Shell in
   `shell-version`, started headless in a distribution image that ships it and
   driven through a search. Nothing is published unless all of them pass.
3. **github-release** — creates the `v<version>` tag on the tested commit and
   the GitHub release with the zip, `.deb` and `.rpm` attached.
4. **extensions-gnome-org** — uploads the *same* zip to EGO's review queue with
   `gnome-extensions upload`. That command is new in GNOME 49 and
   `ubuntu-latest` ships 46, so the job runs in an `ubuntu:26.04` container.

`pages.yml` publishes the APT and DNF repositories from the same push, as it
does for every commit to `main`.

A failed release retries itself: the tag is only created in step 3, so the next
push to `main` (or re-running the workflow) finds the version still untagged.
To upload a commit's zip to EGO again (after a rejected review, say), dispatch
`release.yml` with **publish_ego**; it still runs the compat matrix first.

### One-time setup

1. **The EGO account.** Create one at
   [extensions.gnome.org](https://extensions.gnome.org/accounts/register/). The
   upload logs in with a username and password (`/api/v1/accounts/login/`):
   EGO has no API tokens, so use an account you can afford to hand to CI.
2. **The `extensions.gnome.org` environment.** *Settings → Environments → New
   environment*, named exactly that, with secrets `EGO_USER` and
   `EGO_PASSWORD`. Only a job that names the environment can read them, and
   only this one does. Add yourself as a **required reviewer** if you want
   to look at the GitHub release before the upload goes out: the job then
   waits for a click.
3. **The first upload.** EGO creates the extension page from the first
   upload. It can come from CI like any other; if the API turns away a UUID it
   has never seen, upload that one zip by hand at
   [extensions.gnome.org/upload](https://extensions.gnome.org/upload/) and let
   CI take every later one. Add the screenshot and description on the page
   while it waits for review.

### What review means for the automation

Every upload goes to a person. A version is not visible to users until it is
approved, which takes from days to a few weeks, and EGO numbers the versions
itself (the integer `version` field; never set it in `metadata.json`, the
package job fails if it is there). Two consequences:

- Keep one upload in the queue at a time. A newer upload makes the pending one
  moot, and the reviewer starts over on the new one.
- A Shell-version-only release (adding `"52"` in March) is cheap to review but
  is still a review: bump `version-name` for it like any other release.

### Supporting a new GNOME release

Twice a year, around March and September:

1. The `next` job in `compat.yml` runs the extension on `fedora:rawhide` with
   the version check off, weekly. When it goes red, the next Shell has broken
   something; read the [porting guide](https://gjs.guide/extensions/upgrading/)
   for that version.
2. Once the Shell is **released**, add its number to `shell-version` and add
   the image that ships it to the map in `compat.yml` — the build fails until
   both are there. EGO rejects a claim on an unreleased Shell (one development
   release at most), so do not add it early.
3. Release as above.

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

Full guidelines: [gjs.guide/extensions/review-guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)

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
