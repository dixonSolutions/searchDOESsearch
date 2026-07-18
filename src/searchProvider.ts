import St from 'gi://St';
import Gio from 'gi://Gio';
import {openInDefaultBrowser} from './browserLauncher.js';
import {WebResult, WebSearchEngine, fetchWebResults} from './webSearch.js';

interface ResultMeta { id: string; name: string; description: string; createIcon: (size: number) => St.Widget; }
export interface OtherResultsState { complete: boolean; hasResults: boolean; }
export interface SearchProviderOptions { engine: WebSearchEngine; browserCommand: string; maxResults: number; getOtherResultsState: () => OtherResultsState; }

function wait(ms: number, cancellable: Gio.Cancellable): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancellable.is_cancelled()) { reject(new Error('Search cancelled')); return; }
    let cancelledId = 0;
    const timeoutId = setTimeout(() => { if (cancelledId) cancellable.disconnect(cancelledId); resolve(); }, ms);
    cancelledId = cancellable.connect(() => { clearTimeout(timeoutId); cancellable.disconnect(cancelledId); reject(new Error('Search cancelled')); });
  });
}

export class SearchProvider {
  readonly id = 'search-does-search@searchdoessearch.github.io';
  readonly appInfo = null;
  readonly canLaunchSearch = false;
  private _options: SearchProviderOptions;
  private _results = new Map<string, WebResult>();

  constructor(options: SearchProviderOptions) { this._options = options; }
  updateOptions(options: Partial<Omit<SearchProviderOptions, 'getOtherResultsState'>>): void { this._options = {...this._options, ...options}; }

  private async _hasOtherResults(cancellable: Gio.Cancellable): Promise<boolean> {
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      const state = this._options.getOtherResultsState();
      if (state.hasResults || state.complete) return state.hasResults;
      await wait(50, cancellable);
    }
    return this._options.getOtherResultsState().hasResults;
  }

  async getInitialResultSet(terms: string[], cancellable: Gio.Cancellable): Promise<string[]> {
    const query = terms.join(' ').trim();
    this._results.clear();
    if (!query || await this._hasOtherResults(cancellable)) return [];
    const results = await fetchWebResults(query, this._options.engine, this._options.browserCommand, this._options.maxResults, cancellable);
    return results.map((result, index) => {
      const id = `sds:${index}:${encodeURIComponent(result.url)}`;
      this._results.set(id, result);
      return id;
    });
  }

  getSubsearchResultSet(_previous: string[], terms: string[], cancellable: Gio.Cancellable): Promise<string[]> { return this.getInitialResultSet(terms, cancellable); }
  getResultMetas(ids: string[], cancellable: Gio.Cancellable): Promise<ResultMeta[]> {
    if (cancellable.is_cancelled()) return Promise.resolve([]);
    return Promise.resolve(ids.flatMap(id => {
      const result = this._results.get(id);
      return result ? [{id, name: result.title, description: result.description || result.displayUrl,
        createIcon: (size: number) => new St.Icon({icon_name: 'web-browser-symbolic', icon_size: size})}] : [];
    }));
  }
  activateResult(id: string, _terms: string[]): void { const result = this._results.get(id); if (result) openInDefaultBrowser(result.url); }
  filterResults(results: string[], max: number): string[] { return results.slice(0, max); }
  destroy(): void { this._results.clear(); }
}
