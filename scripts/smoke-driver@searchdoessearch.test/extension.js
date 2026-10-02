/**
 * Drives Search Does Search the way a person would — open the overview, type,
 * read the page, open the search window and type there, turn the extension off
 * and on again — inside the headless
 * Shell that scripts/shell-smoke.sh starts. Every line it prints starts with
 * SDS-SMOKE; the script fails on any FAIL line, or on no DONE line at all.
 *
 * It asserts what the Shell can see: the extension's state, and whether the
 * renderer holds its bus name. It does not assert on the results, because the
 * engine may well show a CI runner's address a bot check instead; the
 * screenshots are kept so a person can look.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const SDS = 'search-does-search@searchdoessearch.github.io';
const RENDERER = 'io.github.searchdoessearch.Renderer';
const OUT = GLib.getenv('SDS_SMOKE_OUT') ?? '/tmp';

// Disabling SDS makes the Shell disable and re-enable every extension enabled
// after it, this one included; a second enable() must not start a second run.
let started = false;

const say = message => console.log(`SDS-SMOKE ${message}`);
const sleep = seconds => new Promise(resolve =>
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
  }));

function stateName() {
  const state = Main.extensionManager.lookup(SDS)?.state;
  return Object.keys(ExtensionState).find(k => ExtensionState[k] === state) ?? String(state);
}

function rendererRunning() {
  const [owned] = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [RENDERER]),
    new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, null).deepUnpack();
  return owned;
}

async function until(what, predicate, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    if (predicate())
      return;
    await sleep(0.25);
  }
  throw new Error(`timed out after ${seconds}s waiting for ${what}`);
}

function screenshot(name) {
  return new Promise((resolve, reject) => {
    const path = GLib.build_filenamev([OUT, name]);
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    new Shell.Screenshot().screenshot(false, stream, (shooter, res) => {
      try {
        shooter.screenshot_finish(res);
        stream.close(null);
        say(`screenshot ${path}`);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function search(terms, shot) {
  Main.overview.show();
  await sleep(1);
  Main.overview.searchEntry.set_text(terms);
  await until('the renderer to take its bus name', rendererRunning, 20);
  // Long enough for a page to load; the screenshot is for people, not asserts.
  await sleep(10);
  await screenshot(shot);
  Main.overview.searchEntry.set_text('');
  Main.overview.hide();
  await sleep(1);
}

/** The extension object behind SDS; the window is reached through its own toggle. */
const sds = () => Main.extensionManager.lookup(SDS)?.stateObj;

async function searchWindow(terms, shot) {
  // The shortcut's handler, without the keyboard: the headless Shell has no
  // seat to press Super+Shift+S on. Its version-specific paths (the grab
  // probe, cursors, the blur) are what this exercises.
  sds()._toggleWindow();
  await until('the search window to open', () => sds()._window?.isOpen, 5);
  sds()._window._entry.set_text(terms);
  await sleep(10);
  await screenshot(shot);
  sds()._toggleWindow();
  await until('the search window to close', () => !sds()._window.isOpen, 5);
  await sleep(1);
}

async function drive() {
  say(`GNOME Shell ${Config.PACKAGE_VERSION}`);
  await until('Search Does Search to be ACTIVE', () => stateName() === 'ACTIVE', 10);
  say('enabled: ACTIVE');
  // The default only shows the page when nothing else matched, and an app or
  // a settings panel may match; the screenshots are for seeing the page.
  sds().getSettings().set_string('section-visibility', 'always');

  await search('gnome shell', 'search.png');
  say('search: renderer started');

  await searchWindow('gnome extensions', 'search-window.png');
  say('search window: opened, searched, closed');

  Main.extensionManager.disableExtension(SDS);
  await until('Search Does Search to be INACTIVE', () => stateName() === 'INACTIVE', 10);
  // A renderer that outlives disable() holds the name and a web process for
  // the next quarter of an hour.
  await until('the renderer to exit after disable', () => !rendererRunning(), 10);
  say('disabled: INACTIVE, renderer exited');

  Main.extensionManager.enableExtension(SDS);
  await until('Search Does Search to be ACTIVE again', () => stateName() === 'ACTIVE', 10);
  await search('wikipedia gnome', 'search-after-reenable.png');
  say('re-enabled: search works again');
  say('DONE');
}

export default class SmokeDriver extends Extension {
  enable() {
    if (started)
      return;
    started = true;
    drive().catch(e => say(`FAIL ${e.message}\n${e.stack}`));
  }

  disable() {}
}
