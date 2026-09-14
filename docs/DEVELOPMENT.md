# Development Guide — Search Does Search

## Prerequisites

Install the following before starting:

```bash
# Node.js 20+ (for TypeScript tooling)
node --version   # should be >= 20

# The renderer process (GJS + GTK3 + WebKit2)
sudo apt install gir1.2-webkit2-4.1

# GNOME Shell development tools
sudo apt install gnome-shell-extensions libglib2.0-bin

# GJS (usually pre-installed on Ubuntu with GNOME)
gjs --version
```

`make build` compiles TypeScript and assembles `dist/`; `make install` also compiles the
GSettings schema and clears the installed copy first, so a deleted module cannot linger.

---

## First-Time Setup

```bash
# 1. Clone / enter the project
cd /path/to/search-does-search

# 2. Install TypeScript dependencies
npm install

# 3. Build the extension
make build

# 4. Install it locally
make install

# 5. Enable it
make enable

# 6. Restart GNOME Shell
#    X11:    Alt + F2 → type 'r' → Enter
#    Wayland: Log out and back in (or use a nested session — see below)
```

After restart, open Activities (Super key) and type a query that local apps/files will not match — web result cards should appear after a short debounce.

---

## Daily Development Loop

```bash
# Edit TypeScript source files in src/
# Then rebuild and reinstall:
make install

# On X11, restart the shell without logging out:
make restart

# On Wayland, test the change in a nested session (see below):
make nested
```

### Testing a change without logging out (Wayland)

GNOME caches every extension's ES modules for the life of a session, so on
Wayland `gnome-extensions disable && enable` reloads nothing — changed code only
runs in a *new* session. `scripts/nested-test.sh` builds the working tree,
installs it, and starts one:

```bash
make nested                       # windowed: a devkit viewer on your desktop
make nested-headless              # no window: a virtual monitor session
./scripts/nested-test.sh --help   # all flags
```

Ctrl+C shuts the session down, stopping only the processes the script started.
The shell log is kept (its path is printed); lines from this extension are
streamed to the terminal as they arrive, or pass `--verbose` for all of them.

Useful flags:

| Flag | Why |
|------|-----|
| `--headless` | No viewer window — for SSH, a locked screen, or automated capture. |
| `--gdr[=PORT]` | `--headless` only: run `gdrd` against the session so screenshot/input tooling can drive it. |
| `--no-build` | Start a session against whatever is already installed. |
| `--debug` | `SDS_DEBUG=1` in the session: frame timings and raw scroll events. |
| `--timeout N` | Shut down after N seconds, for scripted runs. |

Two GNOME 50 traps the script exists to keep you out of:

* `--nested` no longer exists; mutter 50 dropped the X11-nested backend. The
  windowed path is `gnome-shell --headless --devkit` plus a `mutter-devkit`
  viewer launched against the **host** session. `--headless` names the backend,
  not the visibility. Plain `dbus-run-session -- gnome-shell --devkit` lets
  mutter spawn its own viewer on the *nested* `DISPLAY`, which dies on the
  MIT-MAGIC-COOKIE and takes the shell with it ~2 s later.
* Never pass `--virtual-monitor` alongside `--devkit`: devkit adds a monitor
  sized to its window and the explicit one becomes primary, so the top bar
  renders on the monitor you cannot see. Resize the window instead.

The nested session shares `~/.local/share` and dconf with the host, so it loads
the same installed extensions and the same enabled list — enabling the extension
in it also enables it on the host. Pass `--no-enable` when that matters. Stray
clicks would otherwise launch real browsers, so the session runs with
`SDS_NO_LAUNCH=1` unless you pass `--allow-launch`.

### Watching for TypeScript errors (without building)

```bash
npm run watch
# tsc runs in watch mode — errors appear immediately as you type
```

---

## Debugging

### View live extension logs

```bash
make logs
# Tails journalctl and filters for our extension's output
```

Or broader GNOME Shell output:
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

### Log from code

Inside TypeScript source files use:
```typescript
console.log('[SearchDoesSearch] message');
console.warn('[SearchDoesSearch] warning');
```

These appear in `journalctl`. The legacy `log()` global is gone in GNOME 45+ —
calling it throws a `ReferenceError`, which is especially nasty inside a `catch`
block where it masks the original error.

Never log on every keystroke, and never write to a file synchronously: both run on
the compositor thread. See [GJS-PITFALLS.md](GJS-PITFALLS.md).

### Looking Glass (GNOME Shell Inspector)

Press `Alt + F2`, type `lg`, and hit Enter. This opens the built-in JavaScript REPL and object inspector — useful for inspecting live shell state.

---

## Project Structure Reference

```
search-does-search/
├── src/
│   ├── extension.ts        ← enable() / disable() lifecycle
│   ├── searchProvider.ts   ← GNOME Search Provider (one result: the page)
│   ├── pageView.ts         ← overview actor: frame texture, input forwarding, header
│   ├── rendererClient.ts   ← spawns/talks to the renderer over D-Bus
│   ├── section.ts          ← provider column, section order, conditional visibility
│   ├── browserLauncher.ts  ← default browser launch
│   └── prefs.ts            ← preferences window
├── panel/
│   └── sds-renderer.js     ← off-screen WebKit renderer process (plain GJS, not compiled)
├── schemas/
│   └── *.gschema.xml       ← GSettings schema (user preferences)
├── scripts/
│   ├── build.mjs             ← TypeScript compile + dist assembly
│   ├── nested-test.sh        ← Build + run in a nested shell (make nested)
│   ├── keystroke-harness.js  ← Freeze regression test (make check-freeze)
│   └── provider-check.js     ← Load-decision regression test (make check-provider)
├── docs/
│   ├── ARCHITECTURE.md     ← How it works
│   ├── DEVELOPMENT.md      ← This file
│   ├── GJS-PITFALLS.md     ← Compositor-freeze postmortem + GJS rules
│   └── PUBLISHING.md       ← How to publish to extensions.gnome.org
├── dist/                   ← Generated — do not edit manually
│   └── search-does-search@.../
├── metadata.json           ← Extension identity (name, uuid, shell-version)
├── package.json
├── tsconfig.json
└── Makefile
```

---

## Changing Which Engine Is Rendered

The engine list is `ENGINES` in `panel/sds-renderer.js` (the SERP URL, the hosts
its own redirects may use, the URL patterns its stylesheet is scoped to, and how
its block page is recognised) with the matching label and browser URL in
`src/pageView.ts`. Adding one means adding a CSS rule set in `pageCss()` too —
the page is stripped to its results, and every engine's markup differs.

**Do not add a direct-scraping backend here.** It was tried and removed. Only
DuckDuckGo's HTML endpoint held up; everything else rate-limited, CAPTCHA'd, or
rebuilt its markup. Google cannot be scraped at all — it gates `/search` on the
JavaScript runtime environment and refuses a real browser engine with a warm
session on its first request, so no user-agent, cookie, delay, or headless-browser
trick reaches it. The measurements are in [GJS-PITFALLS.md](GJS-PITFALLS.md); read
them before proposing an exception.

---

## Changing Preferences

The extension uses GSettings for persistent preferences. If you add a new setting:

1. Add the key to the `.gschema.xml` file
2. Compile the schema: `glib-compile-schemas dist/.../schemas/`
3. Read it in code with `this.getSettings().get_string('your-key')`
4. Add the key to `src/prefs.ts` (the preferences window) if users should see it

---

## Running Tests

**Read [GJS-PITFALLS.md](GJS-PITFALLS.md) before touching the search path.** An
extension runs inside the compositor, so a blocked main loop freezes the whole
machine — that has already happened once here, and the checks below exist to stop
it happening again.

```bash
make check           # everything below
make check-freeze    # cancel-per-keystroke must never block the calling thread
make check-provider  # a page load is issued exactly when it should be
```

`make check-freeze` drives the built provider exactly as GNOME Shell does: it
cancels the in-flight search on every keystroke. A regression **hangs** instead of
failing fast, which is why it runs under `timeout` and reports exit code 124 as a
deadlock.

`make check-provider` drives the provider with a fake renderer and a fake view and
asserts the three rules about when a page is loaded — once per settled burst, not
again for terms already showing, but again if the user has followed links away
from the results page (without the last one, retyping your own query while three
pages deep leaves you stranded there).

Both harnesses import from `dist/`, so they test the shipped artefact rather than
the TypeScript source. They need the St and Meta typelibs, which live outside the
default search path; the Makefile supplies them.

Everything else is verified by driving a nested session (`make nested`), because
the behaviour that matters — a page that scrolls, a link that is followed, a
section that hides — only exists inside a running Shell.

### Manual verification

1. `make nested` (or `make install` and log out and in)
2. Open Activities, type a query; after you pause, the rendered page appears in the
   searchDOESsearch section, its results column centred, with no provider column
   down the left
3. Scroll the page with the wheel, hover a result (it highlights), click into the
   page and press PageDown, Tab — the page reacts
4. Click a result: it loads in place, and a back pill appears at the right of the
   header. Follow a second link: the badge reads 2. Press it (or Alt+Left, or the
   mouse's back button) until it disappears — you are back at your results, at the
   scroll position you left
5. Middle-click or Ctrl+click a link: it goes to the browser instead, and the view
   stays where it was
6. Set "Show web results" to "Only when nothing else matched": a query matching an
   app hides the section entirely; a query nothing else matches shows it
7. Switch the engine to Google in Extension Settings on a flagged network — the
   page is replaced by the "refusing this network" notice with a DuckDuckGo button

### The renderer on its own

The renderer is a normal GJS program; the extension is not needed to test it.
Environment variables it honours (development only):

| Variable | Effect |
|---|---|
| `SDS_DEBUG=1` | Logs every exported frame with read-back/write times (renderer) and map/upload times plus raw scroll events (Shell, same variable in the Shell's environment) |
| `SDS_NO_LAUNCH=1` | Report links with `Launched` but do not open a browser |
| `SDS_DUMP_HTML=<file>` | Save the page's HTML after each load and print its URI/title/text |
| `NO_AT_BRIDGE=1` | Skip the accessibility bridge; set automatically when the session has no a11y bus (nested and headless shells), where it crashes GTK |

A frame file is raw RGBA; to look at one:

```bash
gjs -m -c 'import GdkPixbuf from "gi://GdkPixbuf"; import GLib from "gi://GLib";
  const [w,h,stride] = [812,464,3248]; // from the Frame signal
  const [,d] = GLib.file_get_contents(GLib.get_user_runtime_dir()+"/searchdoessearch/frame-0.raw");
  GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(d), 0, true, 8, w, h, stride).savev("/tmp/frame.png","png",[],[]);'
```

Headless verification without touching the desktop is what `make nested-headless`
starts (`gnome-shell --headless --virtual-monitor` on a private bus paints
without any viewer). Drive it through `org.gnome.Mutter.RemoteDesktop`, keeping
one bus connection for the session's lifetime — the session dies with the
connection that created it — or pass `--gdr` to have the script run `gdrd`
against it for you.

### If the shell freezes while testing

On Wayland you cannot switch to a TTY once the compositor is wedged. Before
testing risky changes to the search path, open an SSH session from another machine
(or `systemd-run --user --scope gnome-shell --devkit` in a nested session) so you
can `pkill -HUP gnome-shell` without a hard power-off.
