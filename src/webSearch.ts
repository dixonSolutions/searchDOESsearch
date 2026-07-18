import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export type WebSearchEngine = 'google' | 'duckduckgo';
export interface WebResult { title: string; url: string; displayUrl: string; description: string; }

function decodeHtml(value: string): string {
  const named: Record<string, string> = {amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'};
  return value.replace(/<[^>]+>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_all, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  }).replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw: string, engine: WebSearchEngine): string | null {
  let url = decodeHtml(raw);
  const redirect = engine === 'duckduckgo' ? /[?&]uddg=([^&]+)/.exec(url) : /[?&]q=([^&]+)/.exec(url);
  if ((url.startsWith('//duckduckgo.com/l/?') || url.startsWith('/url?')) && redirect) url = decodeURIComponent(redirect[1]);
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null; } catch { return null; }
}

export function parseSearchResults(html: string, engine: WebSearchEngine, limit: number): WebResult[] {
  const pattern = engine === 'google'
    ? /<a[^>]+href="([^"]+)"[^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?(?:<div[^>]+(?:data-sncf|class)="[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi
    : /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const results: WebResult[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while (results.length < limit && (match = pattern.exec(html))) {
    const url = normalizeUrl(match[1], engine);
    const title = decodeHtml(match[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const parsed = new URL(url);
    results.push({title, url, displayUrl: `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`, description: decodeHtml(match[3] ?? '')});
  }
  return results;
}

function browserPath(configured: string): string | null {
  if (configured.trim()) return GLib.find_program_in_path(configured.trim());
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) { const path = GLib.find_program_in_path(name); if (path) return path; }
  return null;
}

function removeTree(file: Gio.File): void {
  try {
    const children = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info: Gio.FileInfo | null;
    while ((info = children.next_file(null))) { const child = file.get_child(info.get_name()); if (info.get_file_type() === Gio.FileType.DIRECTORY) removeTree(child); else child.delete(null); }
    children.close(null); file.delete(null);
  } catch { /* best-effort temporary-profile cleanup */ }
}

export async function fetchWebResults(query: string, engine: WebSearchEngine, command: string, limit: number, cancellable: Gio.Cancellable): Promise<WebResult[]> {
  const browser = browserPath(command);
  if (!browser) { console.warn('[SearchDoesSearch] Chrome or Chromium is required'); return []; }
  const profile = GLib.dir_make_tmp('search-does-search-XXXXXX');
  const url = engine === 'google' ? `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en` : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const process = Gio.Subprocess.new([browser, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--dump-dom', url], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
  const timeout = setTimeout(() => process.force_exit(), 8000);
  try { const [, stdout] = await process.communicate_utf8_async(null, cancellable); return parseSearchResults(stdout ?? '', engine, Math.max(1, Math.min(limit, 5))); }
  catch (error) {
    process.force_exit();
    if (!cancellable.is_cancelled()) console.warn(`[SearchDoesSearch] Renderer failed: ${error}`);
    return [];
  }
  finally { clearTimeout(timeout); removeTree(Gio.File.new_for_path(profile)); }
}
