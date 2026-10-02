/**
 * prefs.ts — the extension's preferences window.
 *
 * Every row binds straight to a GSettings key, so a change here reaches the open
 * overview immediately: the page view and the section placement listen for the
 * same keys.
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

interface Choice { value: string; label: string; }

const ENGINES: Choice[] = [
  {value: 'duckduckgo', label: 'DuckDuckGo'},
  {value: 'google', label: 'Google'},
];
const LINK_MODES: Choice[] = [
  {value: 'contained', label: 'In place'},
  {value: 'browser', label: 'In my browser'},
];
const VISIBILITY: Choice[] = [
  {value: 'always', label: 'Every search'},
  {value: 'no-other-results', label: 'Only when nothing else matched'},
  {value: 'never', label: 'Never'},
];
const SHORTCUT_KEY = 'search-window-shortcut';
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

/**
 * The shortcut row: shows the accelerator, and records a new one when clicked.
 * Escape cancels, Backspace clears (the window then has no shortcut), and the
 * reset button brings back the default.
 */
function shortcutRow(settings: Gio.Settings): Adw.ActionRow {
  const row = new Adw.ActionRow({
    title: 'Shortcut',
    subtitle: 'Works from anywhere, including the overview; press it again to close the window',
    activatable: true,
  });
  const label = new Gtk.ShortcutLabel({disabled_text: 'None', valign: Gtk.Align.CENTER});
  const reset = new Gtk.Button({
    icon_name: 'edit-undo-symbolic',
    tooltip_text: 'Back to Super+Shift+S',
    valign: Gtk.Align.CENTER,
    css_classes: ['flat'],
  });
  reset.connect('clicked', () => settings.reset(SHORTCUT_KEY));
  row.add_suffix(label);
  row.add_suffix(reset);
  const sync = (): void => {
    label.accelerator = settings.get_strv(SHORTCUT_KEY)[0] ?? '';
    reset.sensitive = settings.get_user_value(SHORTCUT_KEY) !== null;
  };
  sync();
  settings.connect(`changed::${SHORTCUT_KEY}`, sync);
  row.connect('activated', () => recordShortcut(row, settings));
  return row;
}

function recordShortcut(parent: Gtk.Widget, settings: Gio.Settings): void {
  const status = new Adw.StatusPage({
    icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
    title: 'Press the new shortcut',
    description: 'Esc to cancel, Backspace to remove the shortcut',
  });
  const dialog = new Adw.Dialog({title: 'Search window shortcut', content_width: 420, child: status});
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number, keycode: number, state: Gdk.ModifierType) => {
    const mods = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
    if (mods === 0 && keyval === Gdk.KEY_Escape) {
      dialog.close();
      return Gdk.EVENT_STOP;
    }
    if (mods === 0 && keyval === Gdk.KEY_BackSpace) {
      settings.set_strv(SHORTCUT_KEY, []);
      dialog.close();
      return Gdk.EVENT_STOP;
    }
    // A lone modifier is the start of a chord, not the chord.
    if (isModifier(keyval)) return Gdk.EVENT_STOP;
    // Without a modifier the shortcut would eat that key everywhere, in every
    // text field. Function keys and the like are fair game on their own.
    const bare = mods === 0 && Gdk.keyval_to_unicode(keyval) !== 0;
    if (bare || !Gtk.accelerator_valid(keyval, mods)) {
      status.description = 'Use it with Super, Ctrl or Alt — a bare key would be taken from every app';
      return Gdk.EVENT_STOP;
    }
    settings.set_strv(SHORTCUT_KEY, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods)]);
    dialog.close();
    return Gdk.EVENT_STOP;
  });
  dialog.add_controller(keys);
  dialog.present(parent);
}

function isModifier(keyval: number): boolean {
  return [
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
  ].includes(keyval);
}

export default class SearchDoesSearchPreferences extends ExtensionPreferences {
  override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    // --- the ways in ---
    // Two independent switches: either, both or neither.
    const ways = new Adw.PreferencesGroup({
      title: 'When it appears',
      description: 'A search window you open with a shortcut, results in the overview\'s search, or both.',
    });
    const windowRow = new Adw.SwitchRow({
      title: 'Search window',
      subtitle: 'A search box over whatever you are doing. Esc or a click outside closes it',
    });
    settings.bind('search-window', windowRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    ways.add(windowRow);
    const shortcut = shortcutRow(settings);
    windowRow.bind_property('active', shortcut, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
    ways.add(shortcut);
    ways.add(choiceRow(settings, 'section-visibility', 'In the overview\'s search',
      'When the results page shows up among the overview\'s search results', VISIBILITY));
    page.add(ways);

    // --- the page itself ---
    const display = new Adw.PreferencesGroup({
      title: 'Results page',
      description: 'The engine\'s results page is rendered as you type, in the search window or the overview. ' +
        'Scroll, click and type in it as usual.',
    });
    display.add(choiceRow(settings, 'engine', 'Engine',
      'Google refuses many networks with a bot check; the page reports that rather than working around it', ENGINES));
    display.add(choiceRow(settings, 'link-mode', 'Open links',
      'In place, a back button counts how many pages deep you are; middle-click still uses your browser. ' +
      'Downloads and PDFs always go to your browser',
      LINK_MODES));
    page.add(display);

    // --- where it sits in the overview ---
    const placement = new Adw.PreferencesGroup({
      title: 'In the overview',
      description: 'Your browser\'s own "search the web" entry answers every query, so it does not count ' +
        'as something else having matched.',
    });
    const placementRow = choiceRow(settings, 'section-placement', 'Put them first',
      'Moves the section, not the keyboard selection: Enter still goes to the section GNOME selected', PLACEMENT);
    placement.add(placementRow);
    const syncPlacement = (): void => {
      placement.sensitive = settings.get_string('section-visibility') !== 'never';
    };
    syncPlacement();
    settings.connect('changed::section-visibility', syncPlacement);
    page.add(placement);

    window.add(page);
    return Promise.resolve();
  }
}
