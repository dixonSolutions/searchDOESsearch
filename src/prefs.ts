/**
 * prefs.ts — the extension's preferences window.
 *
 * Two groups: the search backend (SearXNG, which feeds the sidebar's link list),
 * and the "Results page" settings for the page shown inside the overview. Every
 * row binds straight to a GSettings key, so a change here reaches the open
 * overview immediately — the page view listens for the same keys.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/prefs.js';

interface Choice { value: string; label: string; }

const ENGINES: Choice[] = [
  {value: 'duckduckgo', label: 'DuckDuckGo'},
  {value: 'google', label: 'Google'},
];
const POSITIONS: Choice[] = [
  {value: 'left', label: 'Left'},
  {value: 'right', label: 'Right'},
];

/** A combo row whose selection mirrors a string key with a fixed choice list. */
function choiceRow(settings: Gio.Settings, key: string, title: string, subtitle: string, choices: Choice[]): Adw.ComboRow {
  const row = new Adw.ComboRow({title, subtitle});
  row.set_model(Gtk.StringList.new(choices.map(c => c.label)));
  const sync = (): void => {
    const index = choices.findIndex(c => c.value === settings.get_string(key));
    if (index >= 0 && row.get_selected() !== index) row.set_selected(index);
  };
  sync();
  row.connect('notify::selected', () => {
    const choice = choices[row.get_selected()];
    if (choice && settings.get_string(key) !== choice.value) settings.set_string(key, choice.value);
  });
  settings.connect(`changed::${key}`, sync);
  return row;
}

function spinRow(settings: Gio.Settings, key: string, title: string, subtitle: string, lower: number, upper: number, step: number): Adw.SpinRow {
  const row = new Adw.SpinRow({
    title,
    subtitle,
    adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 4}),
  });
  settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
  return row;
}

function switchRow(settings: Gio.Settings, key: string, title: string, subtitle: string): Adw.SwitchRow {
  const row = new Adw.SwitchRow({title, subtitle});
  settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
  return row;
}

export default class SearchDoesSearchPreferences extends ExtensionPreferences {
  override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    // --- results page ---
    const display = new Adw.PreferencesGroup({
      title: 'Results page',
      description: 'The engine\'s results page is rendered and shown inside the overview as you type. ' +
        'Scroll, click and type in it as usual; every link opens in your browser.',
    });
    display.add(choiceRow(settings, 'panel-engine', 'Engine',
      'Google refuses many networks with a bot check; the page reports that rather than working around it', ENGINES));
    display.add(switchRow(settings, 'panel-sidebar-visible', 'Show sidebar',
      'A compact list of links beside the page. F9 or the sidebar button toggles it too'));
    display.add(choiceRow(settings, 'panel-sidebar-position', 'Sidebar position',
      'Which side of the page the list is docked to', POSITIONS));
    display.add(spinRow(settings, 'panel-sidebar-width', 'Sidebar width', 'Pixels', 180, 480, 8));
    display.add(spinRow(settings, 'panel-sidebar-limit', 'Sidebar links', 'How many results the sidebar lists', 3, 20, 1));
    page.add(display);

    // --- backend (sidebar data) ---
    const search = new Adw.PreferencesGroup({
      title: 'Sidebar links',
      description: 'The sidebar\'s links come from your own SearXNG instance; it must have "json" under search.formats.',
    });
    const instance = new Adw.EntryRow({title: 'SearXNG instance'});
    settings.bind('searxng-instance', instance, 'text', Gio.SettingsBindFlags.DEFAULT);
    search.add(instance);
    page.add(search);

    window.add(page);
    return Promise.resolve();
  }
}
