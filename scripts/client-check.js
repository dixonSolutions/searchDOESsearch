#!/usr/bin/gjs -m
// Verify that an earlier query/engine cannot feed frames or navigation to a new search.
import GLib from 'gi://GLib';
import System from 'system';
import {RendererClient} from '../dist/search-does-search@searchdoessearch.github.io/rendererClient.js';
const client = new RendererClient('/nonexistent-test-renderer');
const events = [];
client.addListener({
  onFrame: frame => events.push(['frame', frame]),
  onState: (...state) => events.push(['state', state]),
  onNav: nav => events.push(['nav', nav]),
  onLaunched() {}, onRefused() {},
});
client._lastSearch = ['new query', 'bing'];
let failures = 0;
function check(name, condition) {
  print(`${condition ? 'ok' : 'FAIL'} ${name}`);
  if (!condition) failures++;
}
function send(query, engine, generation) {
  client._onSignal('Frame', new GLib.Variant('(suuuussu)', ['/tmp/unused', 20, 20, 80, 1, query, engine, generation]));
  client._onSignal('State', new GLib.Variant('(ssssu)', ['ready', '', query, engine, generation]));
  client._onSignal('Nav', new GLib.Variant('(ussssu)', [0, 'title', 'https://example.com', query, engine, generation]));
}
send('old query', 'bing', 1);
check('old query signals are discarded', events.length === 0);
send('new query', 'google', 2);
check('previous engine signals are discarded', events.length === 0);
send('new query', 'bing', 3);
check('current search forwards all three signals', events.length === 3);
check('frame carries generation identity', events[0]?.[1].generation === 3);
check('navigation carries query identity', events[2]?.[1].query === 'new query');
client.destroy();
System.exit(failures ? 1 : 0);
