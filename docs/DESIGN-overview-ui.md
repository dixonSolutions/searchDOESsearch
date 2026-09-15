# Design — the overview section, contained browsing, and speed

Design spec for the next iteration of the results section in the Activities
overview. It is written against the code as it is in the working tree on
2026-09-15 (GNOME Shell 50.1, `src/pageView.ts`, `src/searchProvider.ts`,
`src/rendererClient.ts`, `panel/sds-renderer.js`) and against the Shell's own
`ui/search.js`, `ui/searchController.js`, `ui/environment.js` and theme CSS
extracted from `/usr/lib/gnome-shell/libshell-18.so` and
`/usr/share/gnome-shell/gnome-shell-theme.gresource` on this machine. Every
Shell internal it leans on is named in § F with a fallback.

**Two things the spec takes as given, because they are already in the tree:**

1. The uncommitted working-tree diff already extends the renderer protocol for
   contained browsing: methods `Back`, `OpenCurrent`, `SetLinkMode(mode)`, signal
   `Nav(depth, title, uri)`, depth counted on `COMMITTED`, `RESPONSE` decisions for
   unsupported MIME types handed to the browser, `RendererClient.prewarm()`,
   `back()`, `openCurrent()`, `setLinkMode()`. This spec designs the UI on top of
   that protocol and does not propose a competing one. Where it needs one more
   thing from the renderer, it says so explicitly (§ C.6, § E.2).
2. The same diff removes the SearXNG sidebar (`fetchLinks`, `instanceUrl`, the
   `make searxng*` targets). The sidebar, its F9 shortcut and its four
   `panel-sidebar-*` keys are therefore gone from this design, and the
   sidebar-toggle header button goes with them.

Reference machine for every number below: 1920×1200, scale factor 1.0, font
"Ubuntu Sans 11" (1em = 14.67px in St), Yaru Shell theme (identical search
metrics to Adwaita's: card `#373737` vs `#38383b`, radius 24px, padding 12px).

---

## 0. What is wrong today, measured

From the 08:12–08:18 screenshots (1920 px wide, dock 100 px on the left):

| Thing | Today |
|---|---|
| Card (`.search-section-content`) | x 375–1650 → **1275 px** wide |
| Provider column (`.search-provider-icon`, globe + "searchDOESsea…") | **240 px**, conveys nothing the header does not |
| Our header row | ~55 px tall incl. the card's 12 px top padding |
| Page texture | **1017 × 700** px (0.58 × monitor height) |
| Results column inside the texture | `#links { max-width: 760px }` **left-aligned** → ~250 px of dead space on the right of the page and the column sits off-centre |
| Header buttons | sidebar toggle, open-in-browser — both redundant |
| Time to first pixel after the last keystroke | Shell throttle 150 ms + our debounce 450 ms + cold renderer spawn (~400 ms, first search only) + page load |

Note the off-centre text is the renderer's injected CSS, not the Shell layout;
reclaiming the provider column alone would make it *worse* (wider texture, same
left-anchored 760 px column). Both fixes ship together.

---

## A. Layout

### A.1 Decision: hide the Shell's provider column for our section, keep the card

Options considered:

- **Hide `ProviderInfo` for our section only** — chosen. The identity ("web
  results, DuckDuckGo") moves into our own 32 px header, which we need anyway
  for the back control. Zero-width, nothing to align against, no second column
  competing with centring.
- Collapse it to a slim identity strip (icon only, ~44 px). Rejected: it keeps
  an asymmetric gutter, and a 32 px globe next to a page that already says
  "DuckDuckGo" is decoration.
- Leave it and shrink it via CSS. Rejected: `.list-search-provider-details`
  is `width: 120px` in the theme; we can override it for our section, but the
  icon + spacing still cost ~70 px and it still says "searchDOESsea…".

What the provider column normally offers (click → `launchSearch` in the
browser, "N more" count) is covered: Enter on the selected result already opens
the search in the browser (`PageView.activate`), and there is never a "more".

How (see § F.1 for the exact walk): from `PageView`, on `notify::mapped` the
first time it is mapped, walk `parent` → `.list-search-results` → parent
`.search-section-content`; verify by `has_style_class_name`; then

```ts
container.get_children().find(c => c.has_style_class_name('search-provider-icon'))?.hide();
container.add_style_class_name('sds-section');          // lets stylesheet.css restyle THIS card only
container.get_parent()?.get_parent()?.add_style_class_name('sds-search-section'); // the .search-section
```

Hiding (not destroying) the `ProviderInfo` keeps the Shell's own references
valid (`_setMoreCount` still works, it just updates an invisible label).

### A.2 Geometry

Widths come from the Shell: `#searchResultsContent` is a `MaxWidthBox` (theme
`max-width: 1044px`, scaled) centred in the overview; the card is that minus the
section's 12 px side margins and 2 px border. **Do not cap the page width
ourselves** — fill the card. The overview already caps it, and a followed page
wants every pixel.

| Element | Value | Why |
|---|---|---|
| Card padding (`.sds-section`) | `6px 12px 12px 12px` | Shell default is 12 all round; the header needs less air above it than the page needs below |
| Header (`.sds-header`) | `min-height: 32px`, `padding: 0 4px`, `spacing: 8px` | one line of 1em text with a 28 px pill in it |
| Gap header → page (`.sds-page` spacing) | 4 px | |
| Page (frame) width | card inner width = card − 24 − 4 → **1247 px** on the reference machine (was 1017, +23 %) | fill |
| Page height | `round(0.60 × primary monitor height)`, clamped **[360, 1200]** → **720 px** at 1200 | 0.58 → 0.60: the header lost 20 px, give it to the page; the search view on this monitor is ~1020 px tall, so a 778 px card still leaves the next section's top visible |
| Total card height | 2 + 6 + 32 + 4 + 720 + 12 + 2 = **778 px** (was 775) | vertical padding reclaimed goes into page height, not into a shorter card |
| Corner radius | keep the Shell's 24 px on the card; the texture stays square-cornered and inset 12 px | see A.4 |
| Texture pixel size | `Configure(1247 × scale, 720 × scale, scale)` — unchanged mechanism | |

The page keeps the **same viewport for the results page and every followed
page**: `Configure` is driven by the actor's allocation, which does not change
on navigation. A followed page scrolls inside the same 720 px, which is what
the user asked for ("same page length as the results page").

### A.3 Centring and scaling the results (renderer CSS — `panel/sds-renderer.js`, `pageCss()`)

The texture is the full card width; the content must be a centred column:

```css
/* DuckDuckGo */
#links { max-width: 880px !important; margin: 0 auto !important; padding: 10px 20px 24px !important; }
.result { padding: 8px 12px 9px 12px !important; margin: 0 0 4px 0 !important; border-radius: 8px !important; }
.result__snippet { line-height: 1.45 !important; }
/* Google */
#rso   { max-width: 880px !important; margin: 0 auto !important; padding: 10px 20px 24px !important; }
```

880 px: 70–80 characters per line at 11 pt is the readable band; 760 was chosen
for a 1017 px texture and now leaves 40 % of the width empty. "Scale" is
already right — fonts follow `gtk-font-name` at the Shell's scale factor via
WebKit zoom — so no zoom setting is added. If a user wants bigger text they
have the desktop font size, which is what every other overview text follows.

### A.4 The texture's corners and background (decision: leave the page its own background)

`St.ImageContent` cannot be rounded by St CSS, so the texture is a rectangle
inside a 24 px-radius card. With 12 px insets on all four sides, the
texture's corner (12, 12) lies 17 px from the arc centre (24, 24) — inside the
card body — so it never pokes through the rounded corner. The rectangle keeps
the page's own background (`theme_base_color`: white in light, near-black in
dark) and reads as a sheet on a dark card.

Rejected: rendering the page with a transparent background so it inherits the
card colour. The overview's cards are **dark in both Shell variants**
(`gnome-shell-light.css` also sets `.search-section-content` to `#38383b`),
while the page text colour comes from the GTK theme — in light mode that would
put dark text on a dark card. Passing the card colour to the renderer and
re-deriving text colours from it is a protocol change plus a colour system for
one cosmetic corner. Not worth it.

### A.5 `stylesheet.css` (new file at the extension root; `scripts/build.mjs` must copy it)

The Shell loads `stylesheet.css` on enable (`extensionSystem.js` tries
`stylesheet-<variant>.css` first, then `stylesheet.css`; one file is enough
because the card chrome is dark in both variants and every colour below is
either an accent variable or inherited). `st-lighten`/`st-darken`/
`st-transparentize` and `-st-accent-color`/`-st-accent-fg-color` are the same
functions and variables the Shell's own theme uses.

```css
/* searchDOESsearch — overview section. All sizes are logical px; the Shell scales them. */

/* The Shell's own card, only where pageView has tagged it. */
.search-section-content.sds-section {
  padding: 6px 12px 12px 12px;
}

/* Vertical box: header, then the page (or the notice). */
.sds-page {
  spacing: 4px;
}

/* ── header ─────────────────────────────────────────────────────────────── */
.sds-header {
  min-height: 32px;
  padding: 0 4px;
  spacing: 8px;
}
.sds-title {
  font-size: 1em;
}
/* Dim text is done with actor opacity in code (theme-proof), not a colour here. */
.sds-hint {
  font-size: 0.85em;
}

/* Back pill: accent-filled, the only coloured thing in the card. */
.sds-back {
  border-radius: 999px;
  min-height: 28px;
  padding: 0 10px 0 8px;
  spacing: 6px;
  background-color: -st-accent-color;
  color: -st-accent-fg-color;
  transition-duration: 100ms;
}
.sds-back:hover  { background-color: st-lighten(-st-accent-color, 6%); }
.sds-back:active { background-color: st-darken(-st-accent-color, 6%); }
.sds-back:focus  { box-shadow: inset 0 0 0 2px st-transparentize(-st-accent-fg-color, 0.5); }
.sds-back StIcon { icon-size: 16px; -st-icon-style: symbolic; }

/* Depth badge inside the pill: inverse of the pill. */
.sds-back-badge {
  min-width: 18px;
  min-height: 18px;
  padding: 0 4px;
  border-radius: 999px;
  background-color: -st-accent-fg-color;
  color: -st-accent-color;
  font-size: 0.75em;
  font-weight: bold;
  text-align: center;
}

/* "Open this page in your browser" — Shell's round icon button, only shown at depth ≥ 1. */
.sds-open {
  padding: 6px;
}

/* ── page ───────────────────────────────────────────────────────────────── */
.sds-frame {
  /* height is set in code (pageHeight()); width fills the card */
}

/* ── notice (blocked / error) ───────────────────────────────────────────── */
.sds-notice {
  padding: 48px 24px;
  spacing: 8px;
  max-width: 560px;
}
.sds-notice-title {
  font-weight: bold;
  font-size: 1.1em;
}
.sds-notice-buttons {
  spacing: 12px;
  padding-top: 8px;
}
```

Things that are deliberately *not* in the stylesheet: dim text colour (use
`opacity: 160` on the `St.Label` in code — a hard-coded grey breaks on a
high-contrast or user theme), and anything for `.list-search-result-description`
(that Shell class only styles labels *inside* `.list-search-result`, so it
never applied to our header label anyway — which is why it was full-brightness
in the screenshots).

---

## B. Header

### B.1 Contents

One `St.BoxLayout.sds-header`, left to right:

```
[ title ─────────────────────────── x_expand ] [ hint ] [ spinner ] [ open ] [ ← 2 ]
```

| Child | Widget | Visible when |
|---|---|---|
| `title` | `St.Label.sds-title`, ellipsize END, opacity 160 at depth 0 / 255 at depth ≥ 1 | always |
| `hint` | `St.Label.sds-hint`, opacity 140, text "↵ Opens in browser" | only while our result carries the Shell's `:selected` pseudo-class (it is the Enter target) |
| `spinner` | `Spinner(16, {animate: true, hideOnStop: true})` from `resource:///org/gnome/shell/ui/animation.js` | loading, and only after 250 ms of it (§ E.4) |
| `open` | `St.Button.icon-button.sds-open`, icon `web-browser-symbolic` 16 px, a11y "Open this page in your browser" | depth ≥ 1 |
| `back` | the pill (§ B.3) | depth ≥ 1 |

The header **never collapses to zero**: at 32 px it is the section's identity
(the provider column is gone) and the anchor the back pill appears in; a header
that comes and goes would move the page up and down by 36 px on every link.

### B.2 Title per state

| State | `title` text | opacity |
|---|---|---|
| results page, loading | `DuckDuckGo` (engine label) | 160 |
| results page, ready | `DuckDuckGo` | 160 |
| results page, blocked | `DuckDuckGo · blocked` — the notice below explains | 160 |
| results page, error | `DuckDuckGo · failed` | 160 |
| followed page, loading (before `Nav` commits) | host from `State('loading', host)` e.g. `en.wikipedia.org` | 255 |
| followed page, committed / ready | `<title>` from `Nav.title`, then ` · host` in a dimmer run (Pango markup, `GLib.markup_escape_text` both parts; `<span alpha="60%">` for the host) | 255 |
| followed page, error | `Couldn't load host` + notice with a **Back to results** button | 255 |
| transient message (§ C.6) | the message for 2.5 s, then the state text again | 255 |

No "Loading…" text anywhere. The words changed on every keystroke; the spinner
appears only for loads that actually take a while.

### B.3 The back pill

- Widget: `St.Button.sds-back`, `can_focus`, child `St.BoxLayout` →
  `St.Icon(icon_name: 'go-previous-symbolic', icon_size 16)` +
  `St.Label.sds-back-badge` (the depth as text). RTL: St flips
  `go-previous-symbolic` to its `-rtl` variant automatically (both files exist
  in Adwaita).
- Position: **last child of the header, i.e. the right-hand end** — the
  "right topbar" the user asked for. It is 28 px tall and ~56 px wide at
  depth 1; a fat, accent-coloured, single target.
- Badge value: **the depth**, 1, 2, 3…: "how far the user has gone" from the
  results page. Depth 1 shows `1` (not blank): the number is what tells a user
  that the arrow means "back towards the results", not "browser back".
- Accessible name: `Back to results` at depth 1, `Back, ${depth} pages from the results` beyond.
- Tooltip: none (St has no tooltips; the a11y name covers screen readers).
- States: normal / hover / active / focus from the stylesheet; **no disabled
  state** — at depth 0 the pill is not there.

Animation (all via the Shell's `actor.ease()`, `Clutter.AnimationMode.EASE_OUT_QUAD`):

| Event | Motion |
|---|---|
| depth 0 → 1 | `show()`, then opacity 0 → 255 and `scale_x/y` 0.8 → 1, pivot (0.5, 0.5), 150 ms |
| depth n → n+1 / n−1 (n ≥ 1) | badge text swaps, badge `scale_x/y` 1 → 1.25 → 1, 2 × 80 ms (`autoReverse: true, repeatCount: 1`) |
| depth 1 → 0 | opacity 255 → 0, scale 1 → 0.8, 100 ms, `onComplete: hide()` |
| `open` button | same in/out as the pill, 30 ms later (`delay: 30`) so the two do not pop as one block |

If the user retypes while a pill animation is in flight, `remove_all_transitions()` first; the ease helper already cancels overwritten transitions per property.

### B.4 Keyboard and mouse

| Input | Where handled | Action |
|---|---|---|
| **Alt+Left** | `FrameActor._key`, before forwarding: `symbol === Clutter.KEY_Left && (state & Clutter.ModifierType.MOD1_MASK)` | back (depth ≥ 1); at depth 0 swallow, do nothing |
| **Mouse button 8** (BTN_SIDE, the "back" thumb button) | `FrameActor` `button-press-event`, `event.get_button() === 8` → do not forward | back |
| Alt+Right / button 9 | swallow | nothing — there is no forward |
| **Backspace** | forwarded to the page as today | **not** back: followed pages have text fields, and the Shell cannot see what has focus inside the page |
| **Escape** | unchanged | focus back to the search entry; second Escape resets the search (Shell) |
| **Enter** in the search entry (Shell `activateDefault` → our `activate()`) | `PageView.activate` | depth 0: open the *search* in the browser (as today); depth ≥ 1: `renderer.openCurrent()` — open the *page you are looking at* |
| F9 | removed with the sidebar | |

Alt+Left over Backspace because every browser the user has used since 2010
treats Alt+Left as back and Backspace as "delete a character"; Backspace-as-back
is exactly the accident the header pill is supposed to make unnecessary.

---

## C. Contained navigation UX

The loop the user described — "press this one, that one, and go back to
search" — with depth as the only state.

### C.1 Following a link (contained mode)

1. Click. The renderer's `decide-policy` uses the navigation and emits
   `State('loading', host)`. Header title becomes the host immediately (255
   opacity); the **old page stays on screen** — WebKit keeps painting the
   previous document until the new one commits, and the texture is only
   replaced by frames the renderer exports, so nothing blanks.
2. `COMMITTED` → `Nav(1, title, uri)`. Pill and `open` button animate in with
   badge `1`. The page's first paint arrives as a frame within the same
   ~50 ms.
3. `FINISHED` → `State('ready')`, `Nav` again with the final `<title>`; spinner
   stops (if it ever showed).

Middle-click or Ctrl+click on a link, in contained mode, opens it in the real
browser instead (browser convention; renderer: `action.get_mouse_button() === 2`
or `action.get_modifiers() & Gdk.ModifierType.CONTROL_MASK` → `_launch`).
This is the one renderer addition § C needs and it is a five-line branch in
`_onDecidePolicy`.

### C.2 Second-level link

Same as C.1 with depth 2, badge `2`. The title tracks the newest page. There
is no breadcrumb: the number is the breadcrumb.

### C.3 Back

- One step per press (`renderer.back()`), depth decrements on the renderer's
  own bookkeeping, `Nav` updates the badge. Depth 1 → 0 removes the pill and
  restores the dim engine title.
- **Scroll position**: WebKit restores it from the history entry on `go_back()`
  — you land where you left, including on the results page. If the renderer
  restarted in between (`can_go_back()` false), the renderer reloads the
  results page at the top; that is the only case the scroll is lost.
- Focus: the pill keeps key focus after the click; Escape still returns to the
  entry.
- Rapid presses: each is one step; the renderer ignores `Back` at depth 0.

### C.4 Retyping while deep

The query changing is a new search: the renderer's `Search()` already resets
depth to 0 and loads the new results page; the pill goes away on the `Nav(0)`.

One gap in `searchProvider.ts` must close: `_scheduleRender` skips
`renderer.search` when the settled query equals `_rendered` (the overview was
reopened with the same text). At depth ≥ 1 that would leave the user on the
followed page with no way to reach the results except pressing back n times.
Rule: **the provider calls `renderer.search` whenever the view reports
depth ≥ 1, regardless of `_rendered`.** (`ResultView` gains a readonly
`navigated: boolean`.)

Reopening the overview with the same query after having followed links (the
Shell destroyed the actor, the renderer kept the page): the rebuilt view's
`refresh()` makes the renderer re-emit `Nav`, so the pill comes back at the
same depth — the user is where they left off. The rule above only applies once
the query *settles again*, which requires the terms to change or the debounce
to fire, so a reopen alone keeps the deep page. Good.

### C.5 Blocked / error while deep

A followed page that fails to load (`State('error')`) shows the existing
notice panel in place of the frame with the title `Couldn't load <host>` and
buttons **Back to results** (→ `renderer.search(query)` — straight home, not n
steps) and **Open in browser** (→ `renderer.openCurrent()`). The Google
"unusual traffic" check is only checked at depth 0 (the renderer already skips
`_checkBlocked` when deep).

### C.6 Links that are not a page

| Kind | Renderer today (working tree) | UX |
|---|---|---|
| PDF, archive, any MIME WebKit cannot show | `RESPONSE` decision → `_launch(uri)` → `Launched` | the overview closes and the browser gets the URL; depth is not incremented (`_pendingDepth` cleared). Header shows nothing because the overview is gone. Correct: this is not a browser, and the file should land where the user expects. |
| `mailto:`, `tel:`, custom schemes | `isSafeHttpUrl` false → `decision.ignore()` silently | add a **transient header message** for 2.5 s: `That link can't open here` (title label swaps text, opacity 255, then returns). Nothing is launched: handing arbitrary schemes from a remote page to `launch_default_for_uri` is the thing `browserLauncher.ts` exists to refuse. This needs one more signal from the renderer, `Refused(uri)`; until it exists the message is simply not shown. |
| `target=_blank` / popups | followed in place (contained) or launched (browser mode) | no special UI; it is a link |
| Form submits on a followed page | count as a step (already: `FORM_SUBMITTED` sets `_pendingDepth`) | badge increments; back returns to the form |

### C.7 The explicit "open in my real browser" affordance

Yes, one — but only where Enter does not already do it:

- Depth 0: **no button.** Enter opens the search in the browser (the `hint`
  label says so while our result is the Enter target). This is the redundancy
  the user removed.
- Depth ≥ 1: the round `open` icon button next to the pill, and Enter, both
  open *the current page* (`OpenCurrent`). Without it a contained page has no
  exit to the browser except middle-clicking a link on it.

---

## D. Config model

Four keys, all enums, no booleans. The `panel-` prefix is dropped (the keys
are new; `panel-engine` is renamed in the same change while there are no
released users, and the old name is simply gone — no migration).

```xml
<key name="engine" type="s">
  <choices><choice value="duckduckgo"/><choice value="google"/></choices>
  <default>'duckduckgo'</default>
  <summary>Results page engine</summary>
  <description>Which engine's results page is rendered in the overview. DuckDuckGo's
  HTML endpoint renders reliably; Google answers many networks (VPN exits in
  particular) with its "unusual traffic" check, which is reported rather than
  worked around.</description>
</key>

<key name="link-mode" type="s">
  <choices><choice value="contained"/><choice value="browser"/></choices>
  <default>'contained'</default>
  <summary>What a clicked link does</summary>
  <description>'contained' follows the link inside the overview's page and shows a
  back control with the number of pages followed; middle-click or Ctrl+click
  still opens a link in the browser. 'browser' hands every link to the default
  browser and closes the overview. Enter on the section always opens the current
  page in the browser.</description>
</key>

<key name="section-visibility" type="s">
  <choices><choice value="always"/><choice value="no-other-results"/></choices>
  <default>'always'</default>
  <summary>When the web results section is shown</summary>
  <description>'always' shows the section for every search. 'no-other-results'
  shows it only when no application, file or other provider matched; the
  browser's own "Search online" entry does not count as a match. The page is
  rendered either way, so showing it is instant.</description>
</key>

<key name="section-placement" type="s">
  <choices><choice value="top"/><choice value="after-apps"/><choice value="end"/></choices>
  <default>'after-apps'</default>
  <summary>Where the section sits among the search results</summary>
  <description>'top' pins it above every other section. 'after-apps' places it
  directly below the Applications section, so it is first whenever no app
  matched. 'end' leaves it where GNOME Shell puts it (after every other
  provider).</description>
</key>
```

Removed: `searxng-instance`, `panel-sidebar-visible`, `panel-sidebar-position`,
`panel-sidebar-width`, `panel-sidebar-limit`, `panel-engine`.

### D.1 Why these defaults

- **`link-mode = contained`.** The extension's premise is "search without being
  thrown into the browser". A link that leaves the overview on the first click
  contradicts that; contained keeps the promise and the browser is one
  middle-click, Enter, or icon away. The working tree already defaults the
  renderer to contained.
- **`section-visibility = always`.** Predictable: the section is where you left
  it, every time. `no-other-results` is the original pitch (it is still in
  `metadata.json`'s description — update that text if this default stands) but
  it makes the section appear and vanish depending on whether Clocks happened
  to match "h", and the user's screenshots show them using it alongside other
  results. It stays available for people who want the overview quiet.
- **`section-placement = after-apps`.** The Shell's `_maybeSetInitialSelection`
  picks the Enter target by *provider registration order* (Applications is
  always first), not by actor order. With `top`, the highlighted row that Enter
  activates would be an app row sitting *below* our 778 px card — visible only
  after scrolling. `after-apps` keeps the highlighted row first on screen and
  still puts us on top the moment no app matches, which is the "conditionally
  pinned" behaviour the user described.

### D.2 Preferences window (`src/prefs.ts`, libadwaita)

One `Adw.PreferencesPage` "General", two groups:

**Group "Results page"** — description: *The engine's results page is rendered
inside the Activities overview as you type. Scroll, click and type in it as
usual.*

| Row | Widget | Choices |
|---|---|---|
| Engine | `Adw.ComboRow` → `engine` | DuckDuckGo · Google (subtitle: "Google refuses many networks with a bot check; that is reported, not worked around") |
| Links open | `Adw.ComboRow` → `link-mode` | "In the results page" · "In your browser" (subtitle: "Middle-click or Ctrl+click always uses the browser; Enter opens the page you are looking at") |

**Group "In the overview"** — description: *Where and when the section appears
among the other search results.*

| Row | Widget | Choices |
|---|---|---|
| Show | `Adw.ComboRow` → `section-visibility` | "Always" · "Only when nothing else matches" |
| Position | `Adw.ComboRow` → `section-placement` | "At the top" · "After applications" · "At the end" |

No `SwitchRow` is needed; the existing `choiceRow()` helper covers all four.
Every row is live — `PageView` listens to `changed::` on each key and applies
without reopening the overview (`link-mode` → `renderer.setLinkMode`,
`engine` → new search, the two section keys → § F.2/F.3 re-evaluation).

---

## E. Perceived speed — ranked by payoff

Pipeline today, last keystroke → pixels: Shell timer (up to 150 ms; it is a
*throttle*, armed on the first keystroke of a burst) → our debounce 450 ms →
`Search` → network (DDG HTML ≈ 300–900 ms) → progressive frames (≈ 20 ms each at
the new size). Cold start adds ≈ 400 ms once per renderer lifetime.

1. **Debounce 450 → 200 ms, with a 400 ms floor between `Search` calls.**
   Payoff: −250 ms on every search, the single largest win. Risk: more
   requests to `html.duckduckgo.com` while typing multi-word queries ("gnome
   shell" fires at the space). The floor caps it at 2.5 req/s worst case; DDG's
   HTML endpoint tolerates that, its anomaly page has never triggered at that
   rate in testing here — but keep `blocked` detection ready to name it if it
   does. Google is not a concern (it blocks on IP, not rate). Below 200 ms the
   Shell's own 150 ms throttle makes the difference invisible.
2. **Prewarm the renderer on `Main.overview` `'showing'`** (public signal), via
   the existing `RendererClient.prewarm()`. Super is pressed ≥ 300 ms before the
   first character lands, so the ≈ 400 ms spawn is mostly hidden; a warm
   renderer's first search costs nothing extra. Also call `configure()` at
   prewarm with the last known size (keep `_lastConfigure` across views — it
   already survives in `RendererClient`) so the first frame is the right size,
   and have the renderer call `WebContext.prefetch_dns()` for the engine host
   on start. Do **not** spawn at `enable()`: that is login, and every
   extension spawning WebKit at login is how sessions get slow. Risk: ≈ 120 MB
   RSS for WebKit's three processes while the overview is open and for 15
   minutes after (`IDLE_EXIT_S`); acceptable, and the idle exit keeps it
   bounded. If memory complaints appear, the knob is `IDLE_EXIT_S`, not the
   prewarm.
3. **Keep the previous page on screen while the next loads — already true,
   keep it that way.** The texture only changes when a frame arrives; WebKit
   paints the old document until the new one commits; the injected CSS is
   applied at document start, so the engine's own chrome never flashes. Rule
   for the implementation: nothing in `PageView` may hide, clear or grey the
   frame on `loading`. The only exception is the notice panel on
   `blocked`/`error`.
4. **Show loading only when it is slow: spinner after 250 ms.** Start a
   250 ms timer on `State('loading')`; `spinner.play()` when it fires;
   `stop()` on `ready`/`blocked`/`error`. Most DDG loads finish before it
   shows, so the header stops flickering per keystroke. No text changes.
   Rejected alternative: a 2 px accent progress line under the header — nicer
   under a web page, but it is a custom looping animation (`translation_x`
   with `repeatCount: -1`) where the Shell's `Spinner` is ten lines and
   already looks like every other Shell wait.
5. **No skeleton, no placeholder art.** The previous page *is* the placeholder.
   For the very first search of a session there is nothing to keep: the card
   shows the header, an empty frame area in the card colour, and after 250 ms
   the spinner. Drawing fake result rows would be visible for < 1 s and would
   be one more thing to keep in sync with two engines' layouts.
6. **No crossfade between pages.** A crossfade needs the previous frame kept
   in a second `St.ImageContent` and an opacity ease on the top actor —
   another 3.6 MB texture per swap. Results page → results page is the same
   layout with different rows; a hard cut reads as "updated", a fade reads as
   "loading". Skip. Revisit only for results → followed page if it ever looks
   jarring; it does not in browsers.
7. **Frame cost at the new size.** 1247 × 720 × 4 = 3.6 MB per frame vs 1.5 MB
   at 812 × 464. Measured read-back scales linearly (7–10 ms → ≈ 20 ms), so a
   wheel notch will show in ≈ 45 ms instead of ≈ 35. Still one frame per
   notch. Nothing to do now; if it ever matters, the renderer could export
   only the damaged rows (`damage-event` currently reports the whole view).
8. **`section-visibility = no-other-results` still renders.** The renderer is
   asked to load regardless of whether the section is shown, so when the other
   providers come back empty the page is already there. Cost is one page load
   per search that may never be seen; that is the trade the key's description
   states.

---

## F. Shell internals used, and the fallback for each

| Use | What it relies on | Verified in | Fallback if absent |
|---|---|---|---|
| F.1 Hide the provider column, tag the card | Actor tree: `PageView` → parent `.list-search-results` → parent `.search-section-content` (holds `ProviderInfo.search-provider-icon` first) → `St.Bin` → `.search-section`. All `St.BoxLayout`/`St.Bin`, checked with `has_style_class_name` at each hop | `ui/search.js` `ListSearchResults._init` | walk fails a check → do nothing; Shell default look (today's) |
| F.2 `section-visibility` | Sibling sections are children of `#searchResultsContent`; each `ListSearchResults`/`GridSearchResults` has a public-ish `.provider` with `.id` / `.appInfo`. The browser's "Search online" (Ubuntu's `web-search-provider@ubuntu.com`) has `provider.appInfo.get_id() === Gio.AppInfo.get_default_for_uri_scheme('https').get_id()`; Epiphany's own remote provider never appears alongside it (that extension skips itself when Web is the default) | `ui/search.js` `SearchResultsBase._init`, `/usr/share/gnome-shell/extensions/web-search-provider@ubuntu.com/webSearcherSearchProvider.js` | a sibling without `.provider` counts as "other results" (conservative: hides us) |
| F.2 timing | The Shell calls `display.show()` inside `updateSearch` on every search; we re-evaluate synchronously in `notify::visible` of our own section and each sibling's, plus `child-added`/`child-removed` on `#searchResultsContent` (remote providers are destroyed and re-appended on `installed-changed`). Hiding synchronously means no painted flash, and `_maybeSetInitialSelection` (which runs after `updateSearch`) skips a hidden display. Because other providers answer asynchronously, in `no-other-results` mode hold our section hidden for **150 ms after each terms change** before the first evaluation, so it does not blink in and out while Clocks is still answering | `ui/search.js` `SearchResultsBase.updateSearch`, `SearchResultsView._updateResults` | none needed; the worst case is a section that shows when it should not |
| F.3 `section-placement` | `#searchResultsContent` is an `St.BoxLayout` (`MaxWidthBox`), so `set_child_at_index(ourSection, i)` reorders it. `top` → 0; `after-apps` → index of the sibling with `provider.id === 'applications'` + 1 (else 0); `end` → leave. Re-apply on `child-added`/`child-removed` (remote reload appends new displays at the end). Enter target is *not* affected (registration order, see D.1) | `ui/search.js` `SearchResultsView._ensureProviderDisplay`, `ui/appDisplay.js` `AppSearchProvider.id = 'applications'` | do nothing → `end` |
| F.4 Prewarm hook | `Main.overview.connect('showing', …)` — a documented `Overview` signal | `ui/overview.js` | `notify::search-active` on `Main.overview.searchController` (fires at first keystroke; ~300 ms later than `showing`) |
| F.5 Enter hint | Our result actor receives `add_style_pseudo_class('selected')` from `_setSelected`; listen on `style-changed` and read `has_style_pseudo_class('selected')` | `ui/search.js` `SearchResultsView._setSelected` | hint never shows |
| F.6 Animation | `actor.ease({...})` with `duration`, `mode`, `delay`, `repeatCount`, `autoReverse`, `onComplete` — added to `Clutter.Actor` by the Shell | `ui/environment.js` `_easeActor` | n/a (always present in the Shell) |
| F.7 Spinner | `import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js'`; `new Spinner(16, {animate: true, hideOnStop: true})`, `.play()`, `.stop()` | `ui/animation.js` | a `St.Icon('content-loading-symbolic')` toggled on the same timer |
| F.8 Stylesheet | `stylesheet.css` in the extension dir is loaded on enable (`stylesheet-dark.css`/`-light.css` variants also supported, not needed here) | `ui/extensionSystem.js` `_loadExtensionStylesheet` | n/a |

Everything else (`Main.overview.searchEntry`, `Main.overview.searchController.addProvider`, `Gio.AppInfo`) is public API already in use.

---

## G. Icons (all verified present in `/usr/share/icons/Adwaita/symbolic/` on this machine; Yaru, the active theme, ships its own copies of each)

| Purpose | Icon | Adwaita path |
|---|---|---|
| back pill | `go-previous-symbolic` (+ `go-previous-symbolic-rtl`) | `actions/` |
| open current page in browser | `web-browser-symbolic` | `legacy/` (still resolvable; Yaru has it in `apps/`) |
| provider `appInfo` icon (now hidden, keep for the Shell's a11y tree) | `web-browser-symbolic` | `legacy/` |
| loading fallback (F.7) | `content-loading-symbolic` | `status/` |

Not available and therefore not used: `external-link-symbolic`,
`adw-external-link-symbolic` (libadwaita resource, invisible to St),
`emblem-ok-symbolic`.

---

## H. Change list this spec implies (for the implementer)

Shell side (`src/`):

- `pageView.ts`: remove the sidebar and both header buttons; new header
  (§ B.1); back pill + `open` button + spinner + hint; `Nav` listener; Alt+Left
  / button 8; `activate()` depth-aware; provider-column hide + card tagging
  (§ A.1); `section-visibility`/`section-placement` evaluation (§ F.2–F.3);
  `PAGE_HEIGHT_SHARE = 0.60`, min 360, max 1200; expose `navigated`.
- `searchProvider.ts`: `RENDER_DEBOUNCE_MS = 200` + 400 ms floor; force
  `renderer.search` when `view.navigated` (§ C.4).
- `extension.ts`: `Main.overview` `'showing'` → `renderer.prewarm()`;
  `settings` → `renderer.setLinkMode` on `link-mode`.
- `rendererClient.ts`: already has `prewarm/back/openCurrent/setLinkMode/onNav`
  (working tree); add `onRefused` if § C.6's signal is added.
- `prefs.ts`: two groups, four combo rows (§ D.2).
- `schemas/*.gschema.xml`: the four keys in § D; remove the six listed there.
- `stylesheet.css`: § A.5; `scripts/build.mjs` copies it.
- `metadata.json`: description no longer claims "only when GNOME has no
  matching apps" unless the default flips to `no-other-results`.

Renderer side (`panel/sds-renderer.js`), on top of the working-tree diff:

- `pageCss()`: centred 880 px column (§ A.3).
- `_onDecidePolicy`: middle-click / Ctrl+click → `_launch` even in contained
  mode (§ C.1); optional `Refused(uri)` signal for non-http(s) links (§ C.6).
- `prefetch_dns(engine host)` on construction (§ E.2).

Docs: `README.md` "Usage" and `docs/ARCHITECTURE.md` (data-flow diagram,
"Navigation bridging", the GSettings paragraph) describe the sidebar, F9, the
450 ms debounce and browser-only links; update them in the same change.
