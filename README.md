# Search Does Search

A GNOME Shell extension that puts you back in control of your search bar.

When you type in the Activities overlay, instead of your browser automatically hijacking your query, **Search Does Search** shows a result card directly in the search overlay. You choose when to open it in the browser — and which browser you use is entirely up to your system defaults.

---

## Features

- Intercepts queries in the GNOME Activities search bar
- Shows the engine's **rendered results page inside the overview** — scroll it, click it, use the keyboard in it
- Optional sidebar listing the result links, fetched from **your own [SearXNG](https://docs.searxng.org/) instance** — no API keys
- Opens results in your **default browser** (Firefox, Chrome, Brave, Chromium — anything)
- Queries never touch a third party you did not choose
- Says what is wrong when the instance is missing or misconfigured, instead of showing an empty list
- Debounces keystrokes and cancels in-flight fetches as the query changes
- Works on X11 and Wayland
- Compatible with GNOME Shell 45–50

---

## Requirements

- GNOME Shell 45 or later
- Ubuntu 23.10+ / Fedora 39+ / any distro running GNOME 45+
- `curl` *(runtime fetch)*
- A reachable SearXNG instance with JSON output enabled *(see below)*
- Node.js 20+ *(for building from source)*

---

## Installation

### From extensions.gnome.org *(once published)*

Visit the extension page and click the toggle to install.

### From source

```bash
git clone https://github.com/searchdoessearch/search-does-search
cd search-does-search

npm install
make install
make enable

# Restart GNOME Shell:
# X11:    Alt + F2 → type 'r' → Enter
# Wayland: Log out and back in
```

### Set up a SearXNG instance

The extension needs somewhere to send queries. If you have Docker, one command
starts an instance on the default port with JSON output already enabled:

```bash
make searxng        # starts it on http://localhost:8888
make searxng-stop   # removes it again
```

To point the extension at an instance you already run:

```bash
gsettings set org.gnome.shell.extensions.search-does-search \
  searxng-instance 'http://localhost:8888'
```

Only `http` and `https` addresses are accepted. Whichever instance you use must
list `json` under `search.formats` in its `settings.yml` — it is off by default,
and without it SearXNG answers with `403`. The extension will tell you so in the
overview if that happens.

---

## Usage

1. Press the **Super key** to open Activities
2. Start typing any search query
3. Once you pause, the engine's results page renders in the **searchDOESsearch** section
4. Scroll or click the page; click a result to open it in your default browser.
   **Enter** opens the whole search in the browser instead.

Which engine's page is shown (DuckDuckGo or Google) and whether the sidebar of
links is visible are set in Extension Settings. Which upstream engines feed the
sidebar is configured in SearXNG itself, not here.

**Why a SearXNG instance instead of querying engines directly?** Because scraping
engines no longer holds together. Of the engines tested, only DuckDuckGo's HTML
endpoint stayed reliable; Mojeek rate-limits to roughly one query per 30–60
seconds per IP, Brave's markup is build-hashed and breaks on every deploy, and
Bing and Startpage answer with CAPTCHAs.

Google is worth spelling out, because "just render the JavaScript" is such an
obvious idea. Its response to a scripted client is 168 characters of redirect
notice with no result data in it at all, and adding a full Chrome header set,
cookie jar, and warm session returns the byte-identical page. Rendering it in a
real browser engine does not help either: WebKitGTK on a rested IP loads
`google.com` perfectly and is then refused at `/search` on the *first* request.
The gate is on the JavaScript runtime environment, not on behaviour, so no amount
of simulated human activity reaches it — but Google's sanctioned Programmable
Search endpoint answers fine, and SearXNG queries it for you. The full
measurements are in [docs/GJS-PITFALLS.md](docs/GJS-PITFALLS.md).

SearXNG fans one query across many upstreams and degrades gracefully when an
individual engine refuses, which is exactly the resilience this extension would
otherwise have to reinvent badly.

The query is sent to your instance only after GNOME's local and application
providers return no results. Results arrive as JSON over a plain HTTP GET
(`curl`). Activating a card opens its URL in the system default browser.

### The results page, inside the overview

The **searchDOESsearch** section of the overview shows the engine's real results
page, rendered, with its search form, logo and header stripped — and it is live:
scroll it, hover it, click it, Tab through its links, press PageDown. GNOME Shell
cannot host GTK or WebKit widgets (it is the compositor), so the page is rendered
by a companion process, `panel/sds-renderer.js` (GJS + Gtk 3 + WebKit2 4.1),
into an off-screen window that never appears on screen. Every repaint is exported
as raw pixels through a file in `$XDG_RUNTIME_DIR` and uploaded by the extension
as the texture of an actor in the overview; the actor forwards your pointer,
scroll and key events back to the renderer, which replays them as real GDK events
on the WebView. Measured on a 812×464 page: one wheel notch shows in the overview
27–39 ms later; nothing repaints while idle.

- Every link — in the page or in the sidebar — opens in your default browser;
  the rendered page never navigates away from the results. Only navigation
  decisions are intercepted, so scrolling, selection, focus and clicks are WebKit's
  own behaviour. The overview closes when a link is opened.
- Click the page to give it the keyboard; **Escape** hands it back to the search
  entry. The section heading and the browser button open the same search in your
  browser.
- The sidebar is a compact, top-anchored list of the result links from SearXNG.
  It is off by default (the page already lists the results): toggle it with
  **F9** or its button, or in Extension Settings, which also sets its side and
  width.
- Everything follows the system theme, including the light/dark preference.
  There is no theme setting: the overview widgets use the Shell's own style
  classes, and the stylesheet injected into the page takes its colours and font
  from the running GTK theme (`theme_base_color`, the `:link` colour,
  `gtk-font-name`), so the page matches whatever the rest of the desktop looks like.
- **Engine:** DuckDuckGo's HTML endpoint renders reliably. Google is selectable,
  but from a flagged network (VPN exits in particular) it answers `/sorry`
  ("unusual traffic") even with a persistent cookie profile and a browser user
  agent; the renderer detects that page, stops, and the overview offers DuckDuckGo
  or your browser. It does not attempt to get past the check.

---

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full development guide including debugging, the build loop, and how to add new search engines.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the extension works internally.

See [docs/GJS-PITFALLS.md](docs/GJS-PITFALLS.md) before changing anything on the
search path — this code runs inside the compositor, where a blocked main loop
freezes the whole desktop. Run `make check` before every commit.

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for the submission process to extensions.gnome.org.

---

## Project Structure

```
src/
├── extension.ts        ← Extension lifecycle (enable / disable)
├── searchProvider.ts   ← GNOME Search Provider API implementation
├── pageView.ts         ← The overview widget: page texture, input forwarding, sidebar
├── rendererClient.ts   ← Spawns and talks to the renderer over D-Bus
├── webSearch.ts        ← SearXNG JSON query + URL validation (sidebar links)
├── browserLauncher.ts  ← Default browser launch
└── prefs.ts            ← Preferences window
panel/
└── sds-renderer.js     ← Off-screen WebKit renderer process (frames + input)
scripts/
├── build.mjs           ← tsc + static asset copy
├── fetch-check.js      ← Live query smoke test
└── keystroke-harness.js ← Cancel-per-keystroke freeze regression test
schemas/
└── *.gschema.xml       ← GSettings schema for preferences
docs/
├── ARCHITECTURE.md
├── DEVELOPMENT.md
├── GJS-PITFALLS.md
└── PUBLISHING.md
```

---

## License

MIT
