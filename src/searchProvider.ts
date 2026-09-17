import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {openInDefaultBrowser} from './browserLauncher.js';
import {engineFor} from './engines.js';

interface ResultMeta { id: string; name: string; description: string; createIcon: (size: number) => St.Widget; }

/**
 * The actor shown in the overview for this provider's single result. It is
 * built by the extension (it needs the Shell's St/Main modules, which do not
 * exist in the headless test harness) and reused for the life of a search.
 */
export interface ResultView {
  /** The overview's terms changed. */
  setQuery(query: string): void;
  /** The terms held still; `reloading` says the renderer was asked for a new page. */
  querySettled(query: string, reloading: boolean): void;
  /** True while the user is on a page they followed rather than the results page. */
  readonly navigated: boolean;
  connect(signal: 'destroy', callback: () => void): number;
}

export interface SearchProviderOptions {
  /** Which engine's page is rendered: a value of the `engine` setting. */
  engine: string;
  /** Loads the page. Absent in the headless harness. */
  renderer?: {search(query: string, engine: string): void};
  /** Builds the overview actor. Absent in the headless harness. */
  createView?: () => ResultView;
}

/** Wait for a short pause in typing; cap requests during slower continuous input.
 * Starting loads for partial words wastes work and increases engine challenges.
 * The local search UI still updates immediately, independently of this pacing.
 */
const RENDER_DEBOUNCE_MS = 250;
const RENDER_MIN_INTERVAL_MS = 700;

const PAGE_RESULT_ID = 'sds:page';

/**
 * Section heading for the results (the extension's own name), and the reason this
 * provider has an `appInfo` at all: providers with one render as a list section,
 * providers without render as an icon grid, which cannot hold the page view.
 * There is no installed .desktop file to point at, so a synthetic GAppInfo carries
 * the name and icon; `should_show` is stubbed because the Shell calls it while
 * building the section header.
 */
function createProviderAppInfo(): Gio.AppInfo {
  const appInfo = Gio.AppInfo.create_from_commandline(
    'true', 'Web search', Gio.AppInfoCreateFlags.NONE);
  appInfo.get_icon = () => new Gio.ThemedIcon({name: 'web-browser-symbolic'});
  appInfo.should_show = () => true;
  return appInfo;
}

export class SearchProvider {
  readonly id = 'search-does-search@searchdoessearch.github.io';
  readonly appInfo = createProviderAppInfo();
  /** The clickable section heading opens the same search in the browser. */
  readonly canLaunchSearch = true;
  private _options: SearchProviderOptions;
  private _query = '';
  private _suspended = false;
  private _rendered = '';
  private _debounceId = 0;
  private _lastRenderAt = 0;
  private _view: ResultView | null = null;

  constructor(options: SearchProviderOptions) { this._options = options; }
  updateOptions(options: Partial<SearchProviderOptions>): void {
    const engineChanged = options.engine !== undefined && options.engine !== this._options.engine;
    this._options = {...this._options, ...options};
    if (engineChanged) {
      this._rendered = '';
      if (this._query && !this._suspended) this._scheduleRender(this._query);
    }
  }

  /**
   * One result, always the same id: the Shell keeps the actor it built for an id
   * across term changes, so the page view persists while the user types and only
   * the query it shows changes.
   */
  /** Mask the old page before GNOME's own search-provider debounce runs. */
  previewQuery(query: string): void {
    if (this._view?.navigated && query !== this._query) this._rendered = '';
    this._view?.setQuery(query);
    if (!query) {
      this._query = '';
      this._cancelDebounce();
    }
  }

  getInitialResultSet(terms: string[], cancellable: Gio.Cancellable): Promise<string[]> {
    const query = terms.join(' ').trim();
    if (!query || cancellable.is_cancelled()) {
      this._cancelDebounce();
      this._query = '';
      this._view?.setQuery('');
      return Promise.resolve([]);
    }
    this._suspended = false;
    if (this._view?.navigated && query !== this._query) this._rendered = '';
    this._query = query;
    this._view?.setQuery(query);
    this._scheduleRender(query, cancellable);
    return Promise.resolve([PAGE_RESULT_ID]);
  }

  getSubsearchResultSet(_previous: string[], terms: string[], cancellable: Gio.Cancellable): Promise<string[]> {
    return this.getInitialResultSet(terms, cancellable);
  }

  getResultMetas(ids: string[], cancellable: Gio.Cancellable): Promise<ResultMeta[]> {
    if (cancellable.is_cancelled()) return Promise.resolve([]);
    return Promise.resolve(ids.flatMap(id => id === PAGE_RESULT_ID ? [{
      id,
      name: this._query || 'Web results',
      description: '',
      createIcon: (size: number) => new St.Icon({icon_name: 'web-browser-symbolic', icon_size: size}),
    }] : []));
  }

  /** Shell hook: the actor for a result. Without a view factory (harness) the Shell's plain row is used. */
  createResultObject(meta: {id: string}): ResultView | null {
    if (meta.id !== PAGE_RESULT_ID || !this._options.createView) return null;
    if (!this._view) {
      const view = this._options.createView();
      view.connect('destroy', () => {
        if (this._view === view) this._view = null;
      });
      this._view = view;
      // Rebuilt after the Shell cleared its results: the page may already be showing.
      view.setQuery(this._query);
    }
    return this._view;
  }

  activateResult(_id: string, terms: string[]): void {
    this.launchSearch(terms);
  }

  /** Section heading clicked (or Enter on the plain row): the search, in the browser. */
  launchSearch(terms: string[]): void {
    const query = terms.join(' ').trim();
    if (!query) return;
    openInDefaultBrowser(engineFor(this._options.engine).browser(query));
  }

  filterResults(results: string[], max: number): string[] { return results.slice(0, max); }

  private _scheduleRender(query: string, cancellable?: Gio.Cancellable): void {
    this._cancelDebounce();
    if (!this._options.renderer) return;
    const sinceLast = GLib.get_monotonic_time() / 1000 - this._lastRenderAt;
    const wait = Math.max(RENDER_DEBOUNCE_MS, RENDER_MIN_INTERVAL_MS - sinceLast);
    this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(wait), () => {
      this._debounceId = 0;
      if (cancellable?.is_cancelled() || query !== this._query || !this._options.renderer) return GLib.SOURCE_REMOVE;
      // The same query coming back (the overview was reopened) keeps the page —
      // unless the user followed links from it, in which case the results page
      // is no longer what is showing and settling has to bring it back.
      const reloading = query !== this._rendered || (this._view?.navigated ?? false);
      this._view?.querySettled(query, reloading);
      if (reloading) {
        this._rendered = query;
        this._lastRenderAt = GLib.get_monotonic_time() / 1000;
        this._options.renderer.search(query, this._options.engine);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  private _cancelDebounce(): void {
    if (this._debounceId) GLib.source_remove(this._debounceId);
    this._debounceId = 0;
  }

  /** A hidden overview must not start a queued request. */
  suspend(): void {
    this._suspended = true;
    this._cancelDebounce();
  }

  destroy(): void {
    this.suspend();
    this._query = '';
    this._rendered = '';
    this._view = null;
  }
}
