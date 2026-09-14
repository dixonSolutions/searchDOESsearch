import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {openInDefaultBrowser} from './browserLauncher.js';
import {SearchOutcome, WebResult, fetchWebResults} from './webSearch.js';

interface ResultMeta { id: string; name: string; description: string; createIcon: (size: number) => St.Widget; }

/** The compact link list shown in the sidebar, or a notice explaining why there is none. */
export interface LinkOutcome { results: WebResult[]; notice: string | null; }

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
  connect(signal: 'destroy', callback: () => void): number;
}

export interface SearchProviderOptions {
  instanceUrl: string;
  /** Which engine's page is rendered: a key of the panel-engine setting. */
  engine: string;
  /** Loads the page. Absent in the headless harness. */
  renderer?: {search(query: string, engine: string): void};
  /** Builds the overview actor. Absent in the headless harness. */
  createView?: (fetchLinks: (query: string, limit: number, cancellable: Gio.Cancellable) => Promise<LinkOutcome>) => ResultView;
}

/**
 * A keystroke changes the terms several times a second; the renderer loads the
 * page only once they have held still this long. Meanwhile the view keeps the
 * previous page and shows the new terms in its header.
 */
const RENDER_DEBOUNCE_MS = 450;

const PAGE_RESULT_ID = 'sds:page';
const BROWSER_URLS: Record<string, (q: string) => string> = {
  duckduckgo: q => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  google: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
};

const DOCS_INSTALL = 'https://docs.searxng.org/admin/installation-docker.html';

/**
 * Turn a failed lookup into one line that states the cause. Showing nothing
 * would be indistinguishable from "no matches".
 */
function noticeFor(outcome: SearchOutcome): string | null {
  switch (outcome.status) {
    case 'badInstance': return `${outcome.detail} — set a SearXNG instance in the extension settings (${DOCS_INSTALL})`;
    case 'unreachable': return `SearXNG is not responding: ${outcome.detail}`;
    case 'enginesUnavailable': return `SearXNG could not reach any engine (${outcome.engines.join(', ')})`;
    case 'notJson': return `Enable JSON output on your SearXNG instance: ${outcome.detail}`;
    default: return null;
  }
}

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
    'true', 'searchDOESsearch', Gio.AppInfoCreateFlags.NONE);
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
  private _rendered = '';
  private _debounceId = 0;
  private _view: ResultView | null = null;

  constructor(options: SearchProviderOptions) { this._options = options; }
  updateOptions(options: Partial<SearchProviderOptions>): void {
    const engineChanged = options.engine !== undefined && options.engine !== this._options.engine;
    this._options = {...this._options, ...options};
    if (engineChanged) this._rendered = '';
  }

  /**
   * One result, always the same id: the Shell keeps the actor it built for an id
   * across term changes, so the page view persists while the user types and only
   * the query it shows changes.
   */
  getInitialResultSet(terms: string[], cancellable: Gio.Cancellable): Promise<string[]> {
    const query = terms.join(' ').trim();
    if (!query || cancellable.is_cancelled()) {
      this._cancelDebounce();
      return Promise.resolve([]);
    }
    this._query = query;
    this._view?.setQuery(query);
    this._scheduleRender(query);
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
      const view = this._options.createView((query, limit, cancellable) => this.fetchLinks(query, limit, cancellable));
      view.connect('destroy', () => {
        if (this._view === view) this._view = null;
      });
      this._view = view;
      // Rebuilt after the Shell cleared its results: the page may already be showing.
      view.setQuery(this._query);
    }
    return this._view;
  }

  /** The compact link list (SearXNG JSON) for the sidebar. */
  async fetchLinks(query: string, limit: number, cancellable: Gio.Cancellable): Promise<LinkOutcome> {
    const outcome = await fetchWebResults(query, this._options.instanceUrl, limit, cancellable);
    if (outcome.status === 'ok') return {results: outcome.results, notice: null};
    const notice = noticeFor(outcome);
    if (notice) console.warn(`[SearchDoesSearch] ${outcome.status}: ${notice}`);
    return {results: [], notice};
  }

  activateResult(_id: string, terms: string[]): void {
    this.launchSearch(terms);
  }

  /** Section heading clicked (or Enter on the plain row): the search, in the browser. */
  launchSearch(terms: string[]): void {
    const query = terms.join(' ').trim();
    if (!query) return;
    const toUrl = BROWSER_URLS[this._options.engine] ?? BROWSER_URLS.duckduckgo;
    openInDefaultBrowser(toUrl(query));
  }

  filterResults(results: string[], max: number): string[] { return results.slice(0, max); }

  private _scheduleRender(query: string): void {
    this._cancelDebounce();
    if (!this._options.renderer) return;
    this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RENDER_DEBOUNCE_MS, () => {
      this._debounceId = 0;
      if (query !== this._query || !this._options.renderer) return GLib.SOURCE_REMOVE;
      // The same query coming back (the overview was reopened) keeps the page.
      const reloading = query !== this._rendered;
      if (reloading) {
        this._rendered = query;
        this._options.renderer.search(query, this._options.engine);
      }
      this._view?.querySettled(query, reloading);
      return GLib.SOURCE_REMOVE;
    });
  }

  private _cancelDebounce(): void {
    if (this._debounceId) GLib.source_remove(this._debounceId);
    this._debounceId = 0;
  }

  destroy(): void {
    this._cancelDebounce();
    this._query = '';
    this._rendered = '';
    this._view = null;
  }
}
