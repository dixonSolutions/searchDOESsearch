/**
 * searchWindow.ts — the search box a shortcut opens over whatever you are doing.
 *
 * The overview is one way in; this is the other. A keyboard shortcut (Super+
 * Shift+S unless changed) opens a card with a search entry, and the same
 * results page the overview shows grows under it as you type. Escape, a click
 * outside the card, or the shortcut again closes it. Enter hands the search to
 * the browser, like Enter on the overview's section.
 *
 * Two styles (`search-window-style`). 'full' frosts the whole monitor and
 * centres a large card on it. 'floating' leaves the desktop as it is and shows a
 * smaller card that is dragged by its edge (or the handle on top) and resized
 * from its bottom-right corner; where it was left and how big it was are saved
 * and restored, clamped to whichever monitor it lands on.
 *
 * Both are modal: Shell chrome only gets the keyboard while it holds a grab, so
 * a click outside the floating card closes it rather than reaching the window
 * underneath.
 *
 * It is the same machinery as the overview, not a second copy: a SearchProvider
 * of its own (never registered with the Shell — it is driven from the entry
 * here) decides when to load, and the PageView it builds is the overview's page
 * view with this window as its host. Both share the one renderer process, which
 * is why the provider asks the renderer what it is showing rather than
 * remembering what it last asked for.
 *
 *   ┌──────────────────────────────────────────┐
 *   │ (🔍 what is a flower                   ⌫) │
 *   │ ┌──────────────────────────────────────┐ │
 *   │ │            page view                 │ │
 *   │ └──────────────────────────────────────┘ │
 *   └──────────────────────────────────────────┘
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PageView, ViewHost} from './pageView.js';
import {RendererClient} from './rendererClient.js';
import {SearchProvider} from './searchProvider.js';

/** 'full': the card's share of the monitor, and the bounds that keep it sensible on a tiny or a huge one. */
const WIDTH_SHARE = 0.62;
const WIDTH_MIN = 560;
const WIDTH_MAX = 1100;
const HEIGHT_SHARE = 0.62;
const HEIGHT_MIN = 320;
const HEIGHT_MAX = 1000;
/** Where the card's top edge sits, as a share of the monitor's height. */
const TOP_SHARE = 0.12;
/** 'floating': the size it starts at, and how small resizing may take it. */
const FLOAT_WIDTH_SHARE = 0.42;
const FLOAT_HEIGHT_SHARE = 0.5;
const FLOAT_WIDTH_MIN = 420;
const FLOAT_PAGE_MIN = 220;
/** Kept between the card and a monitor's edge when clamping it back on screen. */
const EDGE_MARGIN = 16;
/** Entry, header and padding around the page; used before the card has been measured. */
const CHROME_ESTIMATE = 120;
const OPEN_MS = 140;
const CLOSE_MS = 100;
/** Frosting behind the card. The Shell's own blur, done on the GPU. */
const BLUR_RADIUS = 36;
const BLUR_BRIGHTNESS = 0.72;

type Style = 'full' | 'floating';
type SettingsVariant = Parameters<Gio.Settings['set_value']>[1];
interface Rect { x: number; y: number; width: number; height: number; }
/** A drag in progress: what is being changed, and where it started. */
interface PointerOp {
  kind: 'move' | 'resize';
  grab: Clutter.Grab;
  px: number; py: number;
  x: number; y: number;
  width: number; pageHeight: number;
}

/** The Shell's global (ui/environment.js); only what this file uses. */
declare const global: {
  stage: Clutter.Stage;
  display: Meta.Display;
};

interface Easeable { ease(params: object): void }
function ease(actor: Clutter.Actor, params: object): void {
  (actor as unknown as Easeable).ease({mode: Clutter.AnimationMode.EASE_OUT_QUAD, ...params});
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type CursorName = 'SE_RESIZE' | 'GRABBING' | 'DEFAULT' | 'INHERIT';

/**
 * Point the cursor. Shell 50 (Clutter 18) sets it per actor and shows it while
 * the pointer is over that actor or the actor holds a grab; Shell 48 and 49
 * have one global cursor, set on the display. `perActorOnly` asks only whether
 * the per-actor kind exists, without touching the global one; the answer says
 * which kind this Shell has.
 */
function setCursor(actor: Clutter.Actor, name: CursorName, perActorOnly = false): boolean {
  const types = (Clutter as unknown as {CursorType?: Record<string, number>}).CursorType;
  const target = actor as unknown as {set_cursor_type?: (type: number) => void};
  if (types && typeof target.set_cursor_type === 'function') {
    target.set_cursor_type(types[name] ?? types.INHERIT);
    return true;
  }
  if (perActorOnly) return false;
  // Neither exists in the Clutter 18 typings, so both are reached structurally.
  const cursors = (Meta as unknown as {Cursor?: Record<string, number>}).Cursor;
  const display = global.display as unknown as {set_cursor?: (cursor: number) => void};
  if (cursors && typeof display.set_cursor === 'function') {
    try {
      display.set_cursor(cursors[name === 'INHERIT' ? 'DEFAULT' : name] ?? cursors.DEFAULT);
    } catch { /* a Shell without this cursor keeps the one it has */ }
  }
  return false;
}

/**
 * Three diagonal strokes in the bottom-right corner, the resize grip every
 * desktop has drawn for thirty years. Theme foreground, so hover can recolour it.
 */
function drawGrip(area: St.DrawingArea): void {
  const cr = area.get_context();
  const [width, height] = area.get_surface_size();
  const color = area.get_theme_node().get_foreground_color();
  cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
  cr.setLineWidth(1.5);
  cr.setLineCap(1); // Cairo.LineCap.ROUND
  for (const inset of [2, 6, 10]) {
    cr.moveTo(width - 2, inset + (height - width));
    cr.lineTo(inset, height - 2);
  }
  cr.stroke();
  cr.$dispose();
}

export interface SearchWindowDeps {
  renderer: RendererClient;
  settings: Gio.Settings;
}

export class SearchWindow {
  private _deps: SearchWindowDeps;
  private _provider: SearchProvider;
  private _root: St.Widget;
  private _backdrop: St.Widget;
  private _blurEffect: Clutter.Effect;
  private _card: St.Widget;
  private _box: St.BoxLayout;
  private _handle: St.Widget;
  private _grip: St.DrawingArea;
  private _entry: St.Entry;
  private _clearIcon: St.Icon;
  private _view: PageView | null = null;
  private _grab: Clutter.Grab | null = null;
  private _op: PointerOp | null = null;
  private _open = false;
  private _style: Style = 'full';
  private _width = 0;
  private _pageHeight = 0;
  private _settingsIds: number[] = [];
  private _cancellable: Gio.Cancellable | null = null;

  constructor(deps: SearchWindowDeps) {
    this._deps = deps;
    const host: ViewHost = {
      dismiss: () => this.close(),
      escape: () => this.close(),
      escapeHint: 'Esc to close',
    };
    this._provider = new SearchProvider({
      engine: deps.settings.get_string('engine'),
      renderer: deps.renderer,
      createView: () => {
        const view = new PageView({
          renderer: deps.renderer, settings: deps.settings, host,
          height: this._pageHeight || this._fullPageHeight(this._monitor()),
        });
        view.connect('destroy', () => {
          if (this._view === view) this._view = null;
        });
        return view;
      },
    });
    this._settingsIds.push(
      deps.settings.connect('changed::engine', () =>
        this._provider.updateOptions({engine: deps.settings.get_string('engine')})),
      deps.settings.connect('changed::search-window-style', () => {
        if (this._open) this._layout();
      }),
      // "Reset size and position" in the prefs, while the window is open.
      deps.settings.connect('changed::search-window-size', () => {
        if (this._open && !this._op && this._style === 'floating') this._layout();
      }));

    // One actor over the whole desktop holds everything: it catches the click
    // that closes the window, and the card sits on it. Card coordinates are
    // therefore stage coordinates, which is what is saved.
    this._root = new St.Widget({
      style_class: 'sds-window-root',
      reactive: true,
      visible: false,
      layout_manager: new Clutter.FixedLayout(),
    });
    // The close is on the root rather than the backdrop because the modal grab
    // covers every monitor while 'full' only frosts one: a click on another
    // screen must close the window, not vanish into the grab.
    this._root.connect('button-press-event', () => {
      this.close();
      return Clutter.EVENT_STOP;
    });
    this._backdrop = new St.Widget();
    this._blurEffect = this._blur();
    this._backdrop.add_effect(this._blurEffect);
    this._root.add_child(this._backdrop);

    // The card is a bin so the resize grip can sit over its corner.
    this._card = new St.Widget({
      style_class: 'sds-window',
      reactive: true,
      layout_manager: new Clutter.BinLayout(),
    });
    this._box = new St.BoxLayout({
      style_class: 'sds-window-box',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: true,
    });
    this._handle = new St.Widget({
      style_class: 'sds-window-handle',
      x_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });
    this._box.add_child(this._handle);
    this._entry = new St.Entry({
      style_class: 'sds-window-entry',
      hint_text: 'Search the web',
      can_focus: true,
      x_expand: true,
      primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'sds-window-entry-icon'}),
    });
    // Only there when there is something to clear, as in the overview's entry.
    this._clearIcon = new St.Icon({icon_name: 'edit-clear-symbolic', style_class: 'sds-window-entry-icon'});
    this._entry.connect('secondary-icon-clicked', () => {
      this._entry.text = '';
      this._entry.grab_key_focus();
    });
    const text = this._entry.clutter_text;
    text.connect('text-changed', () => this._onTextChanged());
    text.connect('activate', () => this._view?.activate());
    text.connect('key-press-event', (_a: Clutter.Actor, event: Clutter.Event) => this._onEntryKey(event));
    // The Enter hint in the page header follows the Shell's "selected" result
    // pseudo-class; here Enter belongs to the entry, so that is when it shows.
    text.connect('key-focus-in', () => this._view?.add_style_pseudo_class('selected'));
    text.connect('key-focus-out', () => this._view?.remove_style_pseudo_class('selected'));
    this._box.add_child(this._entry);
    this._card.add_child(this._box);

    // Drawn rather than styled: St does not paint a border on two sides with a
    // corner radius, so a CSS bracket simply did not appear.
    this._grip = new St.DrawingArea({
      style_class: 'sds-window-grip',
      reactive: true,
      track_hover: true,
      // A bin only honours a child's alignment inside the space it expands into.
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.END,
      visible: false,
      accessible_name: 'Resize',
    });
    this._grip.connect('repaint', (area: St.DrawingArea) => drawGrip(area));
    // Shell 50 gives each actor its own cursor; before that there was one, set
    // by hand on enter and leave.
    if (!setCursor(this._grip, 'SE_RESIZE', true)) {
      this._grip.connect('enter-event', () => setCursor(this._grip, 'SE_RESIZE'));
      this._grip.connect('leave-event', () => {
        if (!this._op) setCursor(this._grip, 'DEFAULT');
      });
    }
    this._grip.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) =>
      this._beginOp('resize', event));
    this._card.add_child(this._grip);

    // A press that nothing inside the card wanted — its padding, the handle,
    // the page header — moves a floating card. The entry, the page and the
    // header's buttons all keep their own presses.
    this._card.connect('button-press-event', (_a: Clutter.Actor, event: Clutter.Event) =>
      this._style === 'floating' ? this._beginOp('move', event) : Clutter.EVENT_STOP);
    // During a drag every pointer event is the drag's, including those over the
    // page, which would otherwise forward them to the renderer and stop them.
    this._card.connect('captured-event', (_a: Clutter.Actor, event: Clutter.Event) => this._onCaptured(event));
    this._root.add_child(this._card);

    // Escape anywhere in the window closes it. The page forwards every other key
    // to the renderer, and the entry handles its own.
    this._root.connect('key-press-event', (_a: Clutter.Actor, event: Clutter.Event) => {
      if (event.get_key_symbol() !== Clutter.KEY_Escape) return Clutter.EVENT_PROPAGATE;
      this.close();
      return Clutter.EVENT_STOP;
    });

    Main.layoutManager.modalDialogGroup.add_child(this._root);
  }

  get isOpen(): boolean { return this._open; }

  toggle(): void {
    if (this._open) this.close();
    else this.open();
  }

  open(): void {
    if (this._open) return;
    // Over a lock screen, an unlock dialog or a system prompt, the shortcut does
    // nothing: those own the keyboard for a reason.
    const mode = Main.actionMode as Shell.ActionMode;
    if (mode !== Shell.ActionMode.NORMAL && mode !== Shell.ActionMode.OVERVIEW) return;
    // The overview's search is the other way in; showing both is one too many.
    if (Main.overview.visible) Main.overview.hide();

    const grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
    // A grab another client already holds comes back revoked; a window that
    // cannot be typed into or escaped from is worse than no window. Clutter 18
    // dropped get_seat_state(), so this asks whichever question the grab has.
    const probe = grab as unknown as {is_revoked?: () => boolean; get_seat_state?: () => number};
    const grabState = (Clutter as unknown as {GrabState?: {KEYBOARD: number}}).GrabState;
    const lost = probe.is_revoked?.()
      ?? (probe.get_seat_state && grabState ? (probe.get_seat_state() & grabState.KEYBOARD) === 0 : false);
    if (lost) {
      Main.popModal(grab);
      return;
    }
    this._grab = grab;
    this._open = true;
    this._layout();
    this._deps.renderer.prewarm();
    this._deps.renderer.setActive(true);

    this._root.remove_all_transitions();
    this._card.remove_all_transitions();
    this._root.opacity = 0;
    this._card.set_pivot_point(0.5, 0);
    this._card.set_scale(0.97, 0.97);
    this._root.show();
    ease(this._root, {opacity: 255, duration: OPEN_MS});
    ease(this._card, {scale_x: 1, scale_y: 1, duration: OPEN_MS});

    // The last search stays, selected, so reopening shows the page it left
    // and typing replaces it.
    this._entry.grab_key_focus();
    this._entry.clutter_text.set_selection(0, -1);
    this._onTextChanged();
  }

  close(): void {
    if (!this._open) return;
    this._endOp(false);
    this._open = false;
    this._cancellable?.cancel();
    this._cancellable = null;
    this._provider.cancelPendingSearch();
    if (this._grab) Main.popModal(this._grab);
    this._grab = null;
    // The overview may be the one taking over; it turns the renderer back on.
    if (!Main.overview.visible) this._deps.renderer.setActive(false);
    this._root.remove_all_transitions();
    ease(this._root, {opacity: 0, duration: CLOSE_MS, onComplete: () => this._root.hide()});
  }

  destroy(): void {
    this._endOp(false);
    if (this._open) {
      this._open = false;
      if (this._grab) Main.popModal(this._grab);
      this._grab = null;
    }
    this._cancellable?.cancel();
    for (const id of this._settingsIds) this._deps.settings.disconnect(id);
    this._settingsIds = [];
    this._provider.destroy();
    this._root.destroy();
    this._view = null;
  }

  // --- layout ------------------------------------------------------------------

  private _blur(): Clutter.Effect {
    const blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: BLUR_BRIGHTNESS});
    // `radius` replaced `sigma` in GNOME 46; set whichever this Shell has.
    const props = blur as unknown as Record<string, number>;
    if ('radius' in blur) props.radius = BLUR_RADIUS;
    else props.sigma = BLUR_RADIUS / 2;
    return blur;
  }

  private _monitor(): Rect & {index?: number} {
    return Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor
      ?? {x: 0, y: 0, width: 1280, height: 800};
  }

  /** The monitor's area minus the top bar and any struts; the monitor itself if that cannot be had. */
  private _workArea(monitor: Rect & {index?: number}): Rect {
    try {
      if (monitor.index !== undefined) return Main.layoutManager.getWorkAreaForMonitor(monitor.index);
    } catch { /* fall through */ }
    return monitor;
  }

  /** The monitor holding a point, if any does. */
  private _monitorAt(x: number, y: number): (Rect & {index?: number}) | null {
    return Main.layoutManager.monitors.find(m =>
      x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ?? null;
  }

  private _fullPageHeight(monitor: Rect): number {
    return clamp(Math.round(monitor.height * HEIGHT_SHARE), HEIGHT_MIN, HEIGHT_MAX);
  }

  /** Everything in the card except the page: entry, header, handle, padding. */
  private _chromeHeight(): number {
    if (!this._view?.visible) return CHROME_ESTIMATE;
    const measured = Math.round(this._card.height) - this._pageHeight;
    return measured > 0 && measured < 400 ? measured : CHROME_ESTIMATE;
  }

  /** Re-applied on every open, since the monitor in use may have changed. */
  private _layout(): void {
    this._style = this._deps.settings.get_string('search-window-style') === 'floating' ? 'floating' : 'full';
    const floating = this._style === 'floating';
    const [stageW, stageH] = global.stage.get_size();
    this._root.set_position(0, 0);
    this._root.set_size(stageW, stageH);

    // Full: the backdrop is the monitor, frosted. Floating: the whole desktop,
    // untouched — it is only there to catch the click that closes the window.
    const monitor = this._monitor();
    const back = floating ? {x: 0, y: 0, width: stageW, height: stageH} : monitor;
    this._backdrop.set_position(back.x, back.y);
    this._backdrop.set_size(back.width, back.height);
    this._blurEffect.enabled = !floating;
    if (floating) this._backdrop.remove_style_class_name('sds-window-backdrop');
    else this._backdrop.add_style_class_name('sds-window-backdrop');
    if (floating) this._card.add_style_class_name('sds-window-floating');
    else this._card.remove_style_class_name('sds-window-floating');
    this._handle.visible = floating;
    this._grip.visible = floating && !!this._view?.visible;

    if (floating) this._layoutFloating(monitor);
    else this._layoutFull(monitor);
  }

  private _layoutFull(m: Rect): void {
    this._width = clamp(Math.round(m.width * WIDTH_SHARE), WIDTH_MIN, Math.min(WIDTH_MAX, m.width - 2 * EDGE_MARGIN));
    this._setPageHeight(this._fullPageHeight(m));
    this._card.set_width(this._width);
    this._card.set_position(m.x + Math.round((m.width - this._width) / 2), m.y + Math.round(m.height * TOP_SHARE));
  }

  private _layoutFloating(current: Rect & {index?: number}): void {
    const [savedX, savedY] = this._deps.settings.get_value('search-window-position').deepUnpack() as [number, number];
    const [savedW, savedH] = this._deps.settings.get_value('search-window-size').deepUnpack() as [number, number];
    // A saved position counts only while it is still on a monitor: unplugging
    // the screen it was left on must not open it somewhere unreachable.
    const placed = savedX >= 0 && savedY >= 0 ? this._monitorAt(savedX + 40, savedY + 20) : null;
    const monitor = placed ?? current;
    const area = this._workArea(monitor);

    const width = savedW > 0 ? savedW : Math.round(monitor.width * FLOAT_WIDTH_SHARE);
    this._width = clamp(width, FLOAT_WIDTH_MIN, area.width - 2 * EDGE_MARGIN);
    const pageHeight = savedH > 0 ? savedH : Math.round(monitor.height * FLOAT_HEIGHT_SHARE);
    this._setPageHeight(clamp(pageHeight, FLOAT_PAGE_MIN, area.height - this._chromeHeight() - 2 * EDGE_MARGIN));
    this._card.set_width(this._width);

    const x = placed ? savedX : area.x + Math.round((area.width - this._width) / 2);
    const y = placed ? savedY : area.y + Math.round(area.height * 0.12);
    this._moveTo(x, y, area);
  }

  /** Keep the whole card on `area`: the entry at least must stay reachable. */
  private _moveTo(x: number, y: number, area: Rect): void {
    const height = this._chromeHeight() + (this._view?.visible ? this._pageHeight : 0);
    const maxX = area.x + area.width - this._width - EDGE_MARGIN;
    const maxY = area.y + area.height - Math.min(height, area.height - 2 * EDGE_MARGIN) - EDGE_MARGIN;
    this._card.set_position(
      Math.round(clamp(x, area.x + EDGE_MARGIN, Math.max(area.x + EDGE_MARGIN, maxX))),
      Math.round(clamp(y, area.y + EDGE_MARGIN, Math.max(area.y + EDGE_MARGIN, maxY))));
  }

  private _setPageHeight(height: number): void {
    this._pageHeight = Math.round(height);
    this._view?.setPageHeight(this._pageHeight);
  }

  // --- drag and resize -----------------------------------------------------------

  private _beginOp(kind: 'move' | 'resize', event: Clutter.Event): boolean {
    if (this._style !== 'floating' || event.get_button() !== 1 || this._op) return Clutter.EVENT_STOP;
    const [px, py] = event.get_coords();
    // A grab of our own on the card, inside the modal one, so the drag keeps
    // its events when the pointer outruns the card.
    const grab = global.stage.grab(this._card);
    this._op = {kind, grab, px, py, x: this._card.x, y: this._card.y, width: this._width, pageHeight: this._pageHeight};
    // The grab's actor decides the cursor while it lasts, wherever the pointer is.
    setCursor(this._card, kind === 'move' ? 'GRABBING' : 'SE_RESIZE');
    return Clutter.EVENT_STOP;
  }

  private _onCaptured(event: Clutter.Event): boolean {
    const op = this._op;
    if (!op) return Clutter.EVENT_PROPAGATE;
    const type = event.type();
    if (type === Clutter.EventType.MOTION) {
      const [px, py] = event.get_coords();
      const dx = px - op.px;
      const dy = py - op.py;
      if (op.kind === 'move') {
        // Free while dragging, across monitors; clamped when it is let go.
        this._card.set_position(Math.round(op.x + dx), Math.round(op.y + dy));
      } else {
        const area = this._workArea(this._monitorAt(op.x + 40, op.y + 20) ?? this._monitor());
        this._width = clamp(Math.round(op.width + dx), FLOAT_WIDTH_MIN, area.x + area.width - op.x - EDGE_MARGIN);
        this._card.set_width(this._width);
        this._setPageHeight(clamp(op.pageHeight + dy, FLOAT_PAGE_MIN,
          area.y + area.height - op.y - this._chromeHeight() - EDGE_MARGIN));
      }
      return Clutter.EVENT_STOP;
    }
    if (type === Clutter.EventType.BUTTON_RELEASE) {
      this._endOp(true);
      return Clutter.EVENT_STOP;
    }
    // Everything else — a press, a scroll — waits until the drag is over.
    return type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE
      ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
  }

  /** Finish a drag. `save` keeps the result; a drag cut short by a close is not worth remembering. */
  private _endOp(save: boolean): void {
    const op = this._op;
    if (!op) return;
    this._op = null;
    op.grab.dismiss();
    // Per-actor cursors: the card goes back to inheriting, and the grip keeps
    // its own. A single global cursor: whatever is under the pointer now.
    if (!setCursor(this._card, 'INHERIT', true))
      setCursor(this._card, this._grip.hover ? 'SE_RESIZE' : 'DEFAULT');
    if (!save) return;
    if (op.kind === 'move') {
      const [x, y] = [this._card.x, this._card.y];
      this._moveTo(x, y, this._workArea(this._monitorAt(x + 40, y + 20) ?? this._monitor()));
    }
    // Two copies of the GLib typings are in play (Gio's own and the Shell's); the runtime type is one.
    const pair = (a: number, b: number) => new GLib.Variant('(ii)', [a, b]) as unknown as SettingsVariant;
    const settings = this._deps.settings;
    settings.set_value('search-window-position', pair(Math.round(this._card.x), Math.round(this._card.y)));
    settings.set_value('search-window-size', pair(this._width, this._pageHeight));
  }

  // --- search --------------------------------------------------------------------

  private _onTextChanged(): void {
    const empty = this._entry.text === '';
    if (empty !== (this._entry.secondary_icon === null))
      this._entry.set_secondary_icon(empty ? null : this._clearIcon);
    if (!this._open) return;
    this._cancellable?.cancel();
    const cancellable = this._cancellable = new Gio.Cancellable();
    const terms = this._entry.text.trim().split(/\s+/).filter(t => t !== '');
    // The provider answers synchronously; the promise is the Shell's contract.
    this._provider.getInitialResultSet(terms, cancellable).then(ids => {
      if (cancellable.is_cancelled() || !this._open) return;
      this._showResults(ids.length > 0);
    }).catch(error => console.warn(`[SearchDoesSearch] search window: ${error}`));
  }

  /** The card is just the entry until there is something to search for. */
  private _showResults(show: boolean): void {
    if (show && !this._view) {
      const view = this._provider.createResultObject({id: 'sds:page'}) as PageView | null;
      if (view) {
        this._view = view;
        if (this._entry.clutter_text.has_key_focus()) view.add_style_pseudo_class('selected');
        view.setPageHeight(this._pageHeight);
        this._box.add_child(view);
      }
    }
    if (this._view) this._view.visible = show;
    // Nothing to resize until there is a page; the width alone is not worth a grip.
    this._grip.visible = show && this._style === 'floating';
  }

  private _onEntryKey(event: Clutter.Event): boolean {
    const symbol = event.get_key_symbol();
    if (symbol === Clutter.KEY_Escape) {
      this.close();
      return Clutter.EVENT_STOP;
    }
    // Down or Tab moves into the page, as it does from the overview's entry.
    if ((symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Tab) && this._view?.visible) {
      this._view.focusPage();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }
}
