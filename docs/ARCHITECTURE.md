# Architecture — Search Does Search

## Overview

Search Does Search is a GNOME Shell extension that hooks into the Activities search bar via the **GNOME Search Provider API**. When a user types a query, the extension registers a result card in the search overlay. Clicking it (or pressing Enter) opens the query in the user's default browser.

---

## Module Map

```
src/
├── extension.ts        ← Entry point. Manages the extension lifecycle.
├── searchProvider.ts   ← Implements the GNOME Search Provider interface.
└── browserLauncher.ts  ← Handles URL building and browser launching.
```

---

## Data Flow

```
User types in Activities overlay
        │
        ▼
GNOME Shell calls getInitialResultSet(terms[])
        │
        ▼
searchProvider.ts → builds a result ID: "sds:<encoded-query>"
        │
        ▼
GNOME Shell calls getResultMetas(ids[])
        │
        ▼
searchProvider.ts → returns { name, description, icon }
        │
        ▼
GNOME Shell renders the result card in the overlay
        │
   User clicks ──────────────────────────────────────────┐
        │                                                 │
        ▼                                                 ▼
activateResult(id)                               launchSearch(terms)
        │                                                 │
        └──────────────┬──────────────────────────────────┘
                       ▼
              browserLauncher.ts
              → buildSearchUrl(query, engine)
              → Gio.AppInfo.launch_default_for_uri(url)
                       │
                       ▼
             User's default browser opens
```

---

## Key Design Decisions

### Why Gio.AppInfo instead of xdg-open?

`Gio.AppInfo.launch_default_for_uri()` is the canonical GLib/GIO method for opening URIs. It reads the user's `xdg-mime` database directly in-process, without spawning a subprocess. This means:
- No shell escaping vulnerabilities
- Works reliably on both X11 and Wayland
- Respects per-user and system-level default app settings

A `GLib.spawn_command_line_async('xdg-open ...')` fallback exists for minimal installs where the GIO method may fail.

### Why separate result IDs with a prefix?

The prefix `sds:` (Search Does Search) namespaces our result IDs. If GNOME ever passes IDs from multiple providers into one call (it does in `getResultMetas`), namespacing prevents collisions with other extensions.

### Why no bundling in esbuild?

GNOME Shell loads extension files as native ES modules at runtime using its own GJS module loader. Bundling would produce a single file that inlines `gi://` and `resource://` imports, which GJS cannot resolve from inside a bundle. Keeping files separate means each `gi://Gio` import is resolved by GJS at load time — correct behaviour.

### GSettings for preferences

The extension uses a GSettings schema (`org.gnome.shell.extensions.search-does-search`) to persist the selected search engine. This integrates cleanly with GNOME's preferences system and allows a future `prefs.ts` page to provide a UI for changing it.

---

## Extension Lifecycle

| GNOME Event | Method Called | What Happens |
|---|---|---|
| Extension enabled | `enable()` | Settings loaded, provider registered |
| User changes engine in prefs | `changed::search-engine` signal | `provider.setEngine()` called live |
| Extension disabled / GNOME locked | `disable()` | Provider unregistered, all refs nulled |

Nulling all references in `disable()` is mandatory — GNOME Shell does not garbage collect extensions cleanly otherwise, which causes memory leaks across lock/unlock cycles.

---

## Compatibility

| GNOME Version | Status |
|---|---|
| 45 | Supported (ES module extensions introduced) |
| 46 | Supported |
| 47 | Supported |
| < 45 | Not supported (legacy CommonJS module system) |

GNOME 45 was the major breaking change where extensions moved from CommonJS-style `imports.` to standard ES module `import` syntax. This extension targets 45+ only.
