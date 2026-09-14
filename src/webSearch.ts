import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// GNOME Shell happens to promisify this for its own use, but an extension should not
// depend on Shell's internal list. _promisify is idempotent, so claiming it here is safe
// and makes the module usable outside the Shell process (see scripts/fetch-check.js).
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export interface WebResult { title: string; url: string; displayUrl: string; description: string; }

/**
 * Why the caller got no results, so the UI can say something actionable instead of
 * silently showing nothing. Every non-`ok` case is a setup problem the user can fix.
 */
export type SearchOutcome =
  | {status: 'ok'; results: WebResult[]}
  | {status: 'cancelled'}
  | {status: 'badInstance'; detail: string}
  | {status: 'unreachable'; detail: string}
  | {status: 'notJson'; detail: string}
  | {status: 'enginesUnavailable'; detail: string; engines: string[]};

/**
 * Must exceed SearXNG's own per-engine budget (6s) plus its overhead, or curl aborts
 * a search that was about to succeed. DDG over a VPN measures 0.9-3.2s.
 */
const CURL_MAX_TIME_SECS = '15';
/** Wall-clock ceiling per child, in case curl itself wedges. */
const PROCESS_TIMEOUT_MS = 20000;
const MAX_JSON_BYTES = 2_000_000;
const MAX_REDIRECTS = '3';
export const MAX_RESULT_LIMIT = 20;

function decodeHtml(value: string): string {
  const named: Record<string, string> = {amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'};
  return value.replace(/<[^>]+>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_all, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  }).replace(/\s+/g, ' ').trim();
}

/**
 * Reduce a configured instance address to a bare `scheme://host[:port]` origin.
 *
 * Restricting the scheme is a security boundary, not tidiness: this value comes from
 * GSettings and is handed to curl, so allowing arbitrary schemes would let a bad
 * setting reach `file://` or `scp://`. Any path, query, or fragment is discarded so
 * the caller fully controls the request path.
 */
export function normalizeInstanceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let uri: GLib.Uri;
  try {
    uri = GLib.Uri.parse(trimmed, GLib.UriFlags.PARSE_RELAXED);
  } catch {
    return null;
  }

  const scheme = uri.get_scheme();
  const host = uri.get_host();
  if (!host || (scheme !== 'http' && scheme !== 'https')) return null;

  const port = uri.get_port();
  return port > 0 ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
}

/**
 * Resolve a result href into an absolute http(s) URL.
 *
 * GJS has no WHATWG `URL`, so GLib.Uri does the parsing. The scheme check matters
 * because these URLs originate from remote search engines and end up at
 * `Gio.AppInfo.launch_default_for_uri()`.
 */
function normalizeResultUrl(raw: string): {url: string; displayUrl: string} | null {
  let uri: GLib.Uri;
  try {
    uri = GLib.Uri.parse(raw.trim(), GLib.UriFlags.PARSE_RELAXED);
  } catch {
    return null;
  }

  const scheme = uri.get_scheme();
  const host = uri.get_host();
  if (!host || (scheme !== 'http' && scheme !== 'https')) return null;

  const path = uri.get_path();
  return {
    url: uri.to_string(),
    displayUrl: path && path !== '/' ? `${host}${path}` : host,
  };
}

/**
 * Spawn `argv` and return its stdout.
 *
 * The cancellable is handed to `communicate_utf8_async` rather than subscribed to
 * with `connect()`: `g_cancellable_disconnect()` blocks until an in-flight
 * cancellation completes, so releasing a handler on the same thread that emits
 * ::cancelled deadlocks GNOME Shell. Cancellation instead surfaces as a rejection,
 * and the catch below reaps the child.
 */
async function runProcess(argv: string[], cancellable: Gio.Cancellable): Promise<string> {
  const process = Gio.Subprocess.new(
    argv,
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
  );

  let watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROCESS_TIMEOUT_MS, () => {
    watchdogId = 0;
    try { process.force_exit(); } catch { /* already exited */ }
    return GLib.SOURCE_REMOVE;
  });

  try {
    // GJS drops the gboolean return of a throwing function, so this resolves to
    // [stdout, stderr] — not [ok, stdout, stderr].
    const [stdout] = await process.communicate_utf8_async(null, cancellable);
    if (!process.get_if_exited() || process.get_exit_status() !== 0)
      throw new Error(`curl exited with status ${process.get_exit_status()}`);
    return stdout ?? '';
  } catch (error) {
    try { process.force_exit(); } catch { /* already exited */ }
    throw error;
  } finally {
    if (watchdogId) GLib.source_remove(watchdogId);
  }
}

interface RawSearxngResult { title?: unknown; url?: unknown; content?: unknown; }

interface EngineFailure { name: string; reason: string; }

interface ParsedSearxngBody { results: WebResult[]; unresponsiveEngines: EngineFailure[]; }

/**
 * SearXNG reports per-engine failures in `unresponsive_engines`, as `[name, reason]`
 * pairs alongside a normal 200. An instance whose every upstream timed out therefore
 * looks identical to a query that genuinely matched nothing unless this is read.
 */
function parseUnresponsiveEngines(parsed: unknown): EngineFailure[] {
  const raw = (parsed as {unresponsive_engines?: unknown})?.unresponsive_engines;
  if (!Array.isArray(raw)) return [];
  const failures: EngineFailure[] = [];
  for (const entry of raw) {
    const name = Array.isArray(entry) ? entry[0] : entry;
    const reason = Array.isArray(entry) ? entry[1] : '';
    if (typeof name === 'string' && name.trim())
      failures.push({name: name.trim(), reason: typeof reason === 'string' ? reason : ''});
  }
  return failures;
}

/**
 * Separate "this instance cannot reach the internet" from "these engines are banned here".
 *
 * A dead uplink (the container's DNS pointing at an unreachable server, say) fails every
 * engine with `timeout`. A working instance behind a flagged IP instead carries permanent
 * per-engine rejections — `Suspended: access denied`, `Suspended: CAPTCHA`,
 * `too many requests` — while the remaining engines answer normally. Only the first case
 * is worth a row: the second is the instance's steady state, and reporting it on every
 * query that happens to match nothing is pure noise.
 */
function isConnectivityFailure(failures: EngineFailure[]): boolean {
  return failures.length > 0 && failures.every(f => /timeout/i.test(f.reason));
}

function parseSearxngJson(jsonText: string, limit: number): ParsedSearxngBody {
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return {results: [], unresponsiveEngines: []}; }

  const unresponsiveEngines = parseUnresponsiveEngines(parsed);
  const raw = (parsed as {results?: unknown})?.results;
  if (!Array.isArray(raw)) return {results: [], unresponsiveEngines};

  const results: WebResult[] = [];
  const seen = new Set<string>();
  for (const item of raw as RawSearxngResult[]) {
    if (results.length >= limit) break;
    const title = decodeHtml(String(item.title ?? ''));
    const link = typeof item.url === 'string' ? normalizeResultUrl(item.url) : null;
    if (!title || !link || seen.has(link.url)) continue;
    seen.add(link.url);
    results.push({
      title,
      url: link.url,
      displayUrl: link.displayUrl,
      description: decodeHtml(String(item.content ?? '')),
    });
  }
  return {results, unresponsiveEngines};
}

/** A 403 HTML body is SearXNG's answer when `json` is absent from `search.formats`. */
function isJsonPayload(body: string): boolean {
  return body.trimStart().startsWith('{');
}

/**
 * Query a SearXNG instance's JSON API.
 *
 * SearXNG is the backend rather than direct scraping because engines increasingly gate
 * their result pages against non-browser clients — Google serves a JS bootstrap to any
 * scripted client and flags `/search` on the first request even from a real browser
 * engine with a warm session. SearXNG owns that problem, spreads it across many
 * upstreams, and degrades gracefully when one of them refuses. See docs/GJS-PITFALLS.md.
 */
export async function fetchWebResults(
  query: string,
  instanceUrl: string,
  limit: number,
  cancellable: Gio.Cancellable,
): Promise<SearchOutcome> {
  const curl = GLib.find_program_in_path('curl');
  if (!curl) return {status: 'badInstance', detail: 'curl is not installed'};

  const origin = normalizeInstanceUrl(instanceUrl);
  if (!origin)
    return {status: 'badInstance', detail: `not a valid http(s) address: "${instanceUrl}"`};

  if (cancellable.is_cancelled()) return {status: 'cancelled'};

  const cappedLimit = Math.max(1, Math.min(limit, MAX_RESULT_LIMIT));
  const endpoint = `${origin}/search?q=${encodeURIComponent(query)}&format=json`;

  let body: string;
  try {
    body = await runProcess(
      [
        curl,
        '--silent',
        '--show-error',
        '--location',
        '--max-redirs', MAX_REDIRECTS,
        '--compressed',
        '--max-time', CURL_MAX_TIME_SECS,
        '--max-filesize', String(MAX_JSON_BYTES),
        '--header', 'Accept: application/json',
        endpoint,
      ],
      cancellable,
    );
  } catch (error) {
    if (cancellable.is_cancelled()) return {status: 'cancelled'};
    return {status: 'unreachable', detail: `${origin} did not respond (${error})`};
  }

  if (cancellable.is_cancelled()) return {status: 'cancelled'};
  if (!body.trim()) return {status: 'unreachable', detail: `${origin} returned an empty response`};
  if (!isJsonPayload(body))
    return {status: 'notJson', detail: `${origin} did not return JSON`};

  const {results, unresponsiveEngines} = parseSearxngJson(body, cappedLimit);
  // Only when the query produced nothing AND engines were down is the empty result
  // worth explaining. Never claim the instance "reached no engines": `unresponsive_engines`
  // lists only the engines that failed, and a healthy instance routinely carries a few
  // (rate-limited, CAPTCHA-gated) while the rest answer correctly with no matches. The
  // row states what is actually known — no results, and which engines were unavailable.
  if (results.length === 0 && isConnectivityFailure(unresponsiveEngines)) {
    return {
      status: 'enginesUnavailable',
      detail: `${origin} could not reach any engine (${unresponsiveEngines.length} timed out)`,
      engines: unresponsiveEngines.map(f => f.name),
    };
  }
  return {status: 'ok', results};
}
