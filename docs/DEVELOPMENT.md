# Development Guide — Search Does Search

## Prerequisites

Install the following before starting:

```bash
# Node.js 20+ (for TypeScript tooling)
node --version   # should be >= 20

# GNOME Shell development tools
sudo apt install gnome-shell-extension-tool libglib2.0-dev-bin

# GJS (usually pre-installed on Ubuntu with GNOME)
gjs --version
```

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

After restart, open Activities (Super key) and type anything — you should see a "Search the web for..." card.

---

## Daily Development Loop

```bash
# Edit TypeScript source files in src/
# Then rebuild and reinstall:
make install

# On X11, restart the shell without logging out:
make restart

# On Wayland, run a nested GNOME Shell session instead:
dbus-run-session -- gnome-shell --nested --wayland
```

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
logError(error, '[SearchDoesSearch] description');
```

These all appear in `journalctl`.

### Looking Glass (GNOME Shell Inspector)

Press `Alt + F2`, type `lg`, and hit Enter. This opens the built-in JavaScript REPL and object inspector — useful for inspecting live shell state.

---

## Project Structure Reference

```
search-does-search/
├── src/
│   ├── extension.ts        ← enable() / disable() lifecycle
│   ├── searchProvider.ts   ← GNOME Search Provider API implementation
│   └── browserLauncher.ts  ← URL building + browser launch
├── schemas/
│   └── *.gschema.xml       ← GSettings schema (user preferences)
├── scripts/
│   └── build.mjs           ← esbuild compilation script
├── docs/
│   ├── ARCHITECTURE.md     ← How it works
│   ├── DEVELOPMENT.md      ← This file
│   └── PUBLISHING.md       ← How to publish to extensions.gnome.org
├── dist/                   ← Generated — do not edit manually
│   └── search-does-search@.../
├── metadata.json           ← Extension identity (name, uuid, shell-version)
├── package.json
├── tsconfig.json
└── Makefile
```

---

## Adding a New Search Engine

1. Open `src/browserLauncher.ts`
2. Add an entry to `SEARCH_ENGINES`:
   ```typescript
   ecosia: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`,
   ```
3. Update the GSettings schema in `schemas/*.gschema.xml` to document the new key value
4. Run `make build`

---

## Changing Preferences

The extension uses GSettings for persistent preferences. If you add a new setting:

1. Add the key to the `.gschema.xml` file
2. Compile the schema: `glib-compile-schemas dist/.../schemas/`
3. Read it in code with `this.getSettings().get_string('your-key')`
4. *(Optional)* Add a `prefs.ts` entry point for a GUI preferences panel

---

## Running Tests

There is currently no automated test runner for GJS extensions — GNOME Shell does not expose a testing harness. Manual testing steps:

1. Build and install: `make install`
2. Restart the shell
3. Open Activities, type a query
4. Verify the result card appears with correct title/description
5. Click the card — verify the default browser opens with the correct URL
6. Change the engine in GSettings and verify the URL changes:
   ```bash
   gsettings set org.gnome.shell.extensions.search-does-search search-engine google
   ```
