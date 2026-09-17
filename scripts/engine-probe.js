#!/usr/bin/env -S gjs -m
// One request, a fresh WebKit profile, bounded observation. Never opens a personal browser profile.
// Usage: xvfb-run -a gjs -m scripts/engine-probe.js 'https://duckduckgo.com/?q=gnome%20shell%20extensions&ia=web'
import Gtk from 'gi://Gtk?version=3.0';
import WebKit2 from 'gi://WebKit2?version=4.1';
import GLib from 'gi://GLib';
import System from 'system';
const [url] = System.programArgs;
if (!url || !/^https:\/\//.test(url)) { printerr('Supply one HTTPS search URL'); System.exit(2); }
Gtk.init(null);
const win = new Gtk.OffscreenWindow();
win.set_default_size(1000, 700);
const view = new WebKit2.WebView({web_context: WebKit2.WebContext.new_ephemeral()});
win.add(view);
win.show_all();
const loop = new GLib.MainLoop(null, false);
const started = GLib.get_monotonic_time();
let finished = false;
let observed = false;
const errors = [];
function finish(result) {
  if (finished) return;
  finished = true;
  print(JSON.stringify({requested: url, elapsedMs: Math.round((GLib.get_monotonic_time() - started) / 1000), errors, ...result}));
  loop.quit();
}
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => { finish({status: 'timeout', uri: view.get_uri()}); return GLib.SOURCE_REMOVE; });
view.connect('load-failed', (_v, _event, uri, error) => { errors.push({uri, error: error.message}); return false; });
view.connect('load-changed', (_v, event) => {
  if (event !== WebKit2.LoadEvent.FINISHED || observed) return;
  observed = true;
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    view.run_javascript('JSON.stringify({uri:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,500),links:document.querySelectorAll("a[href]").length,results:document.querySelectorAll(".result,[data-testid*=result],#b_results .b_algo").length})', null, (web, result) => {
      try { finish({status: 'loaded', ...JSON.parse(web.run_javascript_finish(result).get_js_value().to_string())}); }
      catch (error) { finish({status: 'inspection-failed', error: error.message}); }
    });
    return GLib.SOURCE_REMOVE;
  });
});
view.load_uri(url);
loop.run();
win.destroy();
