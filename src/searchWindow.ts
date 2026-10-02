/**
 * searchWindow.ts — the search box a shortcut opens over whatever you are doing.
 *
 * The overview is one way in; this is the other. A keyboard shortcut (Super+
 * Shift+S unless changed) opens a frosted card with a search entry, and the same
 * results page the overview shows grows under it as you type. Escape, a click
 * outside the card, or the shortcut again closes it. Enter hands the search to
 * the browser, like Enter on the overview's section.
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
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PageView, ViewHost} from './pageView.js';
import {RendererClient} from './rendererClient.js';
import {SearchProvider} from './searchProvider.js';

/** The card's share of the monitor, and the bounds that keep it sensible on a tiny or a huge one. */
const WIDTH_SHARE = 0.62;
const WIDTH_MIN = 560;
const WIDTH_MAX = 1100;
const HEIGHT_SHARE = 0.62;
const HEIGHT_MIN = 320;
const HEIGHT_MAX = 1000;
/** Where the card's top edge sits, as a share of the monitor's height. */
const TOP_SHARE = 0.12;
const OPEN_MS = 140;
const CLOSE_MS = 100;
/** Frosting behind the card. The Shell's own blur, done on the GPU. */
const BLUR_RADIUS = 36;
const BLUR_BRIGHTNESS = 0.72;

interface Easeable { ease(params: object): void }
function ease(actor: Clutter.Actor, params: object): void {
  (actor as unknown as Easeable).ease({mode: Clutter.AnimationMode.EASE_OUT_QUAD, ...params});
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
  private _card: St.BoxLayout;
  private _entry: St.Entry;
  private _clearIcon: St.Icon;
  private _view: PageView | null = null;
  private _grab: Clutter.Grab | null = null;
  private _open = false;
  private _settingsId = 0;
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
        const view = new PageView({renderer: deps.renderer, settings: deps.settings, host, height: this._pageHeight()});
        view.connect('destroy', () => {
          if (this._view === view) this._view = null;
        });
        return view;
      },
    });
    this._settingsId = deps.settings.connect('changed::engine', () =>
      this._provider.updateOptions({engine: deps.settings.get_string('engine')}));

    // Everything lives in one full-monitor actor: the frosted backdrop catches
    // the click that closes the window, and the card sits on it.
    this._root = new St.Widget({
      style_class: 'sds-window-root',
      reactive: true,
      visible: false,
      layout_manager: new Clutter.FixedLayout(),
    });
    this._backdrop = new St.Widget({style_class: 'sds-window-backdrop', reactive: true});
    this._backdrop.add_effect(this._blur());
    this._backdrop.connect('button-press-event', () => {
      this.close();
      return Clutter.EVENT_STOP;
    });
    this._root.add_child(this._backdrop);

    this._card = new St.BoxLayout({
      style_class: 'sds-window',
      orientation: Clutter.Orientation.VERTICAL,
      reactive: true,
    });
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
    this._card.add_child(this._entry);
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
    const lost = probe.is_revoked?.()
      ?? (probe.get_seat_state ? (probe.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0 : false);
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
    this._open = false;
    this._cancellable?.cancel();
    this._cancellable = null;
    if (this._grab) Main.popModal(this._grab);
    this._grab = null;
    // The overview may be the one taking over; it turns the renderer back on.
    if (!Main.overview.visible) this._deps.renderer.setActive(false);
    this._root.remove_all_transitions();
    ease(this._root, {opacity: 0, duration: CLOSE_MS, onComplete: () => this._root.hide()});
  }

  destroy(): void {
    if (this._open) {
      this._open = false;
      if (this._grab) Main.popModal(this._grab);
      this._grab = null;
    }
    this._cancellable?.cancel();
    if (this._settingsId) this._deps.settings.disconnect(this._settingsId);
    this._settingsId = 0;
    this._provider.destroy();
    this._root.destroy();
    this._view = null;
  }

  // --- internals ---------------------------------------------------------------

  private _blur(): Clutter.Effect {
    const blur = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, brightness: BLUR_BRIGHTNESS});
    // `radius` replaced `sigma` in GNOME 46; set whichever this Shell has.
    const props = blur as unknown as Record<string, number>;
    if ('radius' in blur) props.radius = BLUR_RADIUS;
    else props.sigma = BLUR_RADIUS / 2;
    return blur;
  }

  private _monitor(): {x: number; y: number; width: number; height: number} {
    return Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor
      ?? {x: 0, y: 0, width: 1280, height: 800};
  }

  private _pageHeight(): number {
    const height = this._monitor().height;
    return Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, Math.round(height * HEIGHT_SHARE)));
  }

  /** On the monitor the user is working on, which may not be the one it was last opened on. */
  private _layout(): void {
    const m = this._monitor();
    this._root.set_position(m.x, m.y);
    this._root.set_size(m.width, m.height);
    this._backdrop.set_position(0, 0);
    this._backdrop.set_size(m.width, m.height);
    const width = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(m.width * WIDTH_SHARE), m.width - 32));
    this._card.set_width(width);
    this._card.set_position(Math.round((m.width - width) / 2), Math.round(m.height * TOP_SHARE));
  }

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
        this._card.add_child(view);
      }
    }
    if (this._view) this._view.visible = show;
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

