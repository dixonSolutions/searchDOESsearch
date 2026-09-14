/**
 * section.ts — where our results sit in the overview, and whether they show.
 *
 * GNOME builds one section per provider and keeps it in `provider.display`
 * (search.js, `_ensureProviderDisplay`). That object is the handle for the three
 * things the Shell gives a provider no say over:
 *
 *   · the provider column — the wide icon-and-name strip down the left of a list
 *     section. Ours says "searchDOESsearch" and nothing else, in the space the
 *     page wants, so it is hidden and the page takes the width back.
 *   · order — sections are laid out in registration order. Moving ours to the
 *     front of the parent box is the only way to put it above app matches.
 *   · whether to appear at all — the provider must answer a search before it can
 *     know what else matched, so "only when nothing else did" is decided here,
 *     once the sweep settles, rather than by returning no results.
 *
 * Every one of those reaches past the public provider contract, so each is
 * feature-detected and silently skipped if a future Shell moves it; the section
 * then looks like any other provider's instead of breaking.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

/** SDS_DEBUG=1 in the Shell's environment reports what the section walk found. */
const DEBUG = !!GLib.getenv('SDS_DEBUG');

/** The bits of the Shell's SearchResultsBase this file relies on. */
interface Section extends St.Widget {
  provider?: {id?: string; appInfo?: Gio.AppInfo | null};
  providerInfo?: Clutter.Actor;
  /** ListSearchResults keeps the card (.search-section-content) in here. */
  _resultDisplayBin?: St.Bin;
}

interface Provider { display?: Section }

/**
 * The card inside a section: `_resultDisplayBin`'s child in every Shell that has
 * had one, and otherwise whichever descendant carries the Shell's own class.
 * Returns null rather than guessing, in which case only the padding is missed.
 */
/**
 * `get_parent()` answers "is this actor in a box", not "is it still alive", and
 * the two disagree in both directions — a removed-but-not-finalized sibling
 * still needs disconnecting, and a finalized one throws when touched. Try, and
 * treat a throw as "already gone".
 */
function disconnectSafely(actor: Clutter.Actor, id: number): void {
  try {
    actor.disconnect(id);
  } catch { /* the actor was finalized; its handlers went with it */ }
}

function findCard(section: Section): St.Widget | null {
  const isCard = (actor: Clutter.Actor): boolean =>
    (actor as St.Widget).has_style_class_name?.('search-section-content') ?? false;
  const child = section._resultDisplayBin?.get_child();
  if (child && isCard(child)) return child as St.Widget;
  const queue: Clutter.Actor[] = [...section.get_children()];
  for (let i = 0; i < queue.length && i < 64; i++) {
    const actor = queue[i];
    if (isCard(actor)) return actor as St.Widget;
    queue.push(...actor.get_children());
  }
  return null;
}

/**
 * The browser's own "Search online for …" entry answers every query, so it is
 * not evidence that anything matched.
 *
 * The default https handler names it — when the ids agree. They often do not:
 * a provider's DesktopId is whatever its .ini says (`firefox.desktop`) while
 * the handler may be `org.mozilla.firefox.desktop` or `firefox_firefox.desktop`
 * from Flatpak or Snap, and on a minimal install there may be no default
 * handler at all. Getting this wrong in `no-other-results` mode would hide the
 * section on every search, with nothing to tell the user why — so a name test
 * backs the id up.
 */
const BROWSER_IDS = /(firefox|chrome|chromium|zen|brave|vivaldi|opera|epiphany|librewolf|waterfox|midori|falkon|gnome-web)/i;

function isBrowserSearch(appId: string | null, providerId: string | null, browserId: string | null): boolean {
  if (browserId && appId === browserId) return true;
  return BROWSER_IDS.test(appId ?? '') || BROWSER_IDS.test(providerId ?? '');
}

export class SectionPlacement {
  private _settings: Gio.Settings;
  private _provider: Provider;
  private _section: Section | null = null;
  private _card: St.Widget | null = null;
  private _parent: Clutter.Actor | null = null;
  /** Where the Shell had put this section before anything moved it. */
  private _homeIndex = -1;
  private _pinned = false;
  private _parentIds: Array<[Clutter.Actor, number]> = [];
  private _childIds: Array<[Clutter.Actor, number]> = [];
  private _applyTimer = 0;
  private _settingsId = 0;
  private _hidden = false;
  /**
   * Looking the default browser up scans every .desktop file on the system the
   * first time, and this runs while the user types — on the compositor thread.
   * It is read once and refreshed only when the desktop's associations change.
   */
  private _browserId: string | null = null;
  private _browserIdKnown = false;
  private _appMonitor: Gio.AppInfoMonitor | null = null;
  private _appMonitorId = 0;
  /** Our own hide() would otherwise come back round as another notify::visible. */
  private _applying = false;

  constructor(settings: Gio.Settings, provider: Provider) {
    this._settings = settings;
    this._provider = provider;
    try {
      this._appMonitor = Gio.AppInfoMonitor.get();
      this._appMonitorId = this._appMonitor.connect('changed', () => {
        this._browserIdKnown = false;
      });
    } catch { /* no monitor: the id is simply read once and kept */ }
    this._settingsId = settings.connect('changed', (_s: Gio.Settings, key: string) => {
      if (key === 'section-visibility' || key === 'section-placement') this._apply();
    });
  }

  /**
   * Called once results exist, which is the first moment the Shell has built the
   * section. Cheap and idempotent: the Shell rebuilds the section after a reset.
   */
  attach(): void {
    const section = this._provider.display;
    if (!section || section === this._section) return;
    this._release();
    this._section = section;
    try {
      this._attachTo(section);
    } catch (error) {
      // Every hop below reaches past the provider contract. If a future Shell
      // moves one, this section should look like any other provider's, not
      // disappear: the Shell clears a section whose update throws.
      console.warn(`[SearchDoesSearch] section placement unavailable: ${error}`);
    }
  }

  private _attachTo(section: Section): void {
    // The provider column is pure letterhead in a section whose one result is a
    // full-width page; hiding it is the width the page gains.
    section.providerInfo?.hide();
    // Two different actors: `provider.display` is the section box
    // (.search-section), and the rounded card the user sees is
    // .search-section-content inside its result-display bin. The padding rules
    // belong on the card, so each gets its own class and neither reaches any
    // other provider's section.
    section.add_style_class_name('sds-search-section');
    this._card = findCard(section);
    this._card?.add_style_class_name('sds-section');
    if (DEBUG) {
      console.log(`[SearchDoesSearch] section attached: providerInfo=${!!section.providerInfo} ` +
        `card=${!!this._card} parent=${section.get_parent()?.constructor?.name} ` +
        `keys=${Object.keys(section).filter(k => k.includes('esult') || k.includes('rovider')).join(',')}`);
    }

    // Re-decide whenever any section appears or disappears. The Shell has no
    // "the sweep finished" signal an extension can use — SearchResultsView's
    // searchInProgress is a plain JS getter with no notify — so the evidence is
    // the sibling sections themselves showing and hiding.
    const parent = section.get_parent();
    if (parent) {
      for (const signal of ['child-added', 'child-removed'] as const) {
        try {
          this._parentIds.push([parent, parent.connect(signal, () => this._watchChildren())]);
        } catch { /* older Clutter: the notify::visible hooks still cover it */ }
      }
      this._parent = parent;
      this._homeIndex = parent.get_children().indexOf(section);
      this._pinned = false;
      this._watchChildren();
    }
    this._apply();
  }

  /** One notify::visible hook per sibling, refreshed when the set changes. */
  private _watchChildren(): void {
    for (const [actor, id] of this._childIds) disconnectSafely(actor, id);
    this._childIds = [];
    for (const child of this._parent?.get_children() ?? []) {
      // Our own section counts too: the Shell showing it is how a new sweep
      // announces itself, and in `no-other-results` mode that is the moment to
      // hold it back until the others have answered. `_applying` keeps our own
      // hide() from coming back round as another sweep.
      this._childIds.push([child, child.connect('notify::visible', () => {
        if (!this._applying) this._queueApply(child === this._section && child.visible);
      })]);
    }
    this._queueApply();
  }

  /**
   * Several sections settle in one frame; decide once, after they have. In
   * `no-other-results` mode the wait is longer and the section is held hidden
   * until then: our own provider answers synchronously while a remote one takes
   * a couple of hundred milliseconds, so deciding early shows the section and
   * then snatches it away.
   */
  private _queueApply(shownByShell = false): void {
    // Only the Shell showing *our* section starts a new sweep. Hiding on any
    // sibling's update would take the section away again a moment after we had
    // decided to show it — the same flicker, from the other direction.
    if (shownByShell
        && this._settings.get_string('section-visibility') === 'no-other-results'
        && this._section?.visible && !this._hidden) {
      this._applying = true;
      this._section.hide();
      this._hidden = true;
      this._applying = false;
    }
    if (this._applyTimer) return;
    const wait = this._settings.get_string('section-visibility') === 'no-other-results' ? 150 : 30;
    this._applyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
      this._applyTimer = 0;
      this._apply();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _defaultBrowserId(): string | null {
    if (!this._browserIdKnown) {
      try {
        this._browserId = Gio.AppInfo.get_default_for_uri_scheme('https')?.get_id() ?? null;
      } catch {
        this._browserId = null;
      }
      this._browserIdKnown = true;
    }
    return this._browserId;
  }

  /** Other providers that actually matched something, the browser's catch-all aside. */
  private _othersMatched(): boolean {
    const section = this._section;
    const parent = section?.get_parent();
    if (!section || !parent) return false;
    const browserId = this._defaultBrowserId();
    return parent.get_children().some(child => {
      if (child === section || !child.visible) return false;
      const provider = (child as Section).provider;
      const appId = provider?.appInfo?.get_id?.() ?? null;
      const matched = !isBrowserSearch(appId, provider?.id ?? null, browserId);
      if (DEBUG && matched) console.log(`[SearchDoesSearch] counted as a match: ${provider?.id ?? '?'}`);
      return matched;
    });
  }

  private _apply(): void {
    const section = this._section;
    if (!section || this._applying) return;
    this._applying = true;
    try {
      this._decide(section);
    } finally {
      this._applying = false;
    }
  }

  private _decide(section: Section): void {
    const visibility = this._settings.get_string('section-visibility');
    const placement = this._settings.get_string('section-placement');
    // Neither setting depends on what else matched: do not walk the siblings.
    const needsAlone = visibility === 'no-other-results' || placement === 'top-when-alone';
    const alone = needsAlone ? !this._othersMatched() : false;
    if (DEBUG) {
      const siblings = section.get_parent()?.get_children()
        .map(c => `${c === section ? '*' : ''}${(c as Section).provider?.id ?? '?'}:${c.visible ? 'vis' : 'hid'}`)
        .join(' ') ?? 'no parent';
      console.log(`[SearchDoesSearch] apply alone=${needsAlone ? alone : 'n/a'} ` +
        `visibility=${visibility} placement=${placement} siblings=[${siblings}]`);
    }

    const show = visibility !== 'no-other-results' || alone;
    // Only ever un-hide what this hid: an empty section is hidden by the Shell
    // itself, and forcing it visible would show an empty frame.
    if (!show) {
      section.hide();
      this._hidden = true;
    } else if (this._hidden) {
      section.show();
      this._hidden = false;
    }

    const pin = show && (placement === 'top' || (placement === 'top-when-alone' && alone));
    const parent = section.get_parent();
    if (!parent) return;
    if (pin) {
      if (parent.get_children()[0] !== section) parent.set_child_at_index(section, 0);
      this._pinned = true;
    } else if (this._pinned) {
      // Moving up must be undoable, or one query where nothing else matched
      // leaves a page-sized card above every app and file match for the rest of
      // the session — the opposite of what 'top-when-alone' is for.
      const home = Math.min(Math.max(this._homeIndex, 0), parent.get_n_children() - 1);
      if (home >= 0 && parent.get_children()[home] !== section) parent.set_child_at_index(section, home);
      this._pinned = false;
    }
  }

  private _release(): void {
    try {
      this._releaseUnsafe();
    } catch (error) {
      // A half-released placement must not take the rest of disable() with it:
      // the provider and the renderer are torn down after this returns.
      console.warn(`[SearchDoesSearch] releasing the section failed: ${error}`);
      this._parentIds = [];
      this._childIds = [];
      this._parent = null;
      this._card = null;
      this._section = null;
      this._hidden = false;
    }
  }

  private _releaseUnsafe(): void {
    if (this._applyTimer) GLib.source_remove(this._applyTimer);
    this._applyTimer = 0;
    for (const [actor, id] of [...this._parentIds, ...this._childIds]) disconnectSafely(actor, id);
    this._parentIds = [];
    this._childIds = [];
    this._parent = null;
    this._card?.remove_style_class_name('sds-section');
    this._card = null;
    if (this._section) {
      this._section.providerInfo?.show();
      this._section.remove_style_class_name('sds-search-section');
      if (this._hidden) this._section.show();
    }
    this._hidden = false;
    this._section = null;
  }

  destroy(): void {
    if (this._appMonitor && this._appMonitorId) this._appMonitor.disconnect(this._appMonitorId);
    this._appMonitorId = 0;
    this._appMonitor = null;
    this._release();
    if (this._settingsId) this._settings.disconnect(this._settingsId);
    this._settingsId = 0;
  }
}
