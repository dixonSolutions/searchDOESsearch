# Publishing Guide — Search Does Search

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
| Missing schema XML | Pack with `gnome-extensions pack --schema=...` |
| Using deprecated APIs | Check the GNOME Shell changelog for your target versions |
| Hardcoded paths or assumptions | Use GIO APIs; never assume `/usr/bin/firefox` etc. |
