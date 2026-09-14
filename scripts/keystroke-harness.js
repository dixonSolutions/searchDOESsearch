#!/usr/bin/gjs -m
/*
 * keystroke-harness.js — drives the built SearchProvider the way GNOME Shell does.
 *
 * Shell cancels the previous GCancellable on every keystroke while the previous
 * getInitialResultSet() is still awaiting. That sequence once deadlocked the
 * compositor thread inside g_cancellable_disconnect(), so it is worth a
 * regression test. A regression shows up as cancel() never returning.
 *
 * Run via `make check-freeze` (it supplies the St/Meta typelib paths).
 * Exits 0 on success, 1 on failure, and hangs on a deadlock regression —
 * so always invoke it under an outer `timeout`.
 *
 * Note: no top-level await. loop.run() must be reached from the module's
 * initial synchronous execution, otherwise it blocks inside a microtask and
 * GJS never drains the promise job queue.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SearchProvider} from '../dist/search-does-search@searchdoessearch.github.io/searchProvider.js';

const QUERY = 'browser';
/** Faster than the provider's 400ms debounce, so every search is cancelled mid-wait. */
const KEYSTROKE_INTERVAL_MS = 120;
/** cancel() is a non-blocking call; anything above this means the thread stalled. */
const CANCEL_BUDGET_MS = 250;
const DRAIN_MS = 10000;

const loop = GLib.MainLoop.new(null, false);
const provider = new SearchProvider({engine: 'duckduckgo'});

let pending = null;
let typed = 0;
let settled = 0;
let worstCancelMs = 0;
const failures = [];

function keystroke() {
  if (pending) {
    const started = GLib.get_monotonic_time();
    pending.cancel();
    const blockedMs = (GLib.get_monotonic_time() - started) / 1000;
    worstCancelMs = Math.max(worstCancelMs, blockedMs);
    if (blockedMs > CANCEL_BUDGET_MS)
      failures.push(`cancel() blocked the calling thread for ${blockedMs.toFixed(0)}ms`);
  }

  typed++;
  const terms = [QUERY.slice(0, typed)];
  const cancellable = new Gio.Cancellable();
  pending = cancellable;

  provider.getInitialResultSet(terms, cancellable).then(
    ids => { settled++; print(`  "${terms[0]}" resolved: ${ids.length} result(s)`); },
    err => { settled++; print(`  "${terms[0]}" rejected: ${err.message}`); },
  );

  if (typed < QUERY.length)
    return GLib.SOURCE_CONTINUE;

  GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAIN_MS, () => {
    if (settled < typed)
      failures.push(`${typed - settled} of ${typed} searches never settled`);

    print(`\nkeystrokes=${typed} settled=${settled} worst cancel()=${worstCancelMs.toFixed(2)}ms`);
    if (failures.length === 0)
      print('PASS: cancel() never blocked, every search settled');
    else
      failures.forEach(f => print(`FAIL: ${f}`));

    loop.quit();
    return GLib.SOURCE_REMOVE;
  });
  return GLib.SOURCE_REMOVE;
}

print(`harness: typing "${QUERY}" one char every ${KEYSTROKE_INTERVAL_MS}ms, cancelling each in-flight search`);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEYSTROKE_INTERVAL_MS, keystroke);
loop.run();

System.exit(failures.length === 0 ? 0 : 1);
