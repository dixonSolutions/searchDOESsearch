#!/usr/bin/gjs -m
/*
 * provider-check.js — the provider's decisions about when to load a page.
 *
 * Three rules, each of which has been wrong at some point:
 *   1. terms that settle load the page once, not once per keystroke;
 *   2. the same terms settling again do not reload (the overview was reopened
 *      on a page that is already showing);
 *   3. unless the user has followed links from it — then the results page is no
 *      longer what is on screen, and settling has to bring it back. Without
 *      this, retyping your own query while three pages deep strands you there.
 *
 * Driven with a fake renderer and a fake view, so nothing here needs a Shell.
 * Run via `make check-provider`. Exits 0 on success, 1 on failure.
 *
 * Note: no top-level await — loop.run() must be reached from the module's
 * initial synchronous execution or GJS never drains the promise job queue.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SearchProvider} from '../dist/search-does-search@searchdoessearch.github.io/searchProvider.js';

/** Beyond the load interval, with scheduling headroom on a busy desktop. */
const SETTLE_MS = 1000;

const loop = GLib.MainLoop.new(null, false);
const failures = [];
const searches = [];
const orderedEvents = [];
let cancelled;

const renderer = {search: (query, engine) => { searches.push(`${query}/${engine}`); orderedEvents.push('search'); }};
/** The page view the Shell would build; `navigated` is what rule 3 turns on. */
const view = {
  navigated: false,
  setQuery() {},
  querySettled() { orderedEvents.push('settled'); },
  connect: () => 1,
};

const provider = new SearchProvider({engine: 'duckduckgo', renderer, createView: () => view});
// createResultObject is how the provider adopts the view, exactly as the Shell does.
provider.createResultObject({id: 'sds:page'});

function type(text) {
  provider.getInitialResultSet(text.split(' '), new Gio.Cancellable());
}

function check(what, condition) {
  if (condition) print(`  ok   ${what}`);
  else {
    failures.push(what);
    print(`  FAIL ${what}`);
  }
}

/** Each step runs after the previous one has had time to settle. */
const steps = [
  () => {
    print('typing "weather today" one character at a time');
    const query = 'weather today';
    for (let i = 1; i <= query.length; i++) type(query.slice(0, i));
  },
  () => {
    check('one load for a burst of keystrokes', searches.length === 1);
    check('loaded the settled terms', searches[0] === 'weather today/duckduckgo');
    print('the same terms settle again (the overview was reopened)');
    type('weather today');
  },
  () => {
    check('no reload for terms already showing', searches.length === 1);
    print('the user has followed links; the same terms settle again');
    view.navigated = true;
    type('weather today');
  },
  () => {
    check('reloads when the view is off the results page', searches.length === 2);
    view.navigated = false;
    print('two different queries in quick succession');
    type('one');
    type('two');
  },
  () => {
    check('only the last of two quick queries loads', searches.length === 3);
    check('and it is the last one', searches[2] === 'two/duckduckgo');
  },
  () => {
    check('view is prepared before renderer can answer synchronously', orderedEvents.slice(-2).join(',') === 'settled,search');
    cancelled = new Gio.Cancellable();
    provider.getInitialResultSet(['cancelled'], cancelled);
    cancelled.cancel();
  },
  () => {
    check('cancelled pending search does not reach the renderer', searches.length === 3);
    type('cleared');
    type('');
  },
  () => {
    check('clearing terms cancels the pending load', searches.length === 3);
    type('engine change');
  },
  () => {
    provider.updateOptions({engine: 'bing'});
  },
  () => {
    check('engine change reloads the current query once', searches.length === 5);
    check('engine change uses the new engine', searches[4] === 'engine change/bing');
    type('hidden');
    provider.suspend();
    provider.updateOptions({engine: 'brave'});
  },
  () => {
    check('hidden overview cancels pending and settings-triggered loads', searches.length === 5);
    type('destroyed');
    provider.destroy();
  },
  () => {
    check('destroy cancels the pending search', searches.length === 5);
  },
];

let step = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
  steps[step++]();
  if (step < steps.length) return GLib.SOURCE_CONTINUE;
  loop.quit();
  return GLib.SOURCE_REMOVE;
});

loop.run();
provider.destroy();

if (failures.length) {
  print(`\nFAIL: ${failures.length} of the provider's rules are broken`);
  System.exit(1);
}
print('\nPASS: the page is loaded exactly when it should be');
System.exit(0);
