# Search Does Search

A GNOME Shell extension that puts you back in control of your search bar.

When you type in the Activities overlay, instead of your browser automatically hijacking your query, **Search Does Search** shows a result card directly in the search overlay. You choose when to open it in the browser — and which browser you use is entirely up to your system defaults.

---

## Features

- Intercepts queries in the GNOME Activities search bar
- Renders up to five real web results with Chrome/Chromium's Blink engine
- Only searches the web when apps, files, and other system providers find nothing
- Uses native GNOME result cards, inheriting the system light/dark theme
- Opens the search in your **default browser** (Firefox, Chrome, Brave, Chromium — anything)
- Supports DuckDuckGo (default) and Google result parsing
- Engine preference is configurable via GSettings
- Cancels stale renders as the query changes and limits each render to eight seconds
- Works on X11 and Wayland
- Compatible with GNOME Shell 45, 46, 47

---

## Requirements

- GNOME Shell 45 or later
- Ubuntu 23.10+ / Fedora 39+ / any distro running GNOME 45+
- Google Chrome or Chromium *(for rendering web results)*
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

---

## Usage

1. Press the **Super key** to open Activities
2. Start typing any search query
3. The **"Search the web for..."** result card appears
4. Press **Enter** or click the card to open it in your default browser

To change the search engine:
```bash
gsettings set org.gnome.shell.extensions.search-does-search search-engine google
# Options: duckduckgo, google
```

The query is sent to the configured search engine only after GNOME's local and
application providers return no results. Rich result cards are rendered by a
temporary headless browser profile; activating a card opens its URL in the
system default browser.

---

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full development guide including debugging, the build loop, and how to add new search engines.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the extension works internally.

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for the submission process to extensions.gnome.org.

---

## Project Structure

```
src/
├── extension.ts        ← Extension lifecycle (enable / disable)
├── searchProvider.ts   ← GNOME Search Provider API implementation
└── browserLauncher.ts  ← URL building and default browser launch
schemas/
└── *.gschema.xml       ← GSettings schema for preferences
docs/
├── ARCHITECTURE.md
├── DEVELOPMENT.md
└── PUBLISHING.md
```

---

## License

MIT
