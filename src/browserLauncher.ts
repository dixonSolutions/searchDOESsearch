/**
 * browserLauncher.ts
 *
 * Opens result URLs in the user's default browser via GIO, which respects
 * xdg-mime settings — Firefox, Chrome, Brave, Chromium, or anything else.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Reject anything that is not plain http(s).
 *
 * URLs reaching this module came from a remote results page, so they are
 * attacker-influenced. The renderer already filters them (`isSafeHttpUrl` after
 * `unwrapRedirect` in panel/sds-renderer.js), but this is the function that
 * actually hands a URI to the desktop's URI handler, so it re-checks rather than
 * trusting its caller: `file:`, `javascript:` or a custom scheme registered by an
 * installed app would otherwise be launchable from the overview.
 */
function isSafeHttpUrl(url: string): boolean {
  try {
    const scheme = GLib.Uri.parse(url, GLib.UriFlags.PARSE_RELAXED).get_scheme();
    return scheme === 'http' || scheme === 'https';
  } catch {
    return false;
  }
}

/**
 * Opens a URL in the user's default browser.
 *
 * @returns true if the URL was handed off successfully, false otherwise.
 */
export function openInDefaultBrowser(url: string): boolean {
  if (!isSafeHttpUrl(url)) {
    console.warn(`[SearchDoesSearch] refusing to open non-http(s) URL: ${url}`);
    return false;
  }

  try {
    Gio.AppInfo.launch_default_for_uri(url, null);
    return true;
  } catch (err) {
    // Fallback for minimal installs where no GAppInfo handler is registered.
    try {
      GLib.spawn_command_line_async(`xdg-open ${GLib.shell_quote(url)}`);
      return true;
    } catch (fallbackErr) {
      console.warn(`[SearchDoesSearch] failed to open browser: ${err}; ${fallbackErr}`);
      return false;
    }
  }
}
