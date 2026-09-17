/**
 * prefs.ts — the extension's preferences window.
 *
 * Every row binds straight to a GSettings key, so a change here reaches the open
 * overview immediately: the page view and the section placement listen for the
 * same keys.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ENGINES as ENGINE_CHOICES} from './engines.js';

interface Choice { value: string; label: string; }

const ENGINES: Choice[] = Object.entries(ENGINE_CHOICES).map(([value, engine]) => ({value, label: engine.label}));
const LINK_MODES: Choice[] = [
  {value: 'contained', label: 'In the overview'},
  {value: 'browser', label: 'In my browser'},
];
const VISIBILITY: Choice[] = [
  {value: 'always', label: 'Every search'},
  {value: 'no-other-results', label: 'Only when nothing else matched'},
];
const PLACEMENT: Choice[] = [
  {value: 'default', label: 'Where GNOME puts it'},
  {value: 'top-when-alone', label: 'First when nothing else matched'},
  {value: 'top', label: 'Always first'},
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

export default class SearchDoesSearchPreferences extends ExtensionPreferences {
  override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    // --- the page itself ---
    const display = new Adw.PreferencesGroup({
      title: 'Web search',
      description: 'Search from Activities. Results load after you pause typing.',
    });
    display.add(choiceRow(settings, 'engine', 'Engine',
      'Queries go only to the engine you choose. Some engines may ask you to continue in your browser.', ENGINES));
    display.add(choiceRow(settings, 'link-mode', 'Open links',
      'Middle-click, downloads and PDFs always use your browser.',
      LINK_MODES));
    page.add(display);

    // --- where it shows up ---
    const placement = new Adw.PreferencesGroup({
      title: 'In the search results',
      description: 'Keep apps and files easy to reach.',
    });
    placement.add(choiceRow(settings, 'section-visibility', 'Show web results',
      'Show alongside local results, or only when they are empty.', VISIBILITY));
    placement.add(choiceRow(settings, 'section-placement', 'Position',
      'Enter opens the result selected by GNOME.', PLACEMENT));
    page.add(placement);

    window.add(page);
    return Promise.resolve();
  }
}
