/**
 * rendererClient.ts — the Shell's handle on the page renderer process.
 *
 * GNOME Shell cannot host WebKit, so panel/sds-renderer.js renders the results
 * page off-screen in its own process and exports every repaint as raw pixels.
 * This client owns that process: it spawns it on demand, talks to it over the
 * session bus, and fans its signals (frames, state, launched links) out to the
 * overview widget. The renderer is kept alive between searches — starting
 * WebKit costs ~0.4s, a new query on a warm renderer costs nothing extra.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const RENDERER_BUS_NAME = 'io.github.searchdoessearch.Renderer';
export const RENDERER_OBJECT_PATH = '/io/github/searchdoessearch/Renderer';

/** A frame the renderer has written: raw RGBA, `stride` bytes per row. */
export interface Frame { path: string; width: number; height: number; stride: number; serial: number; }
export type RendererState = 'loading' | 'ready' | 'blocked' | 'error';
/** What a clicked link does: follow it in this view, or hand it to the browser. */
export type LinkMode = 'contained' | 'browser';
/** Where the user is: depth 0 is the results page itself. */
export interface Nav { depth: number; title: string; uri: string; }
export type PointerKind = 'press' | 'release' | 'move' | 'leave';
export type KeyKind = 'press' | 'release';

export interface RendererListener {
  onFrame(frame: Frame): void;
  /** `query` is the search the state belongs to; anything else is stale. */
  onState(state: RendererState, detail: string, query: string): void;
  onLaunched(url: string): void;
  onNav(nav: Nav): void;
  /** A link this view will not open at all; the argument is its scheme. */
  onRefused(scheme: string): void;
}

const CALL_TIMEOUT_MS = 2000;
type VariantArg = Parameters<Gio.DBusProxy['call']>[1];

export class RendererClient {
  private _script: string;
  private _listeners = new Set<RendererListener>();
  private _proxy: Gio.DBusProxy | null = null;
  private _signalId = 0;
  private _watchId = 0;
  private _process: Gio.Subprocess | null = null;
  /** Whether this renderer ever reached the bus; a crash before that is a real failure. */
  private _served = false;
  private _cancellable = new Gio.Cancellable();
  private _lastSearch: [string, string] | null = null;
  private _lastConfigure: [number, number, number] | null = null;
  private _linkMode: LinkMode = 'contained';
  private _destroyed = false;

  /** @param script absolute path of panel/sds-renderer.js */
  constructor(script: string) {
    this._script = script;
    this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, RENDERER_BUS_NAME, Gio.BusNameWatcherFlags.NONE,
      () => this._onNameAppeared(),
      () => this._onNameVanished());
  }

  get isRunning(): boolean { return this._proxy !== null; }

  addListener(listener: RendererListener): void { this._listeners.add(listener); }
  removeListener(listener: RendererListener): void { this._listeners.delete(listener); }

  /** Load the engine's results page for `query`; starts the renderer if needed. */
  search(query: string, engine: string): void {
    this._lastSearch = [query, engine];
    this._ensureRunning();
    this._call('Search', new GLib.Variant('(ss)', [query, engine]));
  }

  /** Start the renderer process before it is needed, so the first search is not also a cold start. */
  prewarm(): void {
    this._ensureRunning();
  }

  /** Load what is showing again — the results page, or the followed page. */
  reload(): void {
    this._call('Reload', null);
  }

  /** One step back towards the results page; ignored at depth 0. */
  back(): void {
    this._call('Back', null);
  }

  /** Hand whatever the view is showing to the default browser. */
  openCurrent(): void {
    this._call('OpenCurrent', null);
  }

  /** Replayed if the renderer restarts, so a link never opens the wrong way. */
  setLinkMode(mode: LinkMode): void {
    if (mode === this._linkMode && this._proxy) return;
    this._linkMode = mode;
    this._call('SetLinkMode', new GLib.Variant('(s)', [mode]));
  }

  /** Frame size in device pixels and the Shell's scale factor (applied as page zoom). */
  configure(width: number, height: number, scale: number): void {
    const next: [number, number, number] = [width, height, scale];
    if (this._lastConfigure && next.every((v, i) => v === this._lastConfigure![i])) return;
    this._lastConfigure = next;
    this._call('Configure', new GLib.Variant('(iid)', next));
  }

  scroll(x: number, y: number, dx: number, dy: number): void {
    this._call('Scroll', new GLib.Variant('(dddd)', [x, y, dx, dy]), true);
  }

  /** `clicks` is the click count: 2 and 3 are what let a page select a word or a line. */
  pointer(kind: PointerKind, x: number, y: number, button: number, state: number, clicks = 1): void {
    this._call('Pointer', new GLib.Variant('(sdduuu)', [kind, x, y, button >>> 0, state >>> 0, clicks >>> 0]), true);
  }

  key(kind: KeyKind, keyval: number, keycode: number, state: number): void {
    this._call('Key', new GLib.Variant('(suuu)', [kind, keyval >>> 0, keycode >>> 0, state >>> 0]), true);
  }

  /** Ask for the current state and a fresh frame (a newly built view needs both). */
  refresh(): void {
    this._call('Refresh', null, true);
  }

  destroy(): void {
    this._destroyed = true;
    this._cancellable.cancel();
    if (this._proxy) {
      this._call('Quit', null, true);
    } else if (this._process) {
      // Disabled while WebKit was still starting: there is no one to ask
      // politely, and a renderer left behind holds the bus name and its web
      // process for the next quarter of an hour.
      try {
        this._process.force_exit();
      } catch (error) {
        console.warn(`[SearchDoesSearch] could not stop the starting renderer: ${error}`);
      }
    }
    this._dropProxy();
    if (this._watchId) {
      Gio.bus_unwatch_name(this._watchId);
      this._watchId = 0;
    }
    this._listeners.clear();
    this._process = null;
  }

  // --- process -----------------------------------------------------------------

  private _ensureRunning(): void {
    if (this._destroyed || this._proxy || this._process) return;
    const gjs = GLib.find_program_in_path('gjs');
    if (!gjs) {
      console.warn('[SearchDoesSearch] cannot render the results page: gjs is not installed');
      this._emitState('error', 'gjs is not installed');
      return;
    }
    try {
      const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_SILENCE});
      const process = launcher.spawnv([gjs, '-m', this._script]);
      this._process = process;
      process.wait_async(null, (proc, res) => {
        try {
          proc?.wait_finish(res);
        } catch { /* reaped anyway */ }
        if (this._process === process) this._process = null;
        const status = process.get_if_exited() ? process.get_exit_status() : -1;
        // The renderer exits by design after a long idle, and on Quit. Only a
        // renderer that died without ever serving the bus, or crashed, is worth
        // telling the user about — the rest is normal housekeeping, and
        // reporting it painted an error over a perfectly good page.
        if (this._destroyed || status === 0) return;
        console.warn(`[SearchDoesSearch] renderer exited (status ${status})`);
        if (!this._served) this._emitState('error', 'The page renderer failed to start');
      });
    } catch (error) {
      console.warn(`[SearchDoesSearch] failed to start the page renderer: ${error}`);
      this._emitState('error', 'The page renderer failed to start');
    }
  }

  private _onNameAppeared(): void {
    if (this._destroyed || this._proxy) return;
    Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
      Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START,
      null, RENDERER_BUS_NAME, RENDERER_OBJECT_PATH, RENDERER_BUS_NAME, this._cancellable,
      (_source, res) => {
        let proxy: Gio.DBusProxy;
        try {
          proxy = Gio.DBusProxy.new_for_bus_finish(res);
        } catch (error) {
          if (!this._cancellable.is_cancelled())
            console.warn(`[SearchDoesSearch] cannot reach the page renderer: ${error}`);
          return;
        }
        if (this._destroyed) return;
        this._proxy = proxy;
        this._served = true;
        this._signalId = proxy.connect('g-signal', (_p, _sender, name, params) => this._onSignal(name, params));
        // The renderer may have (re)started after these were requested.
        this._call('SetLinkMode', new GLib.Variant('(s)', [this._linkMode]));
        if (this._lastConfigure) this._call('Configure', new GLib.Variant('(iid)', this._lastConfigure));
        if (this._lastSearch) this._call('Search', new GLib.Variant('(ss)', this._lastSearch));
      });
  }

  private _onNameVanished(): void {
    this._dropProxy();
    // The process is gone (idle exit, Quit, a crash). Forget the handle, or the
    // next search finds `_process` still set, decides a renderer is on its way,
    // and is dropped on the floor.
    this._process = null;
    this._served = false;
  }

  private _dropProxy(): void {
    if (this._proxy && this._signalId) this._proxy.disconnect(this._signalId);
    this._signalId = 0;
    this._proxy = null;
  }

  // --- messages ----------------------------------------------------------------

  /**
   * Fire-and-forget. `input` calls are meaningless without a live renderer and
   * are dropped; everything else is replayed from the recorded state once the
   * name appears, so nothing is queued here.
   */
  private _call(method: string, params: GLib.Variant | null, input = false): void {
    const proxy = this._proxy;
    if (!proxy) {
      if (!input) this._ensureRunning();
      return;
    }
    // Two copies of the GLib typings are in play (Gio's own and the Shell's); the runtime type is one.
    proxy.call(method, params as VariantArg, Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, null, (_p, res) => {
      try {
        proxy.call_finish(res);
      } catch (error) {
        if (!this._destroyed) console.warn(`[SearchDoesSearch] renderer ${method} failed: ${error}`);
      }
    });
  }

  private _onSignal(name: string, params: GLib.Variant): void {
    switch (name) {
      case 'Frame': {
        const [path, width, height, stride, serial] = params.deepUnpack() as [string, number, number, number, number];
        for (const l of this._listeners) l.onFrame({path, width, height, stride, serial});
        break;
      }
      case 'State': {
        const [state, detail, query] = params.deepUnpack() as [string, string, string];
        this._emitState(state as RendererState, detail, query);
        break;
      }
      case 'Launched': {
        const [url] = params.deepUnpack() as [string];
        for (const l of this._listeners) l.onLaunched(url);
        break;
      }
      case 'Nav': {
        const [depth, title, uri] = params.deepUnpack() as [number, string, string];
        for (const l of this._listeners) l.onNav({depth, title, uri});
        break;
      }
      case 'Refused': {
        const [scheme] = params.deepUnpack() as [string];
        for (const l of this._listeners) l.onRefused(scheme);
        break;
      }
      default:
        break;
    }
  }

  private _emitState(state: RendererState, detail: string, query = ''): void {
    for (const l of this._listeners) l.onState(state, detail, query);
  }
}
