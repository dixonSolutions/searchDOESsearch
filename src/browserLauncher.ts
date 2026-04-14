/**
 * browserLauncher.ts
 *
 * Responsible for opening URLs in the user's default browser.
 * Uses GIO's AppInfo API which respects xdg-mime settings —
 * compatible with Firefox, Chrome, Brave, Chromium, and any
 * browser the user has set as their default.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Supported search engines and their URL builder functions. */
export const SEARCH_ENGINES: Record<string, (query: string) => string> = {
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  google:     (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  brave:      (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  bing:       (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  startpage:  (q) => `https://www.startpage.com/search?q=${encodeURIComponent(q)}`,
};

export type SearchEngine = keyof typeof SEARCH_ENGINES;

/**
 * Builds a search URL for the given query and engine.
 * Falls back to DuckDuckGo if an unknown engine key is provided.
 */
export function buildSearchUrl(query: string, engine: SearchEngine = 'duckduckgo'): string {
  const builder = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES['duckduckgo'];
  return builder(query);
}

/**
 * Opens a URL in the user's default browser via GIO.
 * This is the correct cross-distro, cross-browser way on Linux.
 *
 * @returns true if the URL was launched successfully, false otherwise.
 */
export function openInDefaultBrowser(url: string): boolean {
  try {
    Gio.AppInfo.launch_default_for_uri(url, null);
    return true;
  } catch (err) {
    // Fallback: try xdg-open via GLib if GIO fails (e.g. on minimal installs)
    try {
      GLib.spawn_command_line_async(`xdg-open ${GLib.shell_quote(url)}`);
      return true;
    } catch (fallbackErr) {
      log(`[SearchDoesSearch] Failed to open browser: ${fallbackErr}`);
      return false;
    }
  }
}

/**
 * Convenience: build the URL and open it in one call.
 */
export function searchInBrowser(query: string, engine: SearchEngine = 'duckduckgo'): boolean {
  const url = buildSearchUrl(query, engine);
  return openInDefaultBrowser(url);
}
