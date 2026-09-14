#!/usr/bin/env -S gjs -m
/**
 * sds-renderer.js — the searchDOESsearch page renderer.
 *
 * GNOME Shell is a Clutter compositor: it cannot host a GTK or WebKit widget on
 * its stage. So the results page is rendered here, in a separate process, into
 * an off-screen GTK window that never appears on screen, and every repaint is
 * exported as raw pixels for the Shell to show inside the overview:
 *
 *   Shell extension ──D-Bus──▶ io.github.searchdoessearch.Renderer (this file)
 *     Search / Configure / Scroll / Pointer / Key / Quit          (methods)
 *     ◀── Frame(path, width, height, stride, serial)               (signal)
 *     ◀── State(state, detail) · Launched(url)                     (signals)
 *
 * Frame transport: WebKit paints into a Gtk.OffscreenWindow. Its `damage-event`
 * marks a repaint; the window's pixels are read once per repaint (coalesced,
 * rate-limited) and written as raw RGBA to a file in $XDG_RUNTIME_DIR (tmpfs),
 * alternating between two files and replacing atomically, so a reader never sees
 * a half-written frame. The Shell maps the file and uploads it as a texture. No
 * PNG encode/decode is involved anywhere.
 *
 * Input: the Shell forwards its pointer, scroll and key events as-is. They are
 * re-issued here as real GDK events on the WebView, so hover, scrolling, text
 * fields, selection and focus behave exactly as they would in a visible WebKit
 * view — nothing is approximated through JavaScript.
 *
 * Navigation: the load we asked for and the engine's own redirects always render
 * here. What happens to a clicked link depends on the link mode the Shell sets —
 * `browser` hands it to the default browser (http(s) only) and reports it with
 * `Launched`, `contained` follows it in this view and reports the new depth with
 * `Nav`, so the Shell can offer a back arrow. Depth counts links followed since
 * the results page; `Back` walks it down, and a new `Search` resets it to zero.
 *
 * Only the first D-Bus caller (the Shell) may drive the renderer; it exits when
 * that caller disappears, when asked, or after a long idle period.
 *
 * Stack: GJS + Gtk 3.0 + WebKit2 4.1 (the WebKit typelib shipped on the target).
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// --- process environment, decided before GTK initialises ---------------------
//
// Frames are exported in device pixels. GDK's own HiDPI scaling would double the
// window behind our back; the Shell tells us its scale factor and WebKit's zoom
// applies it instead, so frame size == what we were asked for.
GLib.setenv('GDK_SCALE', '1', true);
GLib.setenv('GDK_DPI_SCALE', '1', true);
// Overlay scrollbars animate: measured 100+ repaints per idle 4s and a ~1s burst
// after every scroll or hover, each a full frame export. Classic scrollbars give
// zero idle repaints and exactly one frame per scroll.
GLib.setenv('GTK_OVERLAY_SCROLLING', '0', true);
// A session without an accessibility bus (nested/headless shells) makes
// libatk-bridge crash at GTK init. Only load the bridge when the bus exists.
if (!GLib.getenv('NO_AT_BRIDGE')) {
  let hasA11y = false;
  try {
    const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    const reply = bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus', 'GetAddress',
      null, null, Gio.DBusCallFlags.NONE, 1500, null);
    hasA11y = !!reply.deep_unpack()[0];
  } catch { hasA11y = false; }
  if (!hasA11y) GLib.setenv('NO_AT_BRIDGE', '1', true);
}

const Gtk = (await import('gi://Gtk?version=3.0')).default;
const Gdk = (await import('gi://Gdk?version=3.0')).default;
const WebKit2 = (await import('gi://WebKit2?version=4.1')).default;
const Pango = (await import('gi://Pango')).default;
const System = (await import('system')).default;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const BUS_NAME = 'io.github.searchdoessearch.Renderer';
export const OBJECT_PATH = '/io/github/searchdoessearch/Renderer';
const DEBUG = !!GLib.getenv('SDS_DEBUG');
const DUMP_HTML = GLib.getenv('SDS_DUMP_HTML') || '';
// A browser UA: DuckDuckGo's HTML endpoint serves a plain, JS-free SERP to it.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
// Repaints arrive in bursts; wait this long for the burst to settle before
// reading pixels, and never export more often than this.
const FRAME_COALESCE_MS = 6;
const FRAME_MIN_INTERVAL_MS = 16;
// One more export this long after the last repaint, to catch a region WebKit
// finished painting after it announced the damage.
const FRAME_SETTLE_MS = 150;
// Pointer motion is the only event the Shell can send hundreds of per second;
// it is coalesced to the newest position at this rate.
const MOTION_INTERVAL_MS = 24;
const IDLE_EXIT_S = 15 * 60;

const enc = encodeURIComponent;
const now = () => GLib.get_monotonic_time() / 1000;

export const INTERFACE_XML = `
<node>
  <interface name="${BUS_NAME}">
    <method name="Search">
      <arg type="s" name="query" direction="in"/>
      <arg type="s" name="engine" direction="in"/>
    </method>
    <method name="Configure">
      <arg type="i" name="width" direction="in"/>
      <arg type="i" name="height" direction="in"/>
      <arg type="d" name="scale" direction="in"/>
    </method>
    <method name="Scroll">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
      <arg type="d" name="dx" direction="in"/>
      <arg type="d" name="dy" direction="in"/>
    </method>
    <method name="Pointer">
      <arg type="s" name="kind" direction="in"/>
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
      <arg type="u" name="button" direction="in"/>
      <arg type="u" name="state" direction="in"/>
      <arg type="u" name="clicks" direction="in"/>
    </method>
    <method name="Key">
      <arg type="s" name="kind" direction="in"/>
      <arg type="u" name="keyval" direction="in"/>
      <arg type="u" name="keycode" direction="in"/>
      <arg type="u" name="state" direction="in"/>
    </method>
    <method name="Back"/>
    <method name="OpenCurrent"/>
    <method name="SetLinkMode">
      <arg type="s" name="mode" direction="in"/>
    </method>
    <method name="Reload"/>
    <method name="Refresh"/>
    <method name="Quit"/>
    <signal name="Frame">
      <arg type="s" name="path"/>
      <arg type="u" name="width"/>
      <arg type="u" name="height"/>
      <arg type="u" name="stride"/>
      <arg type="u" name="serial"/>
    </signal>
    <signal name="State">
      <arg type="s" name="state"/>
      <arg type="s" name="detail"/>
      <arg type="s" name="query"/>
    </signal>
    <signal name="Launched">
      <arg type="s" name="url"/>
    </signal>
    <signal name="Nav">
      <arg type="u" name="depth"/>
      <arg type="s" name="title"/>
      <arg type="s" name="uri"/>
    </signal>
    <signal name="Refused">
      <arg type="s" name="scheme"/>
    </signal>
  </interface>
</node>`;

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/**
 * The engine whose page is rendered. `hosts` decides which programmatic loads
 * may stay inside the view (the engine's own redirects); `blocked` names the
 * interstitial the renderer refuses to fight — it reports it instead.
 */
const ENGINES = {
  duckduckgo: {
    label: 'DuckDuckGo',
    serp: q => `https://html.duckduckgo.com/html/?q=${enc(q)}`,
    hosts: /(^|\.)duckduckgo\.com$/i,
    // WebKit URL patterns: the engine's own stylesheet is scoped to these, so a
    // page the user followed renders as itself rather than as a mangled SERP.
    match: ['*://*.duckduckgo.com/*'],
    blocked: () => null,
  },
  google: {
    label: 'Google',
    serp: q => `https://www.google.com/search?q=${enc(q)}`,
    hosts: /(^|\.)google\.[a-z.]+$/i,
    // serp() always loads www.google.com; a country-domain redirect renders
    // unstyled rather than mangled, which is the safe way round.
    match: ['*://*.google.com/*'],
    // "Our systems have detected unusual traffic from your computer network."
    blocked: uri => (/\/sorry(\/|$)/.test(pathOf(uri)) ? 'unusual-traffic' : null),
  },
};

function engineFor(id) {
  return ENGINES[id] ?? ENGINES.duckduckgo;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function parseUri(url) {
  try {
    return GLib.Uri.parse(url, GLib.UriFlags.PARSE_RELAXED);
  } catch {
    return null;
  }
}

function pathOf(url) {
  return parseUri(url)?.get_path() ?? '';
}

function hostOf(url) {
  return parseUri(url)?.get_host() ?? '';
}

/**
 * Same rule as src/browserLauncher.ts: only plain http(s) may be handed to the
 * desktop's URI handler. Everything reaching here came from a remote page.
 */
/** A page's own plumbing, never something the user asked for. */
const INTERNAL_SCHEMES = /^(about|blob|data|javascript|file)$/i;

/** The navigation type of a decision, for the branches that read it before `action`. */
function navTypeOf(decision) {
  try {
    return decision.get_navigation_action().get_navigation_type();
  } catch {
    return null;
  }
}

function isSafeHttpUrl(url) {
  const scheme = parseUri(url)?.get_scheme();
  return scheme === 'http' || scheme === 'https';
}

/**
 * Engines wrap result links in a tracking hop:
 *   //duckduckgo.com/l/?uddg=<url>&rut=…
 *   https://www.google.com/url?q=<url>&sa=…
 * Unwrap so the browser gets the destination, not the hop.
 */
function unwrapRedirect(url) {
  const uri = parseUri(url);
  if (!uri) return url;
  const host = uri.get_host() ?? '';
  const path = uri.get_path();
  let key = null;
  if (/(^|\.)duckduckgo\.com$/i.test(host) && path === '/l/') key = 'uddg';
  else if (/(^|\.)google\.[a-z.]+$/i.test(host) && path === '/url') key = 'q';
  if (!key) return url;
  try {
    const params = GLib.Uri.parse_params(uri.get_query() ?? '', -1, '&', GLib.UriParamsFlags.NONE);
    const target = params[key] || params['url'];
    return target && isSafeHttpUrl(target) ? target : url;
  } catch {
    return url;
  }
}

function openInDefaultBrowser(url) {
  const target = unwrapRedirect(url);
  if (!isSafeHttpUrl(target)) {
    console.warn(`[sds-renderer] refusing to open non-http(s) URL: ${target}`);
    return null;
  }
  if (GLib.getenv('SDS_NO_LAUNCH')) return target; // tests: report, do not open
  try {
    Gio.AppInfo.launch_default_for_uri(target, null);
    return target;
  } catch (err) {
    try {
      GLib.spawn_command_line_async(`xdg-open ${GLib.shell_quote(target)}`);
      return target;
    } catch (fallbackErr) {
      console.warn(`[sds-renderer] failed to open browser: ${err}; ${fallbackErr}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
//
// The page has no palette of its own. Its colours and font are read from the
// live GTK theme (theme_base_color, the :link colour, gtk-font-name) and the
// desktop's light/dark preference, so the rendered page matches the desktop.

/**
 * The desktop's light/dark choice. GTK 3 does not read `color-scheme` itself,
 * so the dark variant of the theme is requested when the desktop prefers dark.
 */
function systemPrefersDark() {
  try {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return iface.get_string('color-scheme') === 'prefer-dark';
  } catch {
    return false;
  }
}

/** Colours and font of the GTK theme currently applied to `widget`. */
function readTheme(widget) {
  const ctx = widget.get_style_context();
  const color = (name, fallback) => {
    const [ok, rgba] = ctx.lookup_color(name);
    return ok ? rgba.to_string() : fallback;
  };
  let link;
  try {
    link = new Gtk.Label().get_style_context().get_color(Gtk.StateFlags.LINK).to_string();
  } catch {
    link = color('theme_selected_bg_color', 'rgb(53,132,228)');
  }
  const settings = Gtk.Settings.get_default();
  const font = Pango.FontDescription.from_string(settings.gtk_font_name || 'Sans 10');
  const family = font.get_family() || 'sans-serif';
  const pt = font.get_size() > 0 ? font.get_size() / Pango.SCALE : 10;
  return {
    bg: color('theme_base_color', 'rgb(255,255,255)'),
    text: color('theme_text_color', 'rgb(0,0,0)'),
    fg: color('theme_fg_color', 'rgb(46,52,54)'),
    dim: color('insensitive_fg_color', 'rgb(146,149,149)'),
    border: color('borders', 'rgb(205,199,194)'),
    selBg: color('theme_selected_bg_color', 'rgb(53,132,228)'),
    selFg: color('theme_selected_fg_color', 'rgb(255,255,255)'),
    link,
    family,
    pt,
    px: Math.round(pt * 96 / 72),
  };
}

// Injected at document start, so the engine's own chrome never flashes. One
// rule set per engine: strip search form, logo, nav and footer, then lay the
// results out compactly in the theme's colours and font.
function pageCss(engineId, t) {
  const common = `
  html, body { background: ${t.bg} !important; color: ${t.text} !important; margin: 0 !important; }
  body { padding: 0 !important; font-family: "${t.family}", system-ui, sans-serif !important; font-size: ${t.pt}pt !important; }
  ::selection { background: ${t.selBg}; color: ${t.selFg}; }
  * { -webkit-tap-highlight-color: transparent; }
  a { color: ${t.link}; }
  `;
  const hover = `color-mix(in srgb, ${t.text} 6%, transparent)`;
  if (engineId === 'google') {
    // Google's SERP is JS-built and its class names churn; anchor on the stable
    // ids/roles it has kept for years.
    return common + `
  #searchform, #sfcnt, #tsf, form[role="search"], header, #top_nav, #hdtb, #appbar,
  #gb, #gbar, #footcnt, #foot, #fbar, #botstuff, #bottomads, #tads,
  #sbfrm_l, .sfbg, .minidiv, #searchbox, #before-appbar, #easter-egg, #lfootercc,
  #tvcap, .commercial-unit-desktop-top, #rhs, [aria-label="Search"] { display: none !important; }
  #main, #cnt, #rcnt, #center_col, #res, #search, #rso {
    margin: 0 !important; padding: 0 !important; max-width: none !important; width: auto !important;
  }
  /* Centred: the frame is as wide as the overview card, and a column pinned to
     its left edge reads as a mistake. 880px is 70-80 characters at 11pt — the
     readable band — and leaves even margins instead of 40% dead space. */
  #rso { padding: 10px 20px 24px 20px !important; max-width: 880px; margin: 0 auto !important; }
  #rso > div, .g { padding: 8px 10px !important; margin: 0 0 2px 0 !important; border-radius: 8px !important; }
  #rso > div:hover, .g:hover { background: ${hover} !important; }
  h3 { font-size: 1.05em !important; line-height: 1.35 !important; color: ${t.link} !important; }
  cite { color: ${t.dim} !important; font-size: 0.85em !important; }
  `;
  }
  return common + `
  #header, .header, .header--html, .header__form, .header__logo-wrap,
  .search--header, form.search, .search__input, .search__button,
  .feedback-btn, .nav-link, .site-wrapper-border, #bottom_spacing2,
  .frm__select, .result--ad, .result__icon, .result--sep, .results--ads,
  .msg--spelling, .zci-wrapper, .no-results--error, .result__extras__url > span,
  form[action="/html/"] > input[type="submit"], .results_links_deep .result__check,
  #links_wrapper > form > .nav-link {
    display: none !important;
  }
  .body--html { background: ${t.bg} !important; }
  .serp__results, #links, .results, .site-wrapper, .serp__top-right, .serp {
    width: auto !important; max-width: none !important; min-width: 0 !important;
    padding: 0 !important; margin: 0 !important;
  }
  /* Centred: the frame is as wide as the overview card, and a column pinned to
     its left edge reads as a mistake. 880px is 70-80 characters at 11pt — the
     readable band — and leaves even margins instead of 40% dead space. */
  #links { padding: 10px 20px 24px 20px !important; max-width: 880px; margin: 0 auto !important; }
  .results_links, .results_links_deep, .web-result { margin: 0 !important; padding: 0 !important; }
  .result {
    padding: 8px 12px 9px 12px !important; margin: 0 0 4px 0 !important;
    border: none !important; border-radius: 8px !important;
  }
  .result:hover { background: ${hover} !important; }
  .links_main, .result__body { padding-left: 0 !important; margin: 0 !important; }
  .result__title { font-size: 1.05em !important; line-height: 1.35 !important; margin: 0 !important; }
  .result__a, .result__a:visited { color: ${t.link} !important; text-decoration: none !important; }
  .result__a:hover { text-decoration: underline !important; }
  .result__snippet, .result__snippet b {
    color: ${t.text} !important; opacity: 0.85; font-size: 0.95em !important; line-height: 1.45 !important;
    margin: 2px 0 0 0 !important; text-decoration: none !important;
  }
  .result__extras, .result__extras__url { margin: 2px 0 0 0 !important; }
  .result__url, .result__url:hover { color: ${t.dim} !important; font-size: 0.85em !important; text-decoration: none !important; }
  .result__snippet b, .result__snippet strong { font-weight: 600 !important; opacity: 1; }
  `;
}

// ---------------------------------------------------------------------------
// Frame export
// ---------------------------------------------------------------------------

/**
 * Two alternating raw-RGBA files in the runtime dir. The alternation is what
 * keeps a reader safe: the Shell is told about frame N only once it is written,
 * and the next write goes to the *other* file, so a slow reader still maps a
 * complete frame rather than one being overwritten under it.
 */
class FrameFiles {
  constructor() {
    this.dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'searchdoessearch']);
    GLib.mkdir_with_parents(this.dir, 0o700);
    this._n = 0;
  }
  write(data) {
    this._n ^= 1;
    const path = GLib.build_filenamev([this.dir, `frame-${this._n}.raw`]);
    GLib.file_set_contents_full(path, data, GLib.FileSetContentsFlags.NONE, 0o600);
    return path;
  }
  remove() {
    for (const n of [0, 1]) {
      try { Gio.File.new_for_path(GLib.build_filenamev([this.dir, `frame-${n}.raw`])).delete(null); } catch { /* absent */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

class Renderer {
  constructor(onExit) {
    this._onExit = onExit;
    this._query = '';
    this._engineId = 'duckduckgo';
    this._width = DEFAULT_WIDTH;
    this._height = DEFAULT_HEIGHT;
    this._scale = 1;
    this._serial = 0;
    this._frameTimer = 0;
    this._settleTimer = 0;
    this._lastFrameAt = 0;
    this._frames = new FrameFiles();
    this._blocked = false;
    this._loading = false;
    // Contained browsing: links followed since the results page. 0 means the
    // results page itself, which is what the Shell shows no back arrow for.
    this._linkMode = 'contained';
    this._depth = 0;
    this._pendingDepth = 0;
    this._goingBack = false;
    this._handedOff = false;
    this._stateDetail = '';
    this._motion = null;
    this._motionTimer = 0;
    this._buttonsDown = 0;
    this._touchIdle();

    this.window = new Gtk.OffscreenWindow();
    this.window.set_size_request(this._width, this._height);
    Gtk.Settings.get_default().gtk_application_prefer_dark_theme = systemPrefersDark();

    this._ucm = new WebKit2.UserContentManager();
    this._web = new WebKit2.WebView({user_content_manager: this._ucm, web_context: this._buildWebContext()});
    const settings = this._web.get_settings();
    settings.set_user_agent(USER_AGENT);
    settings.set_enable_javascript(true);
    settings.set_enable_developer_extras(false);
    // Pixels are read back through cairo; GPU compositing would only add a copy.
    settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER);
    // Smooth scrolling animates over several frames; each is a full export.
    settings.set_enable_smooth_scrolling(false);
    this.window.add(this._web);
    this.window.show_all();

    this._web.connect('decide-policy', (_v, decision, type) => this._onDecidePolicy(decision, type));
    this._web.connect('load-changed', (_v, ev) => this._onLoadChanged(ev));
    this._web.connect('load-failed', (_v, _ev, _uri, err) => {
      if (err.matches(WebKit2.NetworkError, WebKit2.NetworkError.CANCELLED)) return true;
      // Our own doing: a download handed to the browser, or a policy we set.
      if (this._handedOff || err.matches(WebKit2.PolicyError, WebKit2.PolicyError.CANNOT_SHOW_MIME_TYPE)
          || err.matches(WebKit2.PolicyError, WebKit2.PolicyError.FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE)) {
        this._handedOff = false;
        this._pendingDepth = 0;
        this._loading = false;
        return true;
      }
      this._loading = false;
      // The step was taken off the counter before the navigation was known to
      // work; if it did not, put it back, or the user is left on a page with no
      // way back from it.
      if (this._goingBack) {
        this._goingBack = false;
        this._depth += 1;
        this._emitNav();
      }
      // Name what actually failed: the engine at the results page, the site the
      // user followed once they are deeper than that.
      const what = this._depth > 0 || this._pendingDepth > 0
        ? (hostOf(this._web.get_uri() ?? '') || 'The page') : this._engine.label;
      this._pendingDepth = 0;
      this._setState('error', `${what} could not be loaded: ${err.message}`);
      return true;
    });
    this._web.connect('create', (_v, navAction) => {
      const uri = navAction.get_request().get_uri();
      // A popup or target=_blank link. There is no second view to open it in,
      // so it either continues here or goes to the browser, like any other link.
      if (this._linkMode === 'contained' && isSafeHttpUrl(uri)) this._follow(uri);
      else this._launch(uri);
      return null;
    });
    // Every repaint of the off-screen window is a candidate frame.
    this.window.connect('damage-event', () => {
      this._scheduleFrame();
      return false;
    });

    this._applyPageStyle();
    try {
      this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
      this._iface.connect('changed::color-scheme', () => {
        Gtk.Settings.get_default().gtk_application_prefer_dark_theme = systemPrefersDark();
        this._applyPageStyle();
      });
    } catch { /* no desktop schema: GTK's own theme setting decides */ }
    this.window.get_style_context().connect('changed', () => this._applyPageStyle());
    Gtk.Settings.get_default().connect('notify::gtk-font-name', () => this._applyPageStyle());

    this._web.connect('notify::title', () => {
      if (this._depth > 0) this._emitNav();
    });

    // The name lookup for the engine is on the critical path of the first
    // search; start it now, while the overview is still animating open.
    try {
      this._web.get_context().prefetch_dns('html.duckduckgo.com');
      this._web.get_context().prefetch_dns('www.google.com');
    } catch { /* older WebKit: one DNS lookup slower, nothing else */ }

    this._seat = Gdk.Display.get_default().get_default_seat();
    this.emitSignal = () => {};
  }

  get _engine() { return engineFor(this._engineId); }

  /**
   * A persistent profile: cookies and site data survive between runs, so the
   * engine sees a returning client rather than a brand-new one every time.
   */
  _buildWebContext() {
    const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'search-does-search', 'webkit']);
    const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'search-does-search', 'webkit']);
    GLib.mkdir_with_parents(dataDir, 0o700);
    GLib.mkdir_with_parents(cacheDir, 0o700);
    const manager = new WebKit2.WebsiteDataManager({base_data_directory: dataDir, base_cache_directory: cacheDir});
    const context = new WebKit2.WebContext({website_data_manager: manager});
    const cookies = manager.get_cookie_manager();
    cookies.set_persistent_storage(GLib.build_filenamev([dataDir, 'cookies.sqlite']), WebKit2.CookiePersistentStorage.SQLITE);
    cookies.set_accept_policy(WebKit2.CookieAcceptPolicy.NO_THIRD_PARTY);
    return context;
  }

  // --- theme ---------------------------------------------------------------

  _applyPageStyle() {
    const theme = readTheme(this.window);
    const same = JSON.stringify(theme) + this._engineId;
    if (same === this._appliedStyle) return;
    this._appliedStyle = same;
    this._ucm.remove_all_style_sheets();
    this._ucm.add_style_sheet(new WebKit2.UserStyleSheet(
      pageCss(this._engineId, theme), WebKit2.UserContentInjectedFrames.ALL_FRAMES,
      WebKit2.UserStyleLevel.USER, this._engine.match, null));
    // Followed links are ordinary sites: no rewriting, only the desktop's
    // light/dark preference, which a site that supports it will honour.
    this._ucm.add_style_sheet(new WebKit2.UserStyleSheet(
      `:root { color-scheme: ${systemPrefersDark() ? 'dark' : 'light'}; }`,
      WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserStyleLevel.USER, null, this._engine.match));
    const rgba = new Gdk.RGBA();
    rgba.parse(theme.bg);
    this._web.set_background_color(rgba);
    const ws = this._web.get_settings();
    ws.set_default_font_family(theme.family);
    ws.set_default_font_size(Math.round(theme.px));
  }

  // --- state & navigation ----------------------------------------------------

  /**
   * Every state names the query it belongs to. Without it the Shell cannot tell
   * "the page you asked for is ready" from "the page you asked for two
   * keystrokes ago is ready", and shows one query's results under another's.
   */
  _setState(state, detail = '') {
    this._state = state;
    this._stateDetail = detail;
    this.emitSignal('State', new GLib.Variant('(sss)', [state, detail, this._query]));
  }

  _launch(url) {
    const target = openInDefaultBrowser(url);
    if (DEBUG) printerr(`[sds-renderer] launch ${target ?? 'REFUSED'} (from ${url})`);
    if (target) this.emitSignal('Launched', new GLib.Variant('(s)', [target]));
  }

  _onLoadChanged(ev) {
    if (ev === WebKit2.LoadEvent.COMMITTED) {
      this._goingBack = false;
      // Counted on commit, not at the policy decision: a link that 404s at the
      // DNS stage never becomes a page the user can go back from.
      if (this._pendingDepth !== 0) {
        this._depth = Math.max(0, this._depth + this._pendingDepth);
        this._pendingDepth = 0;
        this._emitNav();
      }
    }
    if (ev === WebKit2.LoadEvent.COMMITTED || ev === WebKit2.LoadEvent.FINISHED) this._checkBlocked();
    if (ev === WebKit2.LoadEvent.FINISHED && !this._blocked) {
      this._loading = false;
      this._setState('ready', this._engine.label);
      this._emitNav();
      this._scheduleFrame();
      if (DUMP_HTML) this._dumpPage();
    }
  }

  /**
   * Where the user is: 0 is the results page, 1 is a link they followed from it.
   * The Shell turns this into the back arrow and its depth badge.
   */
  _emitNav() {
    const title = this._depth > 0 ? (this._web.get_title() || hostOf(this._web.get_uri() ?? '')) : '';
    const uri = this._depth > 0 ? (this._web.get_uri() ?? '') : '';
    this.emitSignal('Nav', new GLib.Variant('(uss)', [this._depth >>> 0, title, uri]));
  }

  /**
   * Follow a link inside this view; the depth is counted when the load commits.
   * The engine's tracking hop is unwrapped first: loading it verbatim commits a
   * blank redirect document, so the view flashes empty for a second and the
   * header names duckduckgo.com instead of where the user is going.
   */
  _follow(uri) {
    const target = unwrapRedirect(uri);
    this._pendingDepth = 1;
    this._loading = true;
    this._setState('loading', hostOf(target));
    this._web.load_uri(target);
  }

  /** Dev only (SDS_DUMP_HTML=<file>): what did the engine actually serve? */
  _dumpPage() {
    this._web.run_javascript(
      'JSON.stringify({uri: location.href, title: document.title, text: document.body.innerText.slice(0, 600), html: document.documentElement.outerHTML})',
      null, (view, res) => {
        try {
          const json = JSON.parse(view.run_javascript_finish(res).get_js_value().to_string());
          GLib.file_set_contents(DUMP_HTML, json.html);
          printerr(`[sds-renderer] page: ${json.uri}\n  title: ${json.title}\n  text: ${json.text.replace(/\s+/g, ' ').slice(0, 300)}`);
        } catch (e) {
          printerr(`[sds-renderer] dump failed: ${e}`);
        }
      });
  }

  /**
   * Google answers flagged networks with /sorry — a bot check. The renderer does
   * not try to get past it: it reports it and stops; the Shell offers the honest
   * exits (the other engine, or the real browser).
   */
  _checkBlocked() {
    if (this._blocked || this._depth > 0 || this._pendingDepth > 0) return;
    const uri = this._web.get_uri() ?? '';
    const reason = this._engine.blocked(uri);
    if (!reason) return;
    this._blocked = true;
    this._loading = false;
    this._web.stop_loading();
    this._setState('blocked', this._engine.label);
  }

  _onDecidePolicy(decision, type) {
    if (type === WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION) {
      const uri = decision.get_navigation_action().get_request().get_uri();
      if (this._linkMode === 'contained' && isSafeHttpUrl(uri)) this._follow(uri);
      else this._launch(uri);
      decision.ignore();
      return true;
    }
    // A response this view cannot display (a PDF, an archive) would otherwise
    // become a silent download into the user's Downloads folder. This is not a
    // browser; hand it to the one the user chose.
    if (type === WebKit2.PolicyDecisionType.RESPONSE) {
      if (decision.is_mime_type_supported()) return false;
      const uri = decision.get_request().get_uri();
      this._launch(uri);
      // Ignoring a *response* aborts the provisional load, and WebKit reports
      // that through load-failed with a PolicyError. That is this code's own
      // doing, not a page that broke: flag it so the error notice does not
      // replace a perfectly good results page behind the user's back.
      this._handedOff = true;
      decision.ignore();
      if (this._pendingDepth > 0) {
        this._pendingDepth = 0;
        this._loading = false;
        this._emitNav();
      }
      return true;
    }
    if (type !== WebKit2.PolicyDecisionType.NAVIGATION_ACTION) return false;

    const action = decision.get_navigation_action();
    const uri = action.get_request().get_uri();
    const navType = action.get_navigation_type();
    const onEngine = this._engine.hosts.test(hostOf(uri));

    if (!isSafeHttpUrl(uri)) {
      // mailto:, magnet:, a custom app scheme: handing a remote page's URI to
      // the desktop's handlers is a bigger surface than a search result needs,
      // so it is refused — and said out loud, but only when the user actually
      // clicked something. A page's own about:/blob:/data: loads are machinery
      // (iframes, ads) and reporting those would make the header lie.
      decision.ignore();
      const scheme = parseUri(uri)?.get_scheme() ?? '';
      const clicked = navTypeOf(decision) === WebKit2.NavigationType.LINK_CLICKED;
      if (clicked && !INTERNAL_SCHEMES.test(scheme)) {
        this.emitSignal('Refused', new GLib.Variant('(s)', [scheme || uri]));
      }
      return true;
    }
    // Back(), which drives the history itself: allow it, and let Back's own
    // bookkeeping own the depth.
    if (navType === WebKit2.NavigationType.BACK_FORWARD) {
      decision.use();
      return true;
    }
    // The load we asked for and the engine's own redirects and reloads may
    // render here: programmatic, no gesture, staying on the engine's hosts.
    const ownLoad = (navType === WebKit2.NavigationType.OTHER || navType === WebKit2.NavigationType.RELOAD)
      && !action.is_user_gesture() && onEngine;
    // A form the engine itself shows (a consent or region prompt) submits to
    // the engine; that is the page working, not a link to follow elsewhere.
    const engineForm = navType === WebKit2.NavigationType.FORM_SUBMITTED && onEngine;
    if (ownLoad || engineForm) {
      decision.use();
      return true;
    }
    // Middle-click and Ctrl+click mean "not here" in every browser; honour that
    // in contained mode rather than making the user change a setting.
    const toBrowser = action.get_mouse_button() === 2
      || (action.get_modifiers() & Gdk.ModifierType.CONTROL_MASK) !== 0;
    if (this._linkMode === 'contained' && !toBrowser) {
      // A redirect or reload the followed page issues itself is the same visit,
      // not another step back: only something the user did adds depth.
      const userStep = navType === WebKit2.NavigationType.LINK_CLICKED
        || navType === WebKit2.NavigationType.FORM_SUBMITTED
        || action.is_user_gesture();
      // The engine's own tracking hop is not a page anyone wants to look at or
      // go back to: skip straight to the destination.
      const target = unwrapRedirect(uri);
      if (target !== uri) {
        decision.ignore();
        if (userStep) this._follow(target);
        return true;
      }
      if (userStep) this._pendingDepth = 1;
      this._loading = true;
      this._setState('loading', hostOf(uri));
      decision.use();
      return true;
    }
    // Browser mode: every link is bridged out, and nothing navigates here.
    this._launch(uri);
    decision.ignore();
    return true;
  }

  // --- frames ----------------------------------------------------------------

  /**
   * WebKit can finish painting a region after the damage event that announced
   * it, and the export that followed catches the half-painted area — a grey
   * rectangle that never repairs itself, because nothing damages it again. One
   * more export after the repaints stop is what repairs it.
   */
  _scheduleSettleFrame() {
    if (this._settleTimer) GLib.source_remove(this._settleTimer);
    this._settleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_SETTLE_MS, () => {
      this._settleTimer = 0;
      this._exportFrame();
      return GLib.SOURCE_REMOVE;
    });
  }

  _scheduleFrame() {
    this._scheduleSettleFrame();
    if (this._frameTimer) return;
    const wait = Math.max(FRAME_COALESCE_MS, FRAME_MIN_INTERVAL_MS - (now() - this._lastFrameAt));
    this._frameTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
      this._frameTimer = 0;
      this._exportFrame();
      return GLib.SOURCE_REMOVE;
    });
  }

  _exportFrame() {
    const gdkWindow = this.window.get_window();
    if (!gdkWindow) return;
    const t0 = now();
    const pixbuf = Gdk.pixbuf_get_from_window(gdkWindow, 0, 0, this._width, this._height);
    if (!pixbuf) return;
    const t1 = now();
    const bytes = pixbuf.read_pixel_bytes();
    const path = this._frames.write(bytes.get_data());
    const t2 = now();
    this._lastFrameAt = t2;
    this._serial = (this._serial + 1) >>> 0;
    this.emitSignal('Frame', new GLib.Variant('(suuuu)',
      [path, pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride(), this._serial]));
    if (DEBUG) {
      printerr(`[sds-renderer] frame #${this._serial} ${pixbuf.get_width()}x${pixbuf.get_height()} ` +
        `readback ${(t1 - t0).toFixed(1)}ms write ${(t2 - t1).toFixed(1)}ms`);
    }
  }

  // --- input -----------------------------------------------------------------
  //
  // Events are rebuilt as GDK events and handed straight to the WebView widget.
  // GJS assigns `window` without taking a reference while gdk_event_free drops
  // one, so the field is cleared again right after dispatch to keep the
  // GdkWindow's count balanced.

  _dispatch(event, member, device) {
    const gdkWindow = this._web.get_window();
    if (!gdkWindow) return false;
    member.window = gdkWindow;
    member.time = Math.floor(now()) >>> 0;
    event.set_device(device);
    event.set_source_device(device);
    let handled = false;
    try {
      handled = this._web.event(event);
    } finally {
      member.window = null;
    }
    return handled;
  }

  _pointerEvent(type, x, y, button, state) {
    const event = Gdk.Event.new(type);
    const b = event.button;
    b.x = x; b.y = y; b.x_root = x; b.y_root = y;
    b.button = button; b.state = state;
    return this._dispatch(event, b, this._seat.get_pointer());
  }

  _motionEvent(x, y, state) {
    const event = Gdk.Event.new(Gdk.EventType.MOTION_NOTIFY);
    const m = event.motion;
    m.x = x; m.y = y; m.x_root = x; m.y_root = y;
    m.state = state; m.is_hint = 0;
    return this._dispatch(event, m, this._seat.get_pointer());
  }

  _scrollEvent(x, y, dx, dy) {
    const event = Gdk.Event.new(Gdk.EventType.SCROLL);
    const s = event.scroll;
    s.x = x; s.y = y; s.x_root = x; s.y_root = y;
    s.direction = Gdk.ScrollDirection.SMOOTH;
    s.delta_x = dx; s.delta_y = dy;
    s.is_stop = 0;
    return this._dispatch(event, s, this._seat.get_pointer());
  }

  _keyEvent(type, keyval, keycode, state) {
    const event = Gdk.Event.new(type);
    const k = event.key;
    k.keyval = keyval;
    k.state = state;
    if (keycode) {
      k.hardware_keycode = keycode;
    } else {
      const keymap = Gdk.Keymap.get_for_display(Gdk.Display.get_default());
      const [ok, keys] = keymap.get_entries_for_keyval(keyval);
      if (ok && keys.length) k.hardware_keycode = keys[0].keycode;
    }
    return this._dispatch(event, k, this._seat.get_keyboard());
  }

  _flushMotion() {
    this._motionTimer = 0;
    if (!this._motion) return;
    const {x, y, state} = this._motion;
    this._motion = null;
    this._motionEvent(x, y, state);
  }

  // --- D-Bus methods -----------------------------------------------------------

  Search(query, engine) {
    this._touchIdle();
    query = String(query).trim();
    if (!query) return;
    const engineId = ENGINES[engine] ? engine : 'duckduckgo';
    if (engineId !== this._engineId) {
      this._engineId = engineId;
      this._applyPageStyle();
    }
    this._query = query;
    this._blocked = false;
    this._loading = true;
    // A new search is the ground floor again: whatever the user had followed is
    // behind them, and the Shell drops the back arrow when depth reaches 0.
    this._depth = 0;
    this._pendingDepth = 0;
    this._goingBack = false;
    this._emitNav();
    this._setState('loading', this._engine.label);
    this._web.load_uri(this._engine.serp(query));
  }

  /**
   * One step back towards the results page. There is no forward: this is a way
   * back to the search, not a browser.
   */
  Back() {
    this._touchIdle();
    // WebKit's history index only moves when the navigation commits, so two
    // go_back() calls issued back to back both step off the same item: the user
    // would travel one page while the badge counted two.
    if (this._depth <= 0 || this._goingBack) return;
    this._goingBack = true;
    this._depth -= 1;
    this._pendingDepth = 0;
    this._loading = true;
    this._emitNav();
    this._setState('loading', this._depth === 0 ? this._engine.label : hostOf(this._web.get_uri() ?? ''));
    if (this._web.can_go_back()) {
      this._web.go_back();
    } else if (this._query) {
      // Nothing in the history to step to (a page that replaced its own entry):
      // the results page is the honest destination, and that is depth 0.
      this._depth = 0;
      this._emitNav();
      this._web.load_uri(this._engine.serp(this._query));
    }
  }

  /** Hand whatever is showing to the real browser. */
  OpenCurrent() {
    this._touchIdle();
    const uri = this._depth > 0 ? this._web.get_uri() : this._engine.serp(this._query);
    if (uri) this._launch(uri);
  }

  /** 'contained' follows links in this view; 'browser' hands every link over. */
  SetLinkMode(mode) {
    this._linkMode = mode === 'browser' ? 'browser' : 'contained';
  }

  Configure(width, height, scale) {
    this._touchIdle();
    width = Math.max(64, Math.min(4096, width | 0));
    height = Math.max(64, Math.min(4096, height | 0));
    scale = Math.max(0.5, Math.min(4, Number(scale) || 1));
    const changed = width !== this._width || height !== this._height;
    this._width = width;
    this._height = height;
    if (scale !== this._scale) {
      this._scale = scale;
      this._web.set_zoom_level(scale);
    }
    if (changed) {
      this.window.set_size_request(width, height);
      this.window.resize(width, height);
    }
    this._scheduleFrame();
  }

  Scroll(x, y, dx, dy) {
    this._touchIdle();
    this._scrollEvent(x, y, dx, dy);
  }

  Pointer(kind, x, y, button, state, clicks = 1) {
    this._touchIdle();
    switch (kind) {
      case 'press':
        this._buttonsDown |= 1 << button;
        this._flushMotion();
        this._pointerEvent(Gdk.EventType.BUTTON_PRESS, x, y, button, state);
        // WebKit takes its click count from the event type alone, and GTK sends
        // the plain press *and* the multi-click event. Without this, a page can
        // never see a double-click: no word select, no paragraph select, and no
        // double-click inside the page's own text fields.
        if (DEBUG && clicks > 1) printerr(`[sds-renderer] press clicks=${clicks}`);
        if (clicks === 2) this._pointerEvent(Gdk.EventType.DOUBLE_BUTTON_PRESS, x, y, button, state);
        else if (clicks >= 3) this._pointerEvent(Gdk.EventType.TRIPLE_BUTTON_PRESS, x, y, button, state);
        break;
      case 'release':
        this._buttonsDown &= ~(1 << button);
        this._flushMotion();
        this._pointerEvent(Gdk.EventType.BUTTON_RELEASE, x, y, button, state);
        break;
      case 'move':
        this._motion = {x, y, state};
        // Drags (selection) need every step; plain hovering only the latest.
        if (this._buttonsDown) this._flushMotion();
        else if (!this._motionTimer) {
          this._motionTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MOTION_INTERVAL_MS, () => {
            this._flushMotion();
            return GLib.SOURCE_REMOVE;
          });
        }
        break;
      case 'leave':
        this._motion = null;
        break;
      default:
        break;
    }
  }

  Key(kind, keyval, keycode, state) {
    this._touchIdle();
    const type = kind === 'release' ? Gdk.EventType.KEY_RELEASE : Gdk.EventType.KEY_PRESS;
    this._keyEvent(type, keyval, keycode, state);
  }

  /** Load the current page again: the results page, or the page followed to. */
  Reload() {
    this._touchIdle();
    this._loading = true;
    this._setState('loading', this._depth > 0 ? hostOf(this._web.get_uri() ?? '') : this._engine.label);
    if (this._depth > 0) this._web.reload();
    else if (this._query) this._web.load_uri(this._engine.serp(this._query));
  }

  Refresh() {
    this._touchIdle();
    // Re-emit the current state so a newly created view can pick it up.
    if (this._state) this._setState(this._state, this._stateDetail ?? this._engine.label);
    this._emitNav();
    this._scheduleFrame();
  }

  Quit() {
    this.destroy();
    this._onExit();
  }

  _touchIdle() {
    if (this._idleTimer) GLib.source_remove(this._idleTimer);
    this._idleTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, IDLE_EXIT_S, () => {
      this._idleTimer = 0;
      console.log('[sds-renderer] idle, exiting');
      this.Quit();
      return GLib.SOURCE_REMOVE;
    });
  }

  destroy() {
    if (this._frameTimer) GLib.source_remove(this._frameTimer);
    if (this._settleTimer) GLib.source_remove(this._settleTimer);
    if (this._motionTimer) GLib.source_remove(this._motionTimer);
    if (this._idleTimer) GLib.source_remove(this._idleTimer);
    this._frameTimer = this._settleTimer = this._motionTimer = this._idleTimer = 0;
    this._frames.remove();
    this.window.destroy();
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

Gtk.init(null);
// Fonts are sized in CSS pixels, at the Shell's scale (via WebKit zoom). A HiDPI
// X display advertises 192 dpi and WebKitGTK would scale every font by it again.
Gtk.Settings.get_default().gtk_xft_dpi = 96 * 1024;
const loop = new GLib.MainLoop(null, false);
let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  loop.quit();
};
const renderer = new Renderer(exit);

/**
 * The first caller owns the renderer: only its unique bus name may call methods
 * afterwards, and the renderer exits when that name vanishes (Shell restart).
 */
let owner = null;
let ownerWatch = 0;
const impl = {};
// Taken from the interface itself: a hand-written list next to the XML is a
// list that drifts from it, and the symptom is a method the renderer implements
// answering "no such method" on the bus.
const METHODS = [...INTERFACE_XML.matchAll(/<method name="([^"]+)"/g)].map(m => m[1]);
for (const method of METHODS) {
  impl[`${method}Async`] = (params, invocation) => {
    const sender = invocation.get_sender();
    if (owner === null) {
      owner = sender;
      ownerWatch = Gio.bus_watch_name(Gio.BusType.SESSION, sender, Gio.BusNameWatcherFlags.NONE,
        null, () => { console.log('[sds-renderer] client vanished, exiting'); renderer.Quit(); });
    } else if (sender !== owner) {
      invocation.return_error_literal(Gio.DBusError, Gio.DBusError.ACCESS_DENIED, 'renderer is owned by another client');
      return;
    }
    try {
      renderer[method](...params);
      invocation.return_value(null);
    } catch (e) {
      console.warn(`[sds-renderer] ${method} failed: ${e}`);
      invocation.return_error_literal(Gio.DBusError, Gio.DBusError.FAILED, String(e));
    }
  };
}

const exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, impl);
renderer.emitSignal = (name, variant) => {
  try {
    exported.emit_signal(name, variant);
  } catch (e) {
    if (DEBUG) printerr(`[sds-renderer] signal ${name} failed: ${e}`);
  }
};

const ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
  connection => { exported.export(connection, OBJECT_PATH); },
  () => { if (DEBUG) printerr(`[sds-renderer] serving ${BUS_NAME}`); },
  () => {
    // Another renderer already serves the name; this one is redundant.
    console.warn(`[sds-renderer] ${BUS_NAME} is taken, exiting`);
    exit();
  });

loop.run();
if (ownerWatch) Gio.bus_unwatch_name(ownerWatch);
Gio.bus_unown_name(ownerId);
System.exit(0);
