/**
 * extension.ts
 *
 * Entry point for the Search Does Search GNOME Shell extension.
 * Registers and unregisters the search provider with the GNOME
 * Shell search controller on enable/disable.
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';

import { SearchProvider } from './searchProvider.js';
import { SearchEngine } from './browserLauncher.js';

export default class SearchDoesSearchExtension extends Extension {
  private _provider: SearchProvider | null = null;
  private _settings: Gio.Settings | null = null;
  private _engineChangedId: number = 0;

  enable(): void {
    this._settings = this.getSettings();

    const engine = this._settings.get_string('search-engine') as SearchEngine;
    this._provider = new SearchProvider(engine);

    // Keep the provider in sync when the user changes the engine in preferences.
    this._engineChangedId = this._settings.connect(
      'changed::search-engine',
      (settings: Gio.Settings) => {
        const updated = settings.get_string('search-engine') as SearchEngine;
        this._provider?.setEngine(updated);
      }
    );

    Main.overview.searchController.addProvider(this._provider);

    log('[SearchDoesSearch] Extension enabled');
  }

  disable(): void {
    if (this._settings !== null && this._engineChangedId !== 0) {
      this._settings.disconnect(this._engineChangedId);
      this._engineChangedId = 0;
    }

    if (this._provider !== null) {
      Main.overview.searchController.removeProvider(this._provider);
      this._provider = null;
    }

    this._settings = null;

    log('[SearchDoesSearch] Extension disabled');
  }
}
