#!/usr/bin/gjs -m
/*
 * fetch-check.js — smoke test for the SearXNG result pipeline.
 *
 * Exercises the built webSearch module against a live instance and prints what the
 * overview would show. Exits non-zero when the instance is unreachable, is not
 * serving JSON, or returns nothing — the three states a user would experience as
 * "the extension is broken".
 *
 * Run via `make check-fetch`, or directly:
 *   gjs -m scripts/fetch-check.js "some query" http://localhost:8888
 *
 * Note: no top-level await — loop.run() must be reached synchronously or GJS
 * never drains the promise job queue.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {fetchWebResults} from '../dist/search-does-search@searchdoessearch.github.io/webSearch.js';

const query = ARGV[0] ?? 'gnome shell extension';
const instance = ARGV[1] ?? GLib.getenv('SEARXNG_INSTANCE') ?? 'http://localhost:8888';

const loop = GLib.MainLoop.new(null, false);
let exitCode = 1;

GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
  fetchWebResults(query, instance, 3, new Gio.Cancellable()).then(
    outcome => {
      if (outcome.status !== 'ok') {
        print(`✗ ${outcome.status}: ${outcome.detail ?? ''}`);
      } else if (outcome.results.length === 0) {
        print(`✗ ${instance} answered but returned no results for "${query}"`);
      } else {
        print(`${instance} "${query}" → ${outcome.results.length} result(s)`);
        outcome.results.forEach(r => print(`  ${r.title}\n    ${r.url}\n    ${r.displayUrl}`));
        exitCode = 0;
      }
      loop.quit();
    },
    err => { print(`ERROR: ${err}`); loop.quit(); },
  );
  return GLib.SOURCE_REMOVE;
});

loop.run();
System.exit(exitCode);
