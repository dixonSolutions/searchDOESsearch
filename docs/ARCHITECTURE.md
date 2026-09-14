# Architecture — Search Does Search

## Overview

Search Does Search is a GNOME Shell extension that hooks into the Activities search bar via the **GNOME Search Provider API**. Its one result is the engine's rendered results page, shown live inside the overview: a companion WebKit process renders it off-screen and streams its pixels to an actor in the Shell, which streams the user's input back. An optional sidebar lists the result links from a user-run [SearXNG](https://docs.searxng.org/) instance (JSON API, fetched with `curl`). Every link opens in the user's default browser.

---

## Module Map

```
src/
├── extension.ts        ← Entry point. Lifecycle; wires provider, renderer client and view.
├── searchProvider.ts   ← GNOME Search Provider: one result, debounced render requests.
├── pageView.ts         ← The overview actor: frame texture, input forwarding, sidebar, notices.
├── rendererClient.ts   ← Spawns the renderer, D-Bus proxy, fans out Frame/State/Launched.
├── webSearch.ts        ← SearXNG JSON query + instance/result URL validation (sidebar).
├── browserLauncher.ts  ← Opens result URLs in the default browser.
└── prefs.ts            ← Preferences window (engine, sidebar, SearXNG instance).
panel/
└── sds-renderer.js     ← Off-screen WebKit renderer: frames out, input in (own process).
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
searchProvider.ts
  → returns ['sds:page'] at once (the view persists across keystrokes)
  → 450 ms after the terms hold still: rendererClient.search(query, engine)
        │
        ▼
rendererClient.ts ── D-Bus ──▶ panel/sds-renderer.js
                                 → WebView loads the engine's results page off-screen
                                 → every repaint: pixels → tmpfs file → Frame signal
        │
        ▼
pageView.ts (the result actor)
  → maps each frame, uploads it as the actor's St.ImageContent
  → forwards pointer / scroll / key events to the renderer
  → sidebar (if shown): webSearch.ts → curl GET {instance}/search?q=…&format=json
        │
   User clicks a link in the page (or a sidebar row)
        │
        ▼
renderer decide-policy → browserLauncher rule (http/https only) → default browser
  → Launched signal → Main.overview.hide()
```

---

## Key Design Decisions

### Why SearXNG instead of scraping engines directly?

The extension previously fetched engine HTML with `curl` and parsed it with a Lexbor-backed native helper. Only one engine (DuckDuckGo) stayed reliable; the rest rate-limited, CAPTCHA'd, or changed their markup on every deploy. Google is unreachable by scraping at all — it gates `/search` on the JavaScript runtime environment, refusing even a real browser engine with a warm session on its first request.

Delegating to SearXNG removes an HTML parser, a C build dependency, and a whole class of breakage from this codebase, and it reaches Google's sanctioned Programmable Search endpoint as a side effect. The cost is an external service the user must run. Full measurements are in [GJS-PITFALLS.md](GJS-PITFALLS.md).

### Why does a failed lookup still produce a card?

An empty result list is indistinguishable from "no matches", which made the previous backend very hard to diagnose. Every non-`ok` `SearchOutcome` becomes exactly one card that names the cause and opens the page that fixes it.

### Why validate the instance URL?

It is a GSettings string handed to `curl`. `normalizeInstanceUrl()` accepts only `http`/`https` origins and discards any path, query, or fragment, so a bad setting cannot reach `file://` or `scp://`, and the caller fully controls the request path.

### Why Gio.AppInfo instead of xdg-open?

`Gio.AppInfo.launch_default_for_uri()` is the canonical GLib/GIO method for opening URIs. A `xdg-open` fallback exists for minimal installs.

### Why separate result IDs with a prefix?

The prefix `sds:` namespaces our result IDs so `getResultMetas` never collides with other providers.

### Why no bundling?

GNOME Shell loads extension files as native ES modules. Bundling would break `gi://` and `resource://` imports.

### How a WebKit page ends up inside the overview

GNOME Shell is the Wayland compositor; its scene graph is Clutter, and neither
GTK nor WebKit widgets can be parented into it. So the page is rendered elsewhere
and only its pixels enter the Shell:

```
 GNOME Shell (extension)                    panel/sds-renderer.js (own process)
 ───────────────────────                    ──────────────────────────────────
 SearchProvider ── debounce 450 ms ──▶ Search(query, engine)   D-Bus method
                                            │ WebKit2.WebView in a Gtk.OffscreenWindow
                                            │ (never shown; hardware acceleration off)
                                            ▼
                                        damage-event ─ coalesce 6 ms, ≥16 ms apart
                                            │ gdk_pixbuf_get_from_window → RGBA
                                            │ write $XDG_RUNTIME_DIR/searchdoessearch/frame-{0,1}.raw
                                            │ (temp file + rename: a reader never sees a torn frame)
 PageView.FrameActor ◀── Frame(path,w,h,stride,serial) ── D-Bus signal
   GLib.MappedFile → St.ImageContent.set_bytes (Cogl texture)
   pointer / scroll / key events ──▶ Pointer / Scroll / Key   D-Bus methods
                                            │ rebuilt as GdkEvents, gtk_widget_event(webview)
                                            ▼
                                        WebKit handles them: hover, scroll, focus, typing
   Main.overview.hide() ◀── Launched(url) ── link click bridged to the default browser
```

The renderer is spawned on the first search and kept alive (WebKit start-up is
~0.4 s; a new query on a warm renderer costs nothing extra). It serves the bus
name `io.github.searchdoessearch.Renderer`, accepts calls only from its first
caller, exits when that caller's bus name vanishes, on `Quit`, or after 15 minutes
idle. The interface XML lives in both `panel/sds-renderer.js` and
`src/rendererClient.ts`; the renderer cannot be imported by the Shell (it loads
GTK), so the two copies must be kept identical by hand.

**Frame transport.** No PNG anywhere. Each repaint is one `gdk_pixbuf_get_from_window`
read-back (the only way GJS can reach the off-screen surface's pixels), one write
to tmpfs, one mmap and one texture upload. `damage-event` always reports the whole
view, so there is no dirty-region path; the full frame is exported every time.
Measured at 812×464 (1.5 MB per frame): read-back 7–10 ms, write 2–3 ms, map +
upload 2–3 ms, D-Bus ~1 ms; wheel notch in the overview → texture updated in
27–39 ms end to end, one frame per notch. Idle: zero frames. Overlay scrollbars
had to be disabled in the renderer (`GTK_OVERLAY_SCROLLING=0`): their fade
animation produced 100+ repaints per idle 4 s and a ~1 s burst after every scroll
or hover. The renderer runs at `GDK_SCALE=1` and applies the Shell's scale factor
as WebKit zoom, so frame pixels are device pixels; `gtk-xft-dpi` is pinned to 96
so a HiDPI X display cannot double the fonts.

**Input.** The Shell actor forwards its events with coordinates mapped into page
device pixels; the renderer rebuilds them as `Gdk.Event`s and hands them to the
WebView widget. GJS assigns `event.window` without a reference while
`gdk_event_free` drops one, so the field is cleared after dispatch. Only SMOOTH
scroll events are forwarded: mutter delivers each wheel notch or 10 px of touchpad
travel as a SMOOTH event (delta 1.0 — GDK's own unit, passed through unchanged)
plus a discrete twin; forwarding both would scroll twice. Motion is coalesced to
the newest position every 24 ms unless a button is held (a selection drag needs
every step).

The renderer uses **Gtk 3.0 + WebKit2 4.1**: those are the typelibs shipped here
(`Gtk-3.0`, `WebKit2-4.1`); `libwebkitgtk-6.0` is installed but has no
`WebKit-6.0` typelib, so GTK 4 is not an option for GJS on this system.

**Theme.** Nothing here has a palette. The overview widgets use the Shell's own
style classes (`list-search-result`, `list-search-result-title`, `icon-button`,
`button`), so they are the system Shell theme. The injected stylesheet (which
hides the engine's search form, logo and header) takes its colours and font from
the live GTK theme through `StyleContext.lookup_color()` and `gtk-font-name`; the
dark variant is requested when `org.gnome.desktop.interface color-scheme` prefers
dark, because GTK 3 does not read that key itself. It is regenerated whenever the
style context changes, and the page repaints — one frame.

**Navigation bridging.** `decide-policy` is handled only for `NAVIGATION_ACTION`
and `NEW_WINDOW_ACTION`. The renderer's own load, the engine's redirects and the
engine's own forms stay in the view; everything else — any link, however it was
activated (click, Enter on a focused link, middle click) — is unwrapped from the
engine's redirect hop and handed to the default browser with the same http(s)-only
rule as `browserLauncher.ts`, then reported with `Launched` so the overview closes.
Response decisions are untouched, so input inside the page is never swallowed.

**Google.** The renderer checks the committed URI; `/sorry` means the "unusual
traffic" interstitial. Google first serves an empty JavaScript shell (a transient
`ready`), then navigates itself to `/sorry`; the renderer stops there and reports
`blocked`, and the overview shows a notice with a DuckDuckGo and a browser button.
It does not try to pass the check.

**Shell integration.** The provider returns one result whose id never changes
(`sds:page`). `SearchResultsBase` caches result actors by id, so the `PageView`
survives every keystroke and only receives the new query; the Shell destroys it
when the search is reset and the provider builds a fresh one (`createResultObject`)
next time, re-attaching to the still-running renderer. Enter in the search entry
activates the result, which opens the whole search in the browser.

### GSettings for preferences

Schema `org.gnome.shell.extensions.search-does-search` stores `searxng-instance`
(sidebar links) and the `panel-*` keys (engine, sidebar visibility/side/width/count).
The former `max-results`, `search-engine` and `browser-command` keys are gone.

---

## Extension Lifecycle

| GNOME Event | Method Called | What Happens |
|---|---|---|
| Extension enabled | `enable()` | Settings loaded, provider registered |
| User changes settings | `changed` signal | Options updated live |
| Extension disabled / GNOME locked | `disable()` | Provider unregistered, all refs nulled |

Nulling all references in `disable()` is mandatory — GNOME Shell does not garbage collect extensions cleanly otherwise.

---

## Compatibility

| GNOME Version | Status |
|---|---|
| 45 | Supported (ES module extensions introduced) |
| 46 | Supported |
| 47 | Supported |
| < 45 | Not supported |

Build requires Node.js 20+. Runtime requires `curl` and a reachable SearXNG instance with `json` enabled under `search.formats`.
