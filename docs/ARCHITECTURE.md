# Architecture — Search Does Search

## Overview

Search Does Search is a GNOME Shell extension that hooks into the Activities search bar via the **GNOME Search Provider API**. Its one result is the engine's rendered results page, shown live inside the overview: a companion WebKit process renders it off-screen and streams its pixels to an actor in the Shell, which streams the user's input back. A clicked link is either followed inside that same view — with a back control counting the pages followed — or handed to the user's default browser, which the `link-mode` setting decides.

---

## Module Map

```
src/
├── extension.ts        ← Entry point. Lifecycle; wires provider, renderer client and view.
├── searchProvider.ts   ← GNOME Search Provider: one result, debounced render requests.
├── pageView.ts         ← The overview actor: frame texture, input forwarding, header, notices.
├── section.ts          ← The Shell's section for us: provider column, order, visibility.
├── rendererClient.ts   ← Spawns the renderer, D-Bus proxy, fans out Frame/State/Nav/Launched/Refused.
├── browserLauncher.ts  ← Opens result URLs in the default browser.
└── prefs.ts            ← Preferences window (four enum keys).
panel/
└── sds-renderer.js     ← Off-screen WebKit renderer: frames out, input in (own process).
stylesheet.css          ← Loaded by the Shell on enable; scoped to this section's own classes.
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
  → 200 ms after the terms hold still (and never twice inside 400 ms):
    rendererClient.search(query, engine)
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
        │
   User clicks a link in the page
        │
        ├─ link-mode = contained (default), plain click
        │    → renderer follows it; depth counted when the load commits
        │    → Nav(depth, title, uri) → pageView shows the back pill and the page's name
        │    → Back() walks it down; a new Search() resets the depth to 0
        │
        └─ link-mode = browser, or middle/Ctrl+click, or a response WebKit cannot display
             → http(s) only → default browser → Launched signal → Main.overview.hide()
```

---

## Key Design Decisions

### Why render the engine's own page instead of fetching results?

The extension previously fetched engine HTML with `curl` and parsed it with a Lexbor-backed native helper, and later listed links from a user-run SearXNG instance. Both are gone: only one engine (DuckDuckGo) stayed reliable to scrape, the rest rate-limited, CAPTCHA'd or changed their markup on every deploy, and SearXNG asked the user to run a service to get a list the rendered page already shows. Rendering the engine's own page removes the parser, the C build dependency, the external service, and a whole class of breakage.

Google is the exception worth naming: it gates `/search` on the JavaScript runtime environment and refuses even a real browser engine with a warm session on its first request from a flagged network. It stays selectable, and when it refuses, the renderer reports that rather than working around it. Full measurements are in [GJS-PITFALLS.md](GJS-PITFALLS.md).

### Why is contained browsing not a browser?

Following a link in place needs history depth and a way back — nothing more. No forward, no address bar, no tabs, no downloads: each of those is a surface to secure and a behaviour to explain inside a search result. What the view cannot show (a download, a PDF, a `mailto:` link) leaves for the real browser, which is the one place those things are already handled properly.

### Why are non-http(s) links refused rather than handed over?

Every URI reaching the navigation policy came from a remote page. `http` and `https` go to the browser or are followed in place; everything else — `mailto:`, `magnet:`, an app's own scheme — is refused, because handing an arbitrary page's URI to the desktop's handler list is a much larger surface than a search result needs. A refused click is reported in the header (the `Refused` signal), so it does not read as a broken view; a page's own `about:`/`blob:`/`data:` loads are machinery and are refused silently.

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
 SearchProvider ── debounce 200 ms ──▶ Search(query, engine)   D-Bus method
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
   PageView.header ◀── Nav(depth, title, uri) ── a link followed inside the view
   Back() / OpenCurrent() / SetLinkMode(mode) ──▶  the back control and the mode
   Main.overview.hide() ◀── Launched(url) ── link click bridged to the default browser
```

The renderer is spawned when the overview starts opening (`prewarm`, so WebKit's
start-up overlaps the open animation) and kept alive (WebKit start-up is
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

Schema `org.gnome.shell.extensions.search-does-search`, four enum keys:
`engine` (duckduckgo | google), `link-mode` (contained | browser),
`section-visibility` (always | no-other-results) and `section-placement`
(top | top-when-alone | default). The former `searxng-instance`, `panel-*`,
`max-results`, `search-engine` and `browser-command` keys are gone.

### Reaching into the Shell's search results

`section.ts` uses three things the provider contract does not expose, each
feature-detected and skipped if a future Shell moves it: `provider.display` (the
section actor the Shell builds per provider) to hide its provider column and tag
the card for our stylesheet; the display's parent box to move the section to the
front; and the sibling sections' `provider` and visibility to answer "did
anything else match?". The Shell has no "sweep finished" signal an extension can
use — `SearchResultsView.searchInProgress` is a plain getter with no notify — so
the decision is re-run whenever a sibling section shows or hides.

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
| 48–50 | Supported (developed and tested on 50.1) |
| 45–47 | Not supported: `St.BoxLayout`'s `orientation` property is 48+, and the stylesheet uses the `-st-accent-color` variables (47+) |
| < 45 | Not supported (no ES module extensions) |

Build requires Node.js 20+. Runtime requires GJS with the WebKit2 4.1 typelib for the renderer process; nothing else, and no service of the user's own.
