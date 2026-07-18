import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import {OtherResultsState, SearchProvider} from './searchProvider.js';
import {WebSearchEngine} from './webSearch.js';

interface ShellProvider { id?: string; searchInProgress?: boolean; }
interface SearchResultsInternals { _providers?: ShellProvider[]; _results?: Record<string, string[]>; }
interface SearchControllerInternals { _searchResults?: SearchResultsInternals; }

export default class SearchDoesSearchExtension extends Extension {
  private _provider: SearchProvider | null = null;
  private _settings: Gio.Settings | null = null;
  private _settingsChangedId = 0;

  private _getOtherResultsState(): OtherResultsState {
    // The public provider API isolates providers. Aggregate Shell state is
    // required to make this a true fallback for apps, files, and other results.
    const controller = Main.overview.searchController as unknown as SearchControllerInternals;
    const view = controller._searchResults;
    const providers = view?._providers ?? [];
    const results = view?._results ?? {};
    const others = providers.filter(provider => provider.id !== this._provider?.id);
    return {
      complete: others.every(provider => provider.searchInProgress !== true),
      hasResults: others.some(provider => (results[provider.id ?? '']?.length ?? 0) > 0),
    };
  }

  private _readOptions(): {engine: WebSearchEngine; browserCommand: string; maxResults: number} {
    return {
      engine: this._settings?.get_string('search-engine') === 'google' ? 'google' : 'duckduckgo',
      browserCommand: this._settings?.get_string('browser-command') ?? '',
      maxResults: this._settings?.get_int('max-results') ?? 3,
    };
  }

  enable(): void {
    this._settings = this.getSettings();
    this._provider = new SearchProvider({...this._readOptions(), getOtherResultsState: this._getOtherResultsState.bind(this)});
    this._settingsChangedId = this._settings.connect(
      'changed',
      () => this._provider?.updateOptions(this._readOptions())
    );
    Main.overview.searchController.addProvider(this._provider);
  }

  disable(): void {
    if (this._settings && this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = 0;
    }
    if (this._provider) {
      Main.overview.searchController.removeProvider(this._provider);
      this._provider.destroy();
      this._provider = null;
    }
    this._settings = null;
  }
}
