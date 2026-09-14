/**
 * pageView.ts — the results page, inside the overview.
 *
 * This is the actor the search provider hands to GNOME Shell as its result
 * (`createResultObject`). It shows the engine's rendered results page as a live
 * texture — the renderer process exports every repaint as raw RGBA, this actor
 * uploads it with St.ImageContent — and forwards the pointer, scroll and key
 * events it receives to the renderer, so the page scrolls, hovers, focuses and
 * types like a real view. Links never navigate here: the renderer hands them to
 * the default browser and reports it, and the overview closes.
 *
 * Layout (all St, so it is the system theme, light or dark, with no palette of
 * its own):
 *
 *   ┌ status · engine ─────────────────── [sidebar] [browser] ┐
 *   │ ┌ sidebar ┐ ┌──────────────────────────────────────────┐ │
 *   │ │ 1 link  │ │                                          │ │
 *   │ │ 2 link  │ │            rendered page                 │ │
 *   │ └─────────┘ └──────────────────────────────────────────┘ │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The sidebar is the compact link list from SearXNG: off by default, left,
 * top-anchored, F9 or its button toggles it, position and width come from the
 * extension preferences (the panel-sidebar-* keys).
 */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {openInDefaultBrowser} from './browserLauncher.js';
import {Frame, RendererClient, RendererListener, RendererState} from './rendererClient.js';
import {WebResult} from './webSearch.js';

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

export interface SidebarOutcome { results: WebResult[]; notice: string | null; }

export interface PageViewDeps {
  renderer: RendererClient;
  settings: Gio.Settings;
  /** The compact link list for the sidebar (SearXNG JSON). */
  fetchLinks: (query: string, limit: number, cancellable: Gio.Cancellable) => Promise<SidebarOutcome>;
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
const PAGE_HEIGHT_SHARE = 0.58;
const PAGE_HEIGHT_MIN = 320;
const PAGE_HEIGHT_MAX = 1400;

function pageHeight(): number {
  const monitor = Main.layoutManager.primaryMonitor;
  const height = monitor ? monitor.height : 800;
  return Math.max(PAGE_HEIGHT_MIN, Math.min(PAGE_HEIGHT_MAX, Math.round(height * PAGE_HEIGHT_SHARE)));
}

function scaleFactor(): number {
  return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function iconButton(iconName: string, accessibleName: string): St.Button {
  const button = new St.Button({
    style_class: 'icon-button',
    can_focus: true,
    accessible_name: accessibleName,
    child: new St.Icon({icon_name: iconName, icon_size: 16}),
  });
  return button;
}

function launch(url: string): void {
  if (openInDefaultBrowser(url)) Main.overview.hide();
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
  private _onToggleSidebar: () => void;

  constructor(renderer: RendererClient, onEscape: () => void, onToggleSidebar: () => void) {
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
    this._onToggleSidebar = onToggleSidebar;
    this._content = new St.ImageContent();
    this.set_content(this._content);
    this.content_gravity = Clutter.ContentGravity.RESIZE_FILL;
    this.set_height(pageHeight());

    this.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
      this.grab_key_focus();
      this._pointer('press', event, event.get_button());
      return Clutter.EVENT_STOP;
    });
    this.connect('button-release-event', (_a: Clutter.Actor, event: Clutter.Event) => {
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
    this._renderer.pointer(kind, x, y, button, event.get_state());
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
    // Escape hands focus back to the search entry; a second Escape then closes
    // the search as usual. F9 toggles the sidebar, as the old panel did.
    if (symbol === Clutter.KEY_Escape) {
      if (kind === 'press') this._onEscape();
      return Clutter.EVENT_STOP;
    }
    if (symbol === Clutter.KEY_F9) {
      if (kind === 'press') this._onToggleSidebar();
      return Clutter.EVENT_STOP;
    }
    this._renderer.key(kind, symbol, event.get_key_code(), event.get_state());
    return Clutter.EVENT_STOP;
  }
});

// ---------------------------------------------------------------------------
// The result: header, sidebar, frame, notice
// ---------------------------------------------------------------------------

export const PageView = GObject.registerClass(
class PageView extends St.BoxLayout {
  private _deps: PageViewDeps;
  private _query = '';
  private _state: RendererState = 'loading';
  private _listener: RendererListener;
  private _settingsId = 0;
  private _status: St.Label;
  private _sidebarButton: St.Button;
  private _body: St.BoxLayout;
  private _sidebar: St.BoxLayout;
  private _list: St.BoxLayout;
  private _frame: InstanceType<typeof FrameActor>;
  private _notice: St.BoxLayout;
  private _noticeTitle: St.Label;
  private _noticeBody: St.Label;
  private _noticeButtons: St.BoxLayout;
  private _links: WebResult[] = [];
  private _linksQuery = '';
  private _linksCancellable: Gio.Cancellable | null = null;

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

    // --- header ---
    const header = new St.BoxLayout({style_class: 'sds-page-header', x_expand: true});
    this._status = new St.Label({style_class: 'list-search-result-description', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    header.add_child(this._status);
    this._sidebarButton = iconButton('sidebar-show-symbolic', 'Show sidebar (F9)');
    this._sidebarButton.connect('clicked', () => this._toggleSidebar());
    header.add_child(this._sidebarButton);
    const browserButton = iconButton('web-browser-symbolic', 'Open this search in your browser');
    browserButton.connect('clicked', () => this.activate());
    header.add_child(browserButton);
    this.add_child(header);

    // --- body: sidebar + frame ---
    this._body = new St.BoxLayout({x_expand: true});
    this._sidebar = new St.BoxLayout({style_class: 'sds-sidebar', orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.START});
    const sidebarTitle = new St.Label({style_class: 'list-search-result-description', text: 'Results'});
    this._sidebar.add_child(sidebarTitle);
    this._list = new St.BoxLayout({style_class: 'list-search-results', orientation: Clutter.Orientation.VERTICAL});
    const scroll = new St.ScrollView({hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC, y_expand: true});
    scroll.set_child(this._list);
    this._sidebar.add_child(scroll);
    this._frame = new FrameActor(deps.renderer, () => this._focusEntry(), () => this._toggleSidebar());
    this._body.add_child(this._sidebar);
    this._body.add_child(this._frame);
    this.add_child(this._body);

    // --- notice (blocked engine / load error) ---
    this._notice = new St.BoxLayout({style_class: 'sds-notice', orientation: Clutter.Orientation.VERTICAL, x_expand: true, x_align: Clutter.ActorAlign.CENTER, visible: false});
    this._noticeTitle = new St.Label({style_class: 'list-search-result-title', x_align: Clutter.ActorAlign.CENTER});
    this._noticeBody = new St.Label({style_class: 'list-search-result-description', x_align: Clutter.ActorAlign.CENTER});
    this._noticeBody.clutter_text.line_wrap = true;
    this._noticeButtons = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
    this._notice.add_child(this._noticeTitle);
    this._notice.add_child(this._noticeBody);
    this._notice.add_child(this._noticeButtons);
    this.add_child(this._notice);

    this._listener = {
      onFrame: frame => this._frame.showFrame(frame),
      onState: (state, detail) => this._onState(state, detail),
      onLaunched: () => Main.overview.hide(),
    };
    deps.renderer.addListener(this._listener);
    this._settingsId = deps.settings.connect('changed', (_s: Gio.Settings, key: string) => this._onSettingChanged(key));
    this._applySidebarSettings();
    this.connect('destroy', () => this._onDestroy());
    // A view built while the renderer is already showing a page needs its frame.
    deps.renderer.refresh();
  }

  get query(): string { return this._query; }

  /** Called by the provider whenever the overview's terms change. */
  setQuery(query: string): void {
    if (query === this._query) return;
    this._query = query;
    this.metaInfo.name = query;
    this._updateStatus();
  }

  /**
   * The overview's terms have held still. `reloading` says the renderer was
   * asked for a new page (it is not when the same query comes back); the
   * sidebar's links are loaded either way if it is showing.
   */
  querySettled(query: string, reloading: boolean): void {
    this.setQuery(query);
    if (reloading) {
      this._state = 'loading';
      this._updateStatus();
    }
    if (this._sidebar.visible) this._loadLinks();
  }

  /** Result contract: Enter on the selected result. Opens this search in the browser. */
  activate(): void {
    if (!this._query) return;
    launch(engineFor(this._engineId).browser(this._query));
  }

  /** Result contract: the menu key; there is no context menu. */
  popup_menu(): void {}

  private get _engineId(): string { return engineFor(this._deps.settings.get_string('panel-engine')).id; }

  private _focusEntry(): void {
    const entry = (Main.overview as unknown as {searchEntry?: St.Entry}).searchEntry;
    entry?.grab_key_focus();
  }

  // --- state ---------------------------------------------------------------

  private _onState(state: RendererState, detail: string): void {
    this._state = state;
    this._updateStatus();
    const engine = engineFor(this._engineId);
    if (state === 'blocked') {
      this._showNotice(`${engine.label} is refusing this network`,
        `${engine.label} answered with its "unusual traffic" check instead of results. That is decided by ` +
        'the IP address (VPN exits are often flagged) and will not be worked around here.',
        [['Use DuckDuckGo', () => this._deps.settings.set_string('panel-engine', 'duckduckgo')],
          ['Open in browser', () => this.activate()]]);
    } else if (state === 'error') {
      this._showNotice(`${engine.label} could not be loaded`, detail,
        [['Try again', () => this._deps.renderer.search(this._query, engine.id)],
          ['Open in browser', () => this.activate()]]);
    } else {
      this._notice.visible = false;
      this._frame.visible = true;
    }
  }

  private _updateStatus(): void {
    const engine = engineFor(this._engineId);
    const suffix = {loading: ' · Loading…', ready: '', blocked: ' · blocked', error: ' · failed'}[this._state] ?? '';
    this._status.text = `${engine.label}${suffix}`;
  }

  private _showNotice(title: string, body: string, buttons: Array<[string, () => void]>): void {
    this._noticeTitle.text = title;
    this._noticeBody.text = body;
    this._noticeButtons.remove_all_children();
    for (const [label, fn] of buttons) {
      const button = new St.Button({style_class: 'button', label, can_focus: true});
      button.connect('clicked', fn);
      this._noticeButtons.add_child(button);
    }
    this._frame.visible = false;
    this._notice.visible = true;
  }

  // --- sidebar -------------------------------------------------------------

  private _onSettingChanged(key: string): void {
    switch (key) {
      case 'panel-sidebar-visible':
      case 'panel-sidebar-position':
      case 'panel-sidebar-width':
        this._applySidebarSettings();
        break;
      case 'panel-sidebar-limit':
        if (this._sidebar.visible) this._loadLinks(true);
        break;
      case 'panel-engine':
        this._notice.visible = false;
        this._frame.visible = true;
        this._state = 'loading';
        this._updateStatus();
        if (this._query) this._deps.renderer.search(this._query, this._engineId);
        break;
      default:
        break;
    }
  }

  private _toggleSidebar(): void {
    const settings = this._deps.settings;
    settings.set_boolean('panel-sidebar-visible', !settings.get_boolean('panel-sidebar-visible'));
  }

  private _applySidebarSettings(): void {
    const settings = this._deps.settings;
    const visible = settings.get_boolean('panel-sidebar-visible');
    const right = settings.get_string('panel-sidebar-position') === 'right';
    this._sidebar.set_width(settings.get_int('panel-sidebar-width'));
    this._sidebar.set_height(pageHeight());
    this._body.set_child_at_index(this._sidebar, right ? 1 : 0);
    this._sidebar.visible = visible;
    this._sidebarButton.child = new St.Icon({icon_name: right ? 'sidebar-show-right-symbolic' : 'sidebar-show-symbolic', icon_size: 16});
    this._sidebarButton.accessible_name = visible ? 'Hide sidebar (F9)' : 'Show sidebar (F9)';
    if (visible && this._query) this._loadLinks();
  }

  private _loadLinks(force = false): void {
    if (!this._query) return;
    if (!force && this._linksQuery === this._query) {
      this._populate(this._links, null);
      return;
    }
    this._linksCancellable?.cancel();
    const cancellable = this._linksCancellable = new Gio.Cancellable();
    const query = this._query;
    this._linksQuery = query;
    this._populate([], 'Searching…');
    this._deps.fetchLinks(query, this._deps.settings.get_int('panel-sidebar-limit'), cancellable).then(outcome => {
      if (cancellable.is_cancelled()) return;
      this._links = outcome.results;
      this._populate(outcome.results, outcome.notice);
    }).catch(error => {
      if (cancellable.is_cancelled()) return;
      this._links = [];
      this._populate([], `Couldn't reach SearXNG: ${error}`);
    });
  }

  private _populate(results: WebResult[], notice: string | null): void {
    this._list.remove_all_children();
    if (notice || results.length === 0) {
      const label = new St.Label({style_class: 'list-search-result-description', text: notice ?? 'No results.'});
      label.clutter_text.line_wrap = true;
      this._list.add_child(label);
      return;
    }
    results.forEach((result, index) => {
      const row = new St.Button({style_class: 'list-search-result', can_focus: true, x_expand: true, x_align: Clutter.ActorAlign.FILL});
      const content = new St.BoxLayout({style_class: 'list-search-result-content', x_expand: true});
      const number = new St.Label({style_class: 'list-search-result-description', text: `${index + 1}`, y_align: Clutter.ActorAlign.START});
      const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
      const title = new St.Label({style_class: 'list-search-result-title', text: result.title, x_expand: true, x_align: Clutter.ActorAlign.START});
      title.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
      const url = new St.Label({style_class: 'list-search-result-description', text: result.displayUrl, x_expand: true, x_align: Clutter.ActorAlign.START});
      url.clutter_text.ellipsize = 3;
      column.add_child(title);
      column.add_child(url);
      content.add_child(number);
      content.add_child(column);
      row.set_child(content);
      row.connect('clicked', () => launch(result.url));
      this._list.add_child(row);
    });
  }

  private _onDestroy(): void {
    this._deps.renderer.removeListener(this._listener);
    if (this._settingsId) this._deps.settings.disconnect(this._settingsId);
    this._settingsId = 0;
    this._linksCancellable?.cancel();
    this._linksCancellable = null;
  }
});

export type PageView = InstanceType<typeof PageView>;
