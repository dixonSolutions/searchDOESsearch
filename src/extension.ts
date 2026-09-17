import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {PageView, linkModeOf} from './pageView.js';
import {RendererClient} from './rendererClient.js';
import {SearchProvider, SearchProviderOptions} from './searchProvider.js';
import {SectionPlacement} from './section.js';

export default class SearchDoesSearchExtension extends Extension {
  private _provider: SearchProvider | null = null;
  private _renderer: RendererClient | null = null;
  private _placement: SectionPlacement | null = null;
  private _settings: Gio.Settings | null = null;
  private _settingsChangedId = 0;
  private _overviewShowingId = 0;
  private _overviewHiddenId = 0;
  private _entry: St.Entry | null = null;
  private _entryChangedId = 0;

  private _readOptions(): Partial<SearchProviderOptions> {
    return {engine: this._settings?.get_string('engine') ?? 'duckduckgo'};
  }

  enable(): void {
    const settings = this._settings = this.getSettings();
    // The page is rendered by a separate process (the Shell cannot host WebKit)
    // and shown inside the overview by the PageView; see panel/sds-renderer.js.
    const renderer = this._renderer = new RendererClient(
      GLib.build_filenamev([this.path, 'panel', 'sds-renderer.js']));
    renderer.setLinkMode(linkModeOf(settings));

    const provider = this._provider = new SearchProvider({
      engine: settings.get_string('engine'),
      renderer,
      createView: () => {
        const view = new PageView({renderer, settings});
        // The Shell has built the section by the time it asks for the actor,
        // which is the first moment there is anything to place.
        this._placement?.attach();
        return view;
      },
    });
    this._placement = new SectionPlacement(settings, provider as unknown as {display?: never});

    this._settingsChangedId = settings.connect('changed', (_s: Gio.Settings, key: string) => {
      this._provider?.updateOptions(this._readOptions());
      if (key === 'link-mode') this._renderer?.setLinkMode(linkModeOf(settings));
    });
    // Starting WebKit costs about 0.4s. Paying it while the overview animates
    // open means the first keystroke meets a warm renderer.
    this._overviewShowingId = Main.overview.connect('showing', () => {
      this._renderer?.prewarm();
      this._renderer?.setActive(true);
    });
    // A closed overview still had a live page exporting every repaint into it —
    // an animating ad kept a full-window readback running for an audience of
    // nobody. The page stays loaded; only the exporting stops.
    this._overviewHiddenId = Main.overview.connect('hidden', () => {
      this._provider?.suspend();
      this._renderer?.setActive(false);
    });
    Main.overview.searchController.addProvider(provider);
    this._entry = (Main.overview as unknown as {searchEntry?: St.Entry}).searchEntry ?? null;
    if (this._entry) {
      this._entryChangedId = this._entry.clutter_text.connect('text-changed', () => {
        const query = this._entry?.get_text().trim().split(/\s+/).join(' ') ?? '';
        this._provider?.previewQuery(query);
      });
    }
  }

  disable(): void {
    if (this._entry && this._entryChangedId) this._entry.clutter_text.disconnect(this._entryChangedId);
    this._entryChangedId = 0;
    this._entry = null;
    if (this._overviewShowingId) {
      Main.overview.disconnect(this._overviewShowingId);
      this._overviewShowingId = 0;
    }
    if (this._overviewHiddenId) {
      Main.overview.disconnect(this._overviewHiddenId);
      this._overviewHiddenId = 0;
    }
    if (this._settings && this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = 0;
    }
    this._placement?.destroy();
    this._placement = null;
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
