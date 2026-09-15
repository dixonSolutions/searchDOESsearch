/**
 * pageView.ts — the results page, inside the overview.
 *
 * This is the actor the search provider hands to GNOME Shell as its result
 * (`createResultObject`). It shows the engine's rendered results page as a live
 * texture — the renderer process exports every repaint as raw RGBA, this actor
 * uploads it with St.ImageContent — and forwards the pointer, scroll and key
 * events it receives to the renderer, so the page scrolls, hovers, focuses and
 * types like a real view.
 *
 * A clicked link either opens in the user's browser or is followed here; the
 * link-target setting decides. Followed here, the header grows a back arrow
 * carrying how many pages deep the user has gone, and at the results page again
 * it disappears. There is no forward, no address bar, no tabs: this is a way
 * back to the search, not a browser.
 *
 * Layout (all St, so it is the system theme, light or dark, with no palette of
 * its own):
 *
 *   ┌ status ───────────────────────────────────── [← 2] ┐
 *   │ ┌────────────────────────────────────────────────┐ │
 *   │ │                 rendered page                  │ │
 *   │ └────────────────────────────────────────────────┘ │
 *   └────────────────────────────────────────────────────┘
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {openInDefaultBrowser} from './browserLauncher.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import {Frame, LinkMode, Nav, RendererClient, RendererListener, RendererState} from './rendererClient.js';

const enc = encodeURIComponent;

export const ENGINES: Record<string, {label: string; browser: (q: string) => string}> = {
  duckduckgo: {label: 'DuckDuckGo', browser: q => `https://duckduckgo.com/?q=${enc(q)}`},
  google: {label: 'Google', browser: q => `https://www.google.com/search?q=${enc(q)}`},
};
export function engineFor(id: string): {id: string; label: string; browser: (q: string) => string} {
  const engine = ENGINES[id] ? id : 'duckduckgo';
  return {id: engine, ...ENGINES[engine]};
}

/** Result meta the provider registers for this view; the id never changes so the Shell reuses the actor. */
export const PAGE_RESULT_ID = 'sds:page';

export interface PageViewDeps {
  renderer: RendererClient;
  settings: Gio.Settings;
}

/** The Shell's global (ui/environment.js); only the stage is needed here. */
declare const global: {stage: Clutter.Stage & {context: Clutter.Context}};

/** Textures are created on the Shell's own Cogl context. */
function coglContext(): Cogl.Context {
  return global.stage.context.get_backend().get_cogl_context();
}

/** SDS_DEBUG=1 in the Shell's environment logs frame timings and raw scroll events. */
const DEBUG = !!GLib.getenv('SDS_DEBUG');

/** Layout changes arrive in bursts; the renderer is re-sized once they settle. */
const RESIZE_SETTLE_MS = 40;
/** Page height as a share of the monitor: the overview keeps entry, dash and margins around it. */
const PAGE_HEIGHT_SHARE = 0.60;
const PAGE_HEIGHT_MIN = 360;
const PAGE_HEIGHT_MAX = 1200;
/** A load shorter than this shows nothing: a spinner that flashes is noise. */
const SPINNER_DELAY_MS = 250;
/** GTK's own double-click window; a run of clicks inside it is one gesture. */
const DOUBLE_CLICK_MS = 400;
/** How long a transient header message (a refused link) stays. */
const MESSAGE_MS = 2500;
/**
 * A load that says nothing for this long is not coming: a dead renderer, a call
 * that never reached it, a page that hangs. Without this the skeleton stays up
 * for ever and the view looks broken with no way out — which is exactly how a
 * refused D-Bus call hid itself during development.
 */
const LOAD_TIMEOUT_MS = 15000;
/** Dim text, done with actor opacity: a hard-coded grey breaks on a user theme. */
const DIM = 160;

function pageHeight(): number {
  const monitor = Main.layoutManager.primaryMonitor;
  const height = monitor ? monitor.height : 800;
  return Math.max(PAGE_HEIGHT_MIN, Math.min(PAGE_HEIGHT_MAX, Math.round(height * PAGE_HEIGHT_SHARE)));
}

function scaleFactor(): number {
  return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/**
 * `ease` is grafted onto every actor by the Shell's ui/environment.js, which the
 * Clutter typings know nothing about.
 */
interface Easeable { ease(params: object): void }
function ease(actor: Clutter.Actor, params: object): void {
  (actor as unknown as Easeable).ease({mode: Clutter.AnimationMode.EASE_OUT_QUAD, ...params});
}

/**
 * Everything that reaches the header is remote-controlled — a page title, a
 * WebKit error, a URL's host — and the label parses markup, so every part is
 * escaped and the markup around it is ours. Never assign `.text` on a label
 * whose markup has been set: it would be parsed as markup too.
 */
function esc(text: string): string {
  return GLib.markup_escape_text(text, -1);
}

/** The host of a URL, for the header; anything unparseable is simply not shown. */
function hostOf(url: string): string {
  try {
    return GLib.Uri.parse(url, GLib.UriFlags.PARSE_RELAXED).get_host() ?? '';
  } catch {
    return '';
  }
}

function launch(url: string): void {
  if (openInDefaultBrowser(url)) Main.overview.hide();
}

export function linkModeOf(settings: Gio.Settings): LinkMode {
  return settings.get_string('link-mode') === 'browser' ? 'browser' : 'contained';
}

// ---------------------------------------------------------------------------
// The frame: a texture that forwards input
// ---------------------------------------------------------------------------

export const FrameActor = GObject.registerClass(
class FrameActor extends St.Widget {
  private _renderer: RendererClient;
  private _content: St.ImageContent;
  private _serial = -1;
  private _resizeTimer = 0;
  private _onEscape: () => void;
  private _onBack: () => boolean;
  private _lastPress: [number, number, number] = [0, 0, 0];
  private _clicks = 1;

  constructor(renderer: RendererClient, onEscape: () => void, onBack: () => boolean) {
    super({
      style_class: 'sds-frame',
      reactive: true,
      can_focus: true,
      track_hover: true,
      x_expand: true,
      y_expand: false,
      clip_to_allocation: true,
    });
    this._renderer = renderer;
    this._onEscape = onEscape;
    this._onBack = onBack;
    // Without a preferred size St logs "initialized with invalid preferred
    // size: -1x-1" for every view it builds. The real size arrives with the
    // first frame; this is only the value St asks for before that.
    this._content = new St.ImageContent({preferred_width: 1, preferred_height: pageHeight()});
    this.set_content(this._content);
    this.content_gravity = Clutter.ContentGravity.RESIZE_FILL;
    this.set_height(pageHeight());

    this.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
      this.grab_key_focus();
      // Mouse button 8 is "back" on every mouse that has it, and it is what the
      // hand already reaches for on a followed page.
      if (event.get_button() === 8) {
        this._onBack();
        return Clutter.EVENT_STOP;
      }
      this._pointer('press', event, event.get_button());
      return Clutter.EVENT_STOP;
    });
    this.connect('button-release-event', (_a: Clutter.Actor, event: Clutter.Event) => {
      if (event.get_button() === 8) return Clutter.EVENT_STOP;
      this._pointer('release', event, event.get_button());
      return Clutter.EVENT_STOP;
    });
    this.connect('motion-event', (_a: Clutter.Actor, event: Clutter.Event) => {
      this._pointer('move', event, 0);
      return Clutter.EVENT_STOP;
    });
    this.connect('leave-event', () => {
      this._renderer.pointer('leave', 0, 0, 0, 0);
      return Clutter.EVENT_PROPAGATE;
    });
    this.connect('scroll-event', (_a: Clutter.Actor, event: Clutter.Event) => this._scroll(event));
    this.connect('key-press-event', (_a: Clutter.Actor, event: Clutter.Event) => this._key('press', event));
    this.connect('key-release-event', (_a: Clutter.Actor, event: Clutter.Event) => this._key('release', event));
    this.connect('destroy', () => {
      if (this._resizeTimer) GLib.source_remove(this._resizeTimer);
      this._resizeTimer = 0;
    });
  }

  /** Upload a frame; older frames arriving late are ignored. */
  showFrame(frame: Frame): void {
    if (frame.serial <= this._serial && this._serial - frame.serial < 1 << 30) return;
    this._serial = frame.serial;
    try {
      const t0 = GLib.get_monotonic_time();
      const mapped = GLib.MappedFile.new(frame.path, false);
      this._content.set_bytes(coglContext(), mapped.get_bytes(), Cogl.PixelFormat.RGBA_8888, frame.width, frame.height, frame.stride);
      if (DEBUG) {
        console.log(`[SearchDoesSearch] frame #${frame.serial} ${frame.width}x${frame.height} ` +
          `map+upload ${((GLib.get_monotonic_time() - t0) / 1000).toFixed(1)}ms`);
      }
    } catch (error) {
      // The renderer replaced the file between signal and map; the next frame follows.
      console.debug(`[SearchDoesSearch] frame ${frame.serial} skipped: ${error}`);
    }
  }

  override vfunc_allocate(box: Clutter.ActorBox): void {
    super.vfunc_allocate(box);
    const width = Math.round(box.get_width());
    const height = Math.round(box.get_height());
    if (width < 16 || height < 16) return;
    if (this._resizeTimer) return;
    this._resizeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESIZE_SETTLE_MS, () => {
      this._resizeTimer = 0;
      const scale = scaleFactor();
      const w = Math.round(this.get_width());
      const h = Math.round(this.get_height());
      if (w >= 16 && h >= 16) this._renderer.configure(Math.round(w * scale), Math.round(h * scale), scale);
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Stage coordinates → page device pixels. */
  private _pagePoint(event: Clutter.Event): [number, number] {
    const [sx, sy] = event.get_coords();
    const [ok, x, y] = this.transform_stage_point(sx, sy);
    const scale = scaleFactor();
    return ok ? [x * scale, y * scale] : [sx * scale, sy * scale];
  }

  private _pointer(kind: 'press' | 'release' | 'move', event: Clutter.Event, button: number): void {
    const [x, y] = this._pagePoint(event);
    const clicks = kind === 'press' ? this._countClick(event, x, y) : 1;
    this._renderer.pointer(kind, x, y, button, event.get_state(), clicks);
  }

  /**
   * Clutter 17 dropped `get_click_count()`, so the run of clicks is counted
   * here — the renderer needs it to synthesise the GDK double/triple press
   * events WebKit takes its click count from, which is what selects a word or a
   * line. Same thresholds GTK uses: 400ms, and a few pixels of slop.
   */
  private _countClick(event: Clutter.Event, x: number, y: number): number {
    const time = event.get_time();
    const near = Math.abs(x - this._lastPress[0]) < 6 && Math.abs(y - this._lastPress[1]) < 6;
    const soon = time > 0 && this._lastPress[2] > 0 && time - this._lastPress[2] < DOUBLE_CLICK_MS;
    this._clicks = near && soon ? Math.min(this._clicks + 1, 3) : 1;
    if (DEBUG) {
      console.log(`[SearchDoesSearch] press clicks=${this._clicks} time=${time} ` +
        `gap=${time - this._lastPress[2]} near=${near}`);
    }
    this._lastPress = [x, y, time];
    return this._clicks;
  }

  /**
   * Mutter delivers every scroll twice: a SMOOTH event carrying the delta (1.0
   * per wheel notch, 1.0 per 10px of touchpad travel — GDK's own convention, so
   * the renderer passes it through unchanged) and then a discrete UP/DOWN twin.
   * Only the smooth one is forwarded; forwarding both scrolls twice per notch.
   */
  private _scroll(event: Clutter.Event): boolean {
    const direction = event.get_scroll_direction();
    if (direction !== Clutter.ScrollDirection.SMOOTH) return Clutter.EVENT_STOP;
    const [dx, dy] = event.get_scroll_delta();
    if (DEBUG) {
      console.log(`[SearchDoesSearch] scroll source=${event.get_scroll_source()} ` +
        `finish=${event.get_scroll_finish_flags()} dx=${dx.toFixed(3)} dy=${dy.toFixed(3)}`);
    }
    if (dx === 0 && dy === 0) return Clutter.EVENT_STOP;
    const [x, y] = this._pagePoint(event);
    this._renderer.scroll(x, y, dx, dy);
    return Clutter.EVENT_STOP;
  }

  private _key(kind: 'press' | 'release', event: Clutter.Event): boolean {
    const symbol = event.get_key_symbol();
    const state = event.get_state();
    // Escape hands focus back to the search entry; a second Escape then closes
    // the search as usual.
    if (symbol === Clutter.KEY_Escape) {
      if (kind === 'press') this._onEscape();
      return Clutter.EVENT_STOP;
    }
    // Alt+Left is back everywhere else; so is Backspace outside a text field,
    // but the page owns Backspace and this view has no way to know whether the
    // caret is in a search box on the page, so only Alt+Left is taken.
    if (symbol === Clutter.KEY_Left && (state & Clutter.ModifierType.MOD1_MASK)) {
      if (kind === 'press' && this._onBack()) return Clutter.EVENT_STOP;
      return Clutter.EVENT_STOP;
    }
    this._renderer.key(kind, symbol, event.get_key_code(), state);
    return Clutter.EVENT_STOP;
  }
});

// ---------------------------------------------------------------------------
// The skeleton: what the page area shows while the next one loads
// ---------------------------------------------------------------------------

/**
 * Result-shaped placeholders, in the same column the real results land in, so
 * the page does not jump when they arrive. It exists because the alternative —
 * leaving the previous query's page on screen — showed one search's results
 * under another search's terms, which is worse than showing nothing.
 */
export const Skeleton = GObject.registerClass(
class Skeleton extends St.BoxLayout {
  private _pulse: St.BoxLayout;

  constructor() {
    super({style_class: 'sds-skeleton', x_expand: true, y_expand: true, visible: false});
    // One animated actor, not twenty: the pulse is on the column as a whole.
    this._pulse = new St.BoxLayout({
      style_class: 'sds-skeleton-column',
      orientation: Clutter.Orientation.VERTICAL,
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });
    for (let i = 0; i < 5; i++) this._pulse.add_child(this._row());
    this.add_child(this._pulse);
  }

  /** Title, url, and two lines of snippet — the shape of one result. */
  private _row(): St.BoxLayout {
    const row = new St.BoxLayout({style_class: 'sds-skeleton-row', orientation: Clutter.Orientation.VERTICAL});
    const bar = (cls: string): St.Widget => new St.Widget({style_class: `sds-skeleton-bar ${cls}`});
    row.add_child(bar('sds-skeleton-title'));
    row.add_child(bar('sds-skeleton-url'));
    row.add_child(bar('sds-skeleton-line'));
    row.add_child(bar('sds-skeleton-line-short'));
    return row;
  }

  start(): void {
    if (this.visible) return;
    this.show();
    this._pulse.remove_all_transitions();
    this._pulse.opacity = 90;
    ease(this._pulse, {opacity: 200, duration: 700, autoReverse: true, repeatCount: -1});
  }

  stop(): void {
    if (!this.visible) return;
    this._pulse.remove_all_transitions();
    this.hide();
  }
});

// ---------------------------------------------------------------------------
// The back arrow, with how deep the user has gone
// ---------------------------------------------------------------------------

/**
 * The way back to the results: an accent-filled pill carrying how many pages
 * the user has followed. It exists only at depth ≥ 1 — there is no disabled
 * state, because a control that cannot do anything is a control to explain.
 * The number is what says "back towards your search" rather than "browser back".
 */
export const BackButton = GObject.registerClass(
class BackButton extends St.Button {
  private _badge: St.Label;
  private _depth = 0;
  /** The hide is deferred to the end of an animation; `visible` lags behind it. */
  private _shown = false;

  constructor(onClick: () => void) {
    super({
      style_class: 'sds-back',
      can_focus: true,
      reactive: true,
      track_hover: true,
      visible: false,
      opacity: 0,
      y_align: Clutter.ActorAlign.CENTER,
    });
    const box = new St.BoxLayout({style_class: 'sds-back-box', y_align: Clutter.ActorAlign.CENTER});
    box.add_child(new St.Icon({icon_name: 'go-previous-symbolic', icon_size: 16}));
    this._badge = new St.Label({style_class: 'sds-back-badge', text: '1', y_align: Clutter.ActorAlign.CENTER});
    box.add_child(this._badge);
    this.set_child(box);
    this.set_pivot_point(0.5, 0.5);
    this.connect('clicked', () => onClick());
  }

  /** `depth` is how many pages the user has followed; 0 takes the pill away. */
  setDepth(depth: number): void {
    if (depth === this._depth) return;
    const was = this._depth;
    this._depth = depth;
    this.accessible_name = depth === 1
      ? 'Back to results' : `Back, ${depth} pages from the results`;
    if (depth > 0) {
      this._badge.text = `${depth}`;
      if (was > 0) this._pulse();
    }
    if ((depth > 0) === this._shown) return;
    this._shown = depth > 0;
    this.remove_all_transitions();
    if (depth > 0) {
      this.set_scale(0.8, 0.8);
      this.opacity = 0;
      this.show();
      ease(this, {opacity: 255, scale_x: 1, scale_y: 1, duration: 150});
    } else {
      ease(this, {opacity: 0, scale_x: 0.8, scale_y: 0.8, duration: 100, onComplete: () => this.hide()});
    }
  }

  /** The count changed under a pill that is already there: say so without moving it. */
  private _pulse(): void {
    this._badge.set_pivot_point(0.5, 0.5);
    this._badge.remove_all_transitions();
    ease(this._badge, {scale_x: 1.25, scale_y: 1.25, duration: 80, autoReverse: true, repeatCount: 1});
  }
});

// ---------------------------------------------------------------------------
// The result: header, frame, notice
// ---------------------------------------------------------------------------

export const PageView = GObject.registerClass(
class PageView extends St.BoxLayout {
  private _deps: PageViewDeps;
  private _query = '';
  private _state: RendererState = 'loading';
  private _nav: Nav = {depth: 0, title: '', uri: ''};
  private _listener: RendererListener;
  private _settingsId = 0;
  private _title: St.Label;
  private _hint: St.Label;
  private _focusHint: St.Label;
  private _spinner: Spinner;
  private _spinnerTimer = 0;
  private _loadTimer = 0;
  private _offlineBar!: St.BoxLayout;
  private _messageTimer = 0;
  private _message = '';
  private _open: St.Button;
  private _refresh: St.Button;
  private _openShown = false;
  private _skeleton: InstanceType<typeof Skeleton>;
  /** The query the page on screen belongs to; '' while nothing valid is shown. */
  private _pageQuery = '';
  private _back: InstanceType<typeof BackButton>;
  private _frame: InstanceType<typeof FrameActor>;
  private _notice: St.BoxLayout;
  private _noticeTitle: St.Label;
  private _noticeBody: St.Label;
  private _noticeButtons: St.BoxLayout;

  /** Search-provider result contract (see search.js): the Shell reads these. */
  metaInfo: {id: string; name: string; description: string};

  constructor(deps: PageViewDeps) {
    super({
      style_class: 'sds-page',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      reactive: true,
    });
    this._deps = deps;
    this.metaInfo = {id: PAGE_RESULT_ID, name: '', description: ''};

    // --- header: [ title ......... ] [ hint ] [ spinner ] [ open ] [ ← n ] ---
    // It never collapses: with the provider column gone this line is the
    // section's identity, and a header that came and went would shift the page
    // up and down on every link.
    const header = new St.BoxLayout({style_class: 'sds-header', x_expand: true});
    this._title = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'sds-title'});
    this._title.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
    header.add_child(this._title);
    // What Enter does, shown only while the Shell has this result selected.
    this._hint = new St.Label({style_class: 'sds-hint', text: '↵ Opens in browser', opacity: 140,
      y_align: Clutter.ActorAlign.CENTER, visible: false});
    header.add_child(this._hint);
    // Once the page has the keyboard, what you type goes into the page, not the
    // search entry. Nothing else on screen says so, and a user retyping their
    // query types it into the site instead.
    this._focusHint = new St.Label({style_class: 'sds-hint', text: 'Esc to search', opacity: 140,
      y_align: Clutter.ActorAlign.CENTER, visible: false});
    header.add_child(this._focusHint);
    this._spinner = new Spinner(16, {animate: true, hideOnStop: true});
    header.add_child(this._spinner as unknown as Clutter.Actor);
    this._open = new St.Button({
      style_class: 'icon-button sds-open',
      can_focus: true,
      visible: false,
      accessible_name: 'Open this page in your browser',
      child: new St.Icon({icon_name: 'web-browser-symbolic', icon_size: 16}),
    });
    this._open.connect('clicked', () => this._openCurrentInBrowser());
    header.add_child(this._open);
    this._refresh = new St.Button({
      style_class: 'icon-button sds-refresh',
      can_focus: true,
      accessible_name: 'Load this page again',
      child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16}),
    });
    this._refresh.connect('clicked', () => this._reload());
    header.add_child(this._refresh);
    this._back = new BackButton(() => this._goBack());
    header.add_child(this._back);
    this.add_child(header);
    // The Shell marks the selected result with a pseudo-class; that is the only
    // moment the Enter hint is true.
    this.connect('style-changed', () => {
      this._hint.visible = !this._focusHint.visible && this.has_style_pseudo_class('selected');
    });

    // --- the page ---
    this._frame = new FrameActor(deps.renderer, () => this._focusEntry(), () => this._goBack());
    this._frame.connect('key-focus-in', () => {
      this._focusHint.visible = true;
      this._hint.visible = false;
    });
    this._frame.connect('key-focus-out', () => {
      this._focusHint.visible = false;
      this._hint.visible = this.has_style_pseudo_class('selected');
    });
    this.add_child(this._frame);
    this._skeleton = new Skeleton();
    this._skeleton.set_height(pageHeight());
    this.add_child(this._skeleton);

    // --- notice (blocked engine / load error) ---
    this._notice = new St.BoxLayout({style_class: 'sds-notice', orientation: Clutter.Orientation.VERTICAL, x_expand: true, x_align: Clutter.ActorAlign.CENTER, visible: false});
    this._noticeTitle = new St.Label({style_class: 'sds-notice-title', x_align: Clutter.ActorAlign.CENTER});
    this._noticeBody = new St.Label({style_class: 'sds-notice-body', x_align: Clutter.ActorAlign.CENTER, x_expand: true});
    this._noticeBody.clutter_text.line_wrap = true;
    // St's height negotiation for a wrapped label inside a max-width box ends up
    // ellipsizing it at two lines; the text is the explanation, so it wraps
    // however far it needs to.
    this._noticeBody.clutter_text.ellipsize = 0; // Pango.EllipsizeMode.NONE
    this._noticeBody.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
    this._noticeButtons = new St.BoxLayout({style_class: 'sds-notice-buttons', x_align: Clutter.ActorAlign.CENTER});
    this._notice.add_child(this._noticeTitle);
    this._notice.add_child(this._noticeBody);
    this._notice.add_child(this._noticeButtons);
    this.add_child(this._notice);

    // --- offline ---
    // Not a notice: there is nothing to decide and nothing to retry by hand, so
    // it is one bar that states the fact and gets out of the way. It disappears
    // on its own when the network comes back, because the client re-runs the
    // search on network-changed.
    this._offlineBar = new St.BoxLayout({style_class: 'sds-offline-bar', x_expand: true, visible: false});
    this._offlineBar.add_child(new St.Label({
      style_class: 'sds-offline-text',
      text: 'Unable To Query (internet broken or not connected)',
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    }));
    this.add_child(this._offlineBar);

    this._listener = {
      onFrame: frame => this._frame.showFrame(frame),
      onState: (state, detail, query) => this._onState(state, detail, query),
      onLaunched: () => Main.overview.hide(),
      onNav: nav => this._onNav(nav),
      onRefused: scheme => this._flash(`${scheme}: links are only followed for web pages`),
    };
    deps.renderer.addListener(this._listener);
    this._settingsId = deps.settings.connect('changed', (_s: Gio.Settings, key: string) => this._onSettingChanged(key));
    deps.renderer.setLinkMode(linkModeOf(deps.settings));
    this.connect('destroy', () => this._onDestroy());
    // A view built while the renderer is already showing a page needs its frame.
    deps.renderer.refresh();
  }

  get query(): string { return this._query; }

  /**
   * Called by the provider whenever the overview's terms change — on every
   * keystroke, well before anything is loaded for them. The page on screen
   * belongs to whichever query produced it: if that is still this one, it stays
   * (deleting a character and retyping it shows the same results at once); if
   * it is not, it goes, and the skeleton stands in until the new one arrives.
   */
  setQuery(query: string): void {
    if (query === this._query) return;
    this._query = query;
    this.metaInfo.name = query;
    if (this._nav.depth === 0 && !this._notice.visible && !this._offlineBar.visible) {
      this._showPage(query !== '' && query === this._pageQuery);
    }
    this._updateStatus();
  }

  /**
   * The overview's terms have held still. `reloading` says the renderer was
   * asked for a new page (it is not when the same query comes back), which also
   * puts the user back at the results page.
   */
  querySettled(query: string, reloading: boolean): void {
    this.setQuery(query);
    if (reloading) {
      this._state = 'loading';
      // What is on screen belongs to the previous search. Take it away now
      // rather than leaving one query's results sitting under another's terms.
      this._pageQuery = '';
      this._showPage(false);
      this._updateStatus();
    }
  }

  /** Show either the page or the skeleton — never a page from another query. */
  private _showPage(ready: boolean): void {
    // The offline bar is the whole answer; a skeleton beside it would claim a
    // page is on its way when nothing has been asked for.
    if (this._offlineBar.visible && !ready) {
      this._frame.visible = false;
      this._skeleton.stop();
      return;
    }
    if (ready) {
      this._skeleton.stop();
      this._frame.visible = true;
    } else {
      this._frame.visible = false;
      this._skeleton.start();
    }
  }

  private _reload(): void {
    this._notice.visible = false;
    if (this._nav.depth === 0) this._pageQuery = '';
    this._state = 'loading';
    this._showPage(this._nav.depth > 0);
    this._updateStatus();
    this._deps.renderer.reload();
  }

  /**
   * Result contract: Enter on the selected result. Hands what is showing to the
   * real browser — the results page, or the page the user followed to.
   */
  activate(): void {
    if (this._nav.depth > 0) {
      this._openCurrentInBrowser();
      return;
    }
    if (!this._query) return;
    launch(engineFor(this._engineId).browser(this._query));
  }

  /** Result contract: the menu key; there is no context menu. */
  popup_menu(): void {}

  private get _engineId(): string { return engineFor(this._deps.settings.get_string('engine')).id; }

  private _focusEntry(): void {
    const entry = (Main.overview as unknown as {searchEntry?: St.Entry}).searchEntry;
    entry?.grab_key_focus();
  }

  private _goBack(): boolean {
    if (this._nav.depth <= 0) return false;
    this._deps.renderer.back();
    return true;
  }

  // --- state ---------------------------------------------------------------

  private _onNav(nav: Nav): void {
    const wasDeep = this._openShown;
    this._nav = nav;
    this._back.setDepth(nav.depth);
    if ((nav.depth > 0) !== wasDeep) this._showOpenButton(nav.depth > 0);
    this._updateStatus();
  }

  /** The escape hatch to the real browser, beside the pill, 30ms behind it. */
  private _showOpenButton(show: boolean): void {
    this._openShown = show;
    this._open.remove_all_transitions();
    this._open.set_pivot_point(0.5, 0.5);
    if (show) {
      this._open.opacity = 0;
      this._open.set_scale(0.8, 0.8);
      this._open.show();
      ease(this._open, {opacity: 255, scale_x: 1, scale_y: 1, duration: 150, delay: 30});
    } else {
      ease(this._open, {opacity: 0, scale_x: 0.8, scale_y: 0.8, duration: 100,
        onComplete: () => this._open.hide()});
    }
  }

  private _openCurrentInBrowser(): void {
    this._deps.renderer.openCurrent();
    Main.overview.hide();
  }

  /** True while the user is on a page they followed, not on the results page. */
  get navigated(): boolean { return this._nav.depth > 0; }

  private _onState(state: RendererState, detail: string, query: string): void {
    // A load that finished for terms the user has already moved past says
    // nothing about what they are waiting for now.
    if (query && this._query && query !== this._query) return;
    this._state = state;
    this._updateStatus();
    const engine = engineFor(this._engineId);
    if (state === 'offline') {
      this._showOffline();
      return;
    }
    this._offlineBar.visible = false;
    if (state === 'blocked') {
      this._showNotice(`${engine.label} is refusing this network`,
        `${engine.label} answered with its "unusual traffic" check instead of results. That is decided by ` +
        'the IP address (VPN exits are often flagged) and will not be worked around here.',
        [['Use DuckDuckGo', () => this._deps.settings.set_string('engine', 'duckduckgo')],
          ['Open in browser', () => this.activate()]]);
    } else if (state === 'error' && this._nav.depth > 0) {
      // A followed page failed, not the engine: offer the way back, not a
      // reload of a results page the user is not looking at.
      const host = hostOf(this._nav.uri) || 'that page';
      this._showNotice(`Couldn't load ${host}`, detail,
        [['Back to results', () => this._goBack()],
          ['Open in browser', () => this._openCurrentInBrowser()]]);
    } else if (state === 'error') {
      this._showNotice(`${engine.label} could not be loaded`, detail,
        [['Try again', () => this._deps.renderer.search(this._query, engine.id)],
          ['Open in browser', () => this.activate()]]);
    } else {
      this._notice.visible = false;
      // Ready means this query's page is painted; loading keeps the skeleton up.
      if (state === 'ready') this._pageQuery = this._query;
      this._showPage(state === 'ready' || this._nav.depth > 0);
    }
  }

  /**
   * On the results page the header names the engine; on a followed page it
   * names the page, because that is what the user needs to recognise before
   * deciding to go back. There is no "Loading…" text: the words changed on
   * every keystroke, and a spinner that only shows up for slow loads says the
   * same thing without the flicker.
   */
  private _updateStatus(): void {
    // The spinner tracks the load, not the text: a transient message must not
    // leave it spinning after the page has arrived.
    this._updateSpinner();
    if (this._message) {
      this._title.clutter_text.set_markup(esc(this._message));
      this._title.opacity = 255;
      return;
    }
    if (this._nav.depth > 0) {
      const host = this._nav.uri ? hostOf(this._nav.uri) : '';
      const name = this._nav.title || host || 'Page';
      // The page's name at full strength, the host behind it: enough to
      // recognise where you are without competing with the name.
      this._title.clutter_text.set_markup(host && host !== name
        ? `${esc(name)} <span alpha="60%">· ${esc(host)}</span>`
        : esc(name));
      this._title.opacity = 255;
    } else {
      const engine = engineFor(this._engineId);
      const suffix = {loading: '', ready: '', blocked: ' · blocked', error: ' · failed', offline: ' · offline'}[this._state] ?? '';
      this._title.clutter_text.set_markup(esc(`${engine.label}${suffix}`));
      this._title.opacity = DIM;
    }
  }

  /** Shown only once a load has taken long enough to be worth reporting. */
  private _updateSpinner(): void {
    const loading = this._state === 'loading';
    this._armLoadTimeout(loading);
    if (!loading) {
      if (this._spinnerTimer) GLib.source_remove(this._spinnerTimer);
      this._spinnerTimer = 0;
      this._spinner.stop();
      return;
    }
    if (this._spinnerTimer) return;
    this._spinnerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPINNER_DELAY_MS, () => {
      this._spinnerTimer = 0;
      if (this._state === 'loading') this._spinner.play();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** Give up on a load that has gone quiet, rather than leaving a skeleton up. */
  private _armLoadTimeout(loading: boolean): void {
    if (!loading) {
      if (this._loadTimer) GLib.source_remove(this._loadTimer);
      this._loadTimer = 0;
      return;
    }
    if (this._loadTimer) return;
    this._loadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOAD_TIMEOUT_MS, () => {
      this._loadTimer = 0;
      if (this._state !== 'loading') return GLib.SOURCE_REMOVE;
      this._state = 'error';
      this._showNotice('This is taking too long',
        'The page renderer has not answered. It may have stopped; trying again starts it.',
        [['Try again', () => this._reload()],
          ['Open in browser', () => this.activate()]]);
      return GLib.SOURCE_REMOVE;
    });
  }

  /** A line in the header that replaces the title for a moment, then gives it back. */
  private _flash(message: string): void {
    this._message = message;
    this._updateStatus();
    if (this._messageTimer) GLib.source_remove(this._messageTimer);
    this._messageTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MESSAGE_MS, () => {
      this._messageTimer = 0;
      this._message = '';
      this._updateStatus();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** No page, no skeleton, no buttons: one row saying why there is nothing. */
  private _showOffline(): void {
    this._notice.visible = false;
    this._frame.visible = false;
    this._skeleton.stop();
    this._offlineBar.visible = true;
  }

  private _showNotice(title: string, body: string, buttons: Array<[string, () => void]>): void {
    this._offlineBar.visible = false;
    this._noticeTitle.text = title;
    this._noticeBody.text = body;
    this._noticeButtons.remove_all_children();
    for (const [label, fn] of buttons) {
      const button = new St.Button({style_class: 'button', label, can_focus: true});
      button.connect('clicked', fn);
      this._noticeButtons.add_child(button);
    }
    this._frame.visible = false;
    this._skeleton.stop();
    this._notice.visible = true;
  }

  // --- settings ------------------------------------------------------------

  private _onSettingChanged(key: string): void {
    switch (key) {
      case 'link-mode':
        this._deps.renderer.setLinkMode(linkModeOf(this._deps.settings));
        break;
      case 'engine':
        this._notice.visible = false;
        this._pageQuery = '';
        this._state = 'loading';
        this._showPage(false);
        this._updateStatus();
        if (this._query) this._deps.renderer.search(this._query, this._engineId);
        break;
      default:
        break;
    }
  }

  private _onDestroy(): void {
    if (this._spinnerTimer) GLib.source_remove(this._spinnerTimer);
    if (this._loadTimer) GLib.source_remove(this._loadTimer);
    if (this._messageTimer) GLib.source_remove(this._messageTimer);
    this._spinnerTimer = this._loadTimer = this._messageTimer = 0;
    this._deps.renderer.removeListener(this._listener);
    if (this._settingsId) this._deps.settings.disconnect(this._settingsId);
    this._settingsId = 0;
  }
});

export type PageView = InstanceType<typeof PageView>;
