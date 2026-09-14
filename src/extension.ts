import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PageView} from './pageView.js';
import {RendererClient} from './rendererClient.js';
import {SearchProvider, SearchProviderOptions} from './searchProvider.js';

export default class SearchDoesSearchExtension extends Extension {
  private _provider: SearchProvider | null = null;
  private _renderer: RendererClient | null = null;
  private _settings: Gio.Settings | null = null;
  private _settingsChangedId = 0;

  private _readOptions(): Partial<SearchProviderOptions> {
    return {
      instanceUrl: this._settings?.get_string('searxng-instance') ?? '',
      engine: this._settings?.get_string('panel-engine') ?? 'duckduckgo',
    };
  }

  enable(): void {
    const settings = this._settings = this.getSettings();
    // The page is rendered by a separate process (the Shell cannot host WebKit)
    // and shown inside the overview by the PageView; see panel/sds-renderer.js.
    const renderer = this._renderer = new RendererClient(
      GLib.build_filenamev([this.path, 'panel', 'sds-renderer.js']));
    this._provider = new SearchProvider({
      ...this._readOptions(),
      instanceUrl: settings.get_string('searxng-instance'),
      engine: settings.get_string('panel-engine'),
      renderer,
      createView: fetchLinks => new PageView({renderer, settings, fetchLinks}),
    });
    this._settingsChangedId = settings.connect(
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
    this._renderer?.destroy();
    this._renderer = null;
    this._settings = null;
  }
}
