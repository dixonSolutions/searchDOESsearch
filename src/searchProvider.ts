/**
 * searchProvider.ts
 *
 * Implements the GNOME Shell Search Provider interface.
 *
 * Shows a result card in the Activities search overlay containing:
 *   - The user's query as the card title
 *   - The URL that will be opened as the subtitle
 *   - The user's actual default browser icon (detected at runtime)
 *   - Clicking the card (or the "→" launch button) opens the query
 *     in the default browser — the browser handles all searching.
 *
 * We intentionally make zero HTTP requests. The browser does the work.
 *
 * GNOME Search Provider API:
 * https://gjs.guide/extensions/topics/search-provider.html
 */

import St from 'gi://St';
import Gio from 'gi://Gio';
import { SearchEngine, searchInBrowser, buildSearchUrl } from './browserLauncher.js';

// GJS resolves gi://Gio and @girs/st-17's Gio to different package copies at
// the type level. We extract the icon type directly from St.Icon's constructor
// so both sides always agree on the same Gio.Icon definition.
type GIcon = St.Icon extends { gicon: infer T } ? T : never;

/** Shape of a result meta object expected by GNOME Shell. */
interface ResultMeta {
  id: string;
  name: string;
  description: string;
  clipboardText?: string;
  createIcon: (size: number) => St.Widget;
}

/** Internal result ID prefix — namespaces our IDs away from other providers. */
const RESULT_PREFIX = 'sds:';

/** Extracts the raw search query from a namespaced result ID. */
function queryFromId(id: string): string {
  return decodeURIComponent(id.slice(RESULT_PREFIX.length));
}

/** Builds a namespaced result ID from a search query. */
function idFromQuery(query: string): string {
  return `${RESULT_PREFIX}${encodeURIComponent(query)}`;
}

/**
 * Resolves the user's default browser for HTTPS URIs at runtime.
 * Returns { name, icon } — icon may be null if no browser is registered.
 */
function getDefaultBrowser(): { name: string; icon: GIcon | null } {
  const appInfo = Gio.AppInfo.get_default_for_uri_scheme('https');
  // Cast through unknown to bridge the two copies of Gio.Icon in the dep tree.
  // At runtime these are identical — the type mismatch is a TypeScript artifact.
  const icon = (appInfo?.get_icon() ?? null) as unknown as GIcon | null;
  return {
    name: appInfo?.get_display_name() ?? 'Browser',
    icon,
  };
}

/**
 * Creates an icon widget for the result card.
 * Prefers the real default browser icon; falls back to the generic
 * 'web-browser-symbolic' system icon if none is found.
 */
function createResultIcon(size: number, browserIcon: GIcon | null): St.Widget {
  if (browserIcon !== null) {
    return new St.Icon({
      gicon: browserIcon,
      icon_size: size,
      style_class: 'search-does-search-icon',
    });
  }

  // Fallback: generic web browser icon from the system icon theme
  return new St.Icon({
    icon_name: 'web-browser-symbolic',
    icon_size: size,
    style_class: 'search-does-search-icon',
  });
}

export class SearchProvider {
  private _engine: SearchEngine;

  constructor(engine: SearchEngine = 'duckduckgo') {
    this._engine = engine;
  }

  /** Update the active search engine (called when the user changes prefs). */
  setEngine(engine: SearchEngine): void {
    this._engine = engine;
  }

  // ---------------------------------------------------------------------------
  // GNOME Search Provider API — method names are contractual, do not rename
  // ---------------------------------------------------------------------------

  /**
   * Called when the user starts a new search.
   * Returns one result ID per non-empty query.
   */
  getInitialResultSet(
    terms: string[],
    callback: (ids: string[]) => void
  ): void {
    const query = terms.join(' ').trim();
    callback(query.length > 0 ? [idFromQuery(query)] : []);
  }

  /**
   * Called as the user refines their query (more characters typed).
   * Recomputes from scratch — each keystroke is a new query.
   */
  getSubsearchResultSet(
    _previousResults: string[],
    terms: string[],
    callback: (ids: string[]) => void
  ): void {
    this.getInitialResultSet(terms, callback);
  }

  /**
   * Called by GNOME Shell to get display data for each result ID.
   *
   * Card layout (matches the wireframe):
   *   [Browser icon]  Search Results            [→ open arrow]
   *                   "your query" — opens in Firefox
   *                   https://duckduckgo.com/?q=your+query
   */
  getResultMetas(
    ids: string[],
    callback: (metas: ResultMeta[]) => void
  ): void {
    // Resolve the default browser once per call — cheap GIO lookup, no I/O
    const browser = getDefaultBrowser();

    const metas: ResultMeta[] = ids.map((id) => {
      const query   = queryFromId(id);
      const url     = buildSearchUrl(query, this._engine);

      return {
        id,
        name:          'Search Results',
        description:   `"${query}" — opens in ${browser.name}\n${url}`,
        clipboardText: url,
        createIcon:    (size: number) => createResultIcon(size, browser.icon),
      };
    });

    callback(metas);
  }

  /**
   * Called when the user clicks a result card (or presses Enter on it).
   * Hands the query off to the default browser — it does the actual search.
   */
  activateResult(id: string, _terms: string[], _timestamp: number): void {
    const query = queryFromId(id);
    searchInBrowser(query, this._engine);
  }

  /**
   * Called when the user clicks the "→ Show more results" launch button
   * on the right side of the section header (matching the wireframe arrow).
   * Same behaviour: open in the default browser.
   */
  launchSearch(terms: string[], _timestamp: number): void {
    const query = terms.join(' ').trim();
    if (query.length > 0) {
      searchInBrowser(query, this._engine);
    }
  }

  /** Limits results shown — we only ever return one, but the API requires this. */
  filterResults(results: string[], maxNumber: number): string[] {
    return results.slice(0, maxNumber);
  }
}
