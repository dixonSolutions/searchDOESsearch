#!/usr/bin/gjs -m
/*
 * engine-check.js — does each engine answer the renderer with results?
 *
 * This is the one test that talks to the real engines, so it is not part of
 * `make check`: it needs the network, and what it measures is decided on
 * someone else's servers. It exists because that decision has already changed
 * once under this code — Google answered every search with /sorry for as long
 * as the renderer claimed to be Firefox, and with results the moment it stopped
 * (see GJS-PITFALLS.md) — and the only way to notice the next change is to ask.
 *
 * The real renderer is started on the session bus this runs on, with a fresh
 * profile and its own runtime dir, so it neither borrows the cookies of the
 * user's renderer nor overwrites the frames that renderer is showing. A fresh
 * profile is the hard case: no cookies, no history, a client the engine has
 * never seen.
 *
 * Run via `make check-engines`, which supplies a private bus and display.
 *   SDS_CHECK_ENGINES=google      only these engines (comma-separated)
 *   SDS_CHECK_FRAMES=<dir>        save each result's last frame there as PNG
 * Exits 0 when every search came back `ready`, 1 otherwise.
 *
 * Note: no top-level await — loop.run() must be reached from the module's
 * initial synchronous execution or GJS never drains the promise job queue.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

const BUS_NAME = 'io.github.searchdoessearch.Renderer';
const OBJECT_PATH = '/io/github/searchdoessearch/Renderer';
const RENDERER = GLib.build_filenamev([GLib.path_get_dirname(System.programPath), '..', 'panel', 'sds-renderer.js']);
// Ordinary searches, a few per engine. Spaced out, because a burst of test
// traffic trips a rate limiter and then reads as the very block being tested for.
const QUERIES = ['weather sydney', 'who wrote dune', 'rust borrow checker'];
const GAP_MS = 2000;
const STATE_TIMEOUT_MS = 20000;
// How long a settled state has to hold to count. Frames keep arriving meanwhile
// as the page fills in (Google streams its AI overview), so the saved frame is
// the last one by then.
const FRAME_WAIT_MS = 1500;

const engines = (GLib.getenv('SDS_CHECK_ENGINES') || 'duckduckgo,google').split(',').filter(Boolean);
const framesDir = GLib.getenv('SDS_CHECK_FRAMES') || '';

const scratch = GLib.dir_make_tmp('sds-engine-check-XXXXXX');
const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
for (const dir of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'])
  launcher.setenv(dir, GLib.build_filenamev([scratch, dir.toLowerCase()]), true);
GLib.mkdir_with_parents(GLib.build_filenamev([scratch, 'xdg_runtime_dir']), 0o700);
launcher.setenv('SDS_NO_LAUNCH', '1', true);

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const loop = GLib.MainLoop.new(null, false);
const failures = [];
let state = null;
let frame = null;

bus.signal_subscribe(null, BUS_NAME, null, OBJECT_PATH, null, Gio.DBusSignalFlags.NONE,
  (_c, _s, _p, _i, signal, params) => {
    if (signal === 'State') state = params.deepUnpack();
    else if (signal === 'Frame') frame = params.deepUnpack();
  });

const call = (method, signature = null, args = null) => bus.call_sync(BUS_NAME, OBJECT_PATH, BUS_NAME, method,
  signature ? new GLib.Variant(signature, args) : null, null, Gio.DBusCallFlags.NONE, 5000, null);

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
  resolve();
  return GLib.SOURCE_REMOVE;
}));

/** The first call also makes this process the renderer's owner, which is what the Shell does. */
async function waitForRenderer() {
  for (let i = 0; i < 100; i++) {
    try {
      call('Configure', '(iid)', [1000, 760, 1]);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error('the renderer never appeared on the bus');
}

/**
 * Resolves with the state `query` ends up in: settled, and still the same after
 * FRAME_WAIT_MS. The first settled state is not enough — an engine can answer
 * with a page that navigates itself on to a bot check, and a check that stopped
 * at the first `ready` would pass a renderer that is being turned away.
 */
async function settled(query) {
  const deadline = GLib.get_monotonic_time() / 1000 + STATE_TIMEOUT_MS;
  let seen = null;
  while (GLib.get_monotonic_time() / 1000 < deadline) {
    const now = state && state[2] === query && state[0] !== 'loading' ? state : null;
    if (now && now === seen) return now;
    seen = now;
    await sleep(now ? FRAME_WAIT_MS : 100);
  }
  return ['timeout', `nothing stable after ${STATE_TIMEOUT_MS / 1000}s`, query];
}

function saveFrame(name) {
  if (!framesDir || !frame) return;
  const [path, width, height, stride] = frame;
  const [, data] = GLib.file_get_contents(path);
  GLib.mkdir_with_parents(framesDir, 0o755);
  const out = GLib.build_filenamev([framesDir, `${name}.png`]);
  GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(data), GdkPixbuf.Colorspace.RGB, true, 8, width, height, stride)
    .savev(out, 'png', [], []);
  print(`       frame: ${out}`);
}

async function run() {
  await waitForRenderer();
  for (const engine of engines) {
    print(engine);
    for (const query of QUERIES) {
      state = frame = null;
      call('Search', '(ss)', [query, engine]);
      const [got, detail] = await settled(query);
      if (got === 'ready' && frame) {
        print(`  ok   "${query}"`);
      } else {
        const why = got === 'ready' ? 'ready, but no frame was exported' : `${got}: ${detail}`;
        failures.push(`${engine} "${query}" — ${why}`);
        print(`  FAIL "${query}" — ${why}`);
      }
      saveFrame(`${engine}-${query.replace(/\W+/g, '-')}`);
      await sleep(GAP_MS);
    }
  }
}

const renderer = launcher.spawnv(['gjs', '-m', RENDERER]);
run().catch(e => failures.push(String(e))).finally(() => {
  try { call('Quit'); } catch { renderer.force_exit(); }
  GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(scratch)}`);
  loop.quit();
});
loop.run();

if (failures.length) {
  print(`\nFAIL: ${failures.length} search(es) did not come back with results`);
  for (const f of failures) print(`  - ${f}`);
  System.exit(1);
}
print('\nPASS: every engine answered with results');
System.exit(0);
