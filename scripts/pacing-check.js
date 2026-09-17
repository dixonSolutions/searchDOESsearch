#!/usr/bin/gjs -m
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {SearchProvider} from '../dist/search-does-search@searchdoessearch.github.io/searchProvider.js';
const loop = GLib.MainLoop.new(null, false);
const loads = [];
const text = 'gnome shell extensions';
let lastTyped = 0;
let previous = new Gio.Cancellable();
const provider = new SearchProvider({engine: 'duckduckgo', renderer: {
  search(query) { loads.push({query, afterTypingMs: (GLib.get_monotonic_time() - lastTyped) / 1000}); },
}});
let count = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
  previous.cancel();
  previous = new Gio.Cancellable();
  lastTyped = GLib.get_monotonic_time();
  provider.getInitialResultSet([text.slice(0, ++count)], previous);
  if (count < text.length) return GLib.SOURCE_CONTINUE;
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
  return GLib.SOURCE_REMOVE;
});
loop.run();
provider.destroy();
print(JSON.stringify({characters: text.length, keystrokeIntervalMs: 120, loads}));
if (loads.length !== 1 || loads[0].query !== text || loads[0].afterTypingMs < 240) {
  printerr('FAIL: typing a word sequence should generate one settled request');
  System.exit(1);
}
print('PASS: realistic typing sends one request after the pause');
