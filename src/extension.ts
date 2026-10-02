import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {PageView, linkModeOf} from './pageView.js';
import {RendererClient} from './rendererClient.js';
import {SearchProvider, SearchProviderOptions} from './searchProvider.js';
import {SearchWindow} from './searchWindow.js';
import {SectionPlacement} from './section.js';

/** The settings key that holds the shortcut; the window manager reads it itself. */
const SHORTCUT_KEY = 'search-window-shortcut';

export default class SearchDoesSearchExtension extends Extension {
  private _provider: SearchProvider | null = null;
  private _renderer: RendererClient | null = null;
  private _placement: SectionPlacement | null = null;
  private _window: SearchWindow | null = null;
  private _shortcutBound = false;
  private _settings: Gio.Settings | null = null;
  private _settingsChangedId = 0;
  private _overviewShowingId = 0;
  private _overviewHiddenId = 0;

  private _readOptions(): Partial<SearchProviderOptions> {
    return {
      engine: this._settings?.get_string('engine') ?? 'duckduckgo',
      active: this._settings?.get_string('section-visibility') !== 'never',
    };
  }

  /**
   * The two ways in are independent switches. The overview's is the provider
   * answering or not (see _readOptions); the window's is its shortcut being
   * bound or not. The window itself is built on first use and kept: it is a
   * handful of actors, and keeping it keeps its page warm between opens.
   */
  private _syncShortcut(): void {
    const want = this._settings?.get_boolean('search-window') ?? false;
    if (want === this._shortcutBound || !this._settings) return;
    if (want) {
      // NORMAL and OVERVIEW open it; POPUP is the mode the open window holds,
      // so the same shortcut closes it again.
      Main.wm.addKeybinding(SHORTCUT_KEY, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
        () => this._toggleWindow());
      this._shortcutBound = true;
    } else {
      Main.wm.removeKeybinding(SHORTCUT_KEY);
      this._shortcutBound = false;
      this._window?.close();
    }
  }

  private _toggleWindow(): void {
    if (!this._renderer || !this._settings) return;
    // POPUP is also a panel menu being open. The shortcut only closes this
    // window from there; it does not open one over someone else's popup.
    if (!this._window?.isOpen && (Main.actionMode as Shell.ActionMode) === Shell.ActionMode.POPUP) return;
    this._window ??= new SearchWindow({renderer: this._renderer, settings: this._settings});
    this._window.toggle();
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
      active: settings.get_string('section-visibility') !== 'never',
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
      if (key === 'search-window') this._syncShortcut();
    });
    this._syncShortcut();
    // Starting WebKit costs about 0.4s. Paying it while the overview animates
    // open means the first keystroke meets a warm renderer.
    this._overviewShowingId = Main.overview.connect('showing', () => {
      this._window?.close();
      if (this._settings?.get_string('section-visibility') === 'never') return;
      this._renderer?.prewarm();
      this._renderer?.setActive(true);
    });
    // A closed overview still had a live page exporting every repaint into it —
    // an animating ad kept a full-window readback running for an audience of
    // nobody. The page stays loaded; only the exporting stops.
    this._overviewHiddenId = Main.overview.connect('hidden', () => {
      // The shortcut can open the window while the overview is still animating away.
      if (!this._window?.isOpen) this._renderer?.setActive(false);
    });
    Main.overview.searchController.addProvider(provider);
  }

  disable(): void {
    if (this._shortcutBound) Main.wm.removeKeybinding(SHORTCUT_KEY);
    this._shortcutBound = false;
    this._window?.destroy();
    this._window = null;
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
