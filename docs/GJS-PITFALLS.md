# GJS Pitfalls — Rules This Extension Learned the Hard Way

GNOME Shell extensions run **inside the compositor process**. On Wayland the Shell
is also the display server, so a blocked main loop is not a slow extension — it is
a frozen machine with no way back to a TTY. Everything below is enforced by
`make check`; please keep it that way.

---

## 1. Never call `cancellable.disconnect()` from inside a `::cancelled` callback

**This froze the machine and forced a hard power-off.**

`Gio.Cancellable.connect()` maps to `g_cancellable_connect()`, and `disconnect()`
maps to `g_cancellable_disconnect()`. Per GLib's contract, `g_cancellable_disconnect()`
*blocks until any in-flight cancellation completes*. Calling it from within the
cancellation it is waiting on deadlocks the calling thread — which, here, is the
compositor thread.

GNOME Shell cancels the previous search cancellable on **every keystroke**, so this
pattern was hit by ordinary typing.

```js
// DEADLOCK — freezes GNOME Shell
cancelledId = cancellable.connect(() => {
  cancellable.disconnect(cancelledId);   // blocks forever
  reject(new Error('Search cancelled'));
});
```

The captured stack shows exactly this:

```
#0  syscall
#1  (futex wait)
#2  g_cancellable_disconnect      ← blocked forever
...
#13 JS_CallFunctionValue          ← called from the JS ::cancelled callback
```

**Rule:** do not subscribe to the cancellable at all unless you truly need early
wakeup. Prefer either of these:

```js
// Short sleeps: just check when the timer fires.
GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
  if (cancellable.is_cancelled()) reject(new Error('Search cancelled'));
  else resolve();
  return GLib.SOURCE_REMOVE;
});

// Async Gio calls: hand the cancellable to the call and let it reject.
const [stdout] = await proc.communicate_utf8_async(stdin, cancellable);
```

Regression test: `make check-freeze` replays the cancel-per-keystroke sequence and
fails (by hanging, then timing out) if the pattern comes back.

---

## 2. There is no `URL` in GJS

GJS is SpiderMonkey plus GNOME bindings, not a browser or Node. `URL` is **not**
defined, so `new URL(x)` throws `ReferenceError`. Because the old parsing code sat
inside `try { ... } catch { return null; }`, every single result was silently
discarded and the extension appeared to work while never returning a result.

Use `GLib.Uri` instead:

```js
const uri = GLib.Uri.parse(candidate, GLib.UriFlags.PARSE_RELAXED);
uri.get_scheme();   // 'https'
uri.get_host();     // 'example.com'
uri.get_path();     // '/a/b'
```

Also absent: `fetch`, `setTimeout`/`setInterval` (use `GLib.timeout_add`),
`localStorage`. `TextEncoder`/`TextDecoder` *are* present in modern GJS.

**Rule:** never let a bare `catch {}` swallow a `ReferenceError`. Catch only what
you expect, or log what you swallowed.

---

## 3. Promisified Gio calls do not return the `gboolean`

When a C function returns `gboolean` and takes a `GError**`, GJS drops the boolean
and throws on failure instead. So the resolved value contains **only the out
parameters**:

```js
// g_subprocess_communicate_utf8_finish(self, res, &stdout, &stderr, &error)
const [stdout, stderr] = await proc.communicate_utf8_async(stdin, cancellable);

// WRONG — binds stdout to stderr, silently yielding null
const [, stdout] = await proc.communicate_utf8_async(stdin, cancellable);
```

That off-by-one was the second reason no results ever appeared.

**Rule:** verify tuple shape against the C `_finish()` signature, and assert on it
in a harness that imports the built artefact (`make check`).

---

## 4. Promisify what you use; do not rely on Shell having done it

`Gio._promisify()` is idempotent, so claim the methods you need at module scope.
Relying on GNOME Shell's internal promisify list couples the extension to Shell
internals and makes the module untestable outside the Shell process.

```js
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
```

---

## 5. No synchronous I/O and no per-keystroke logging on the main loop

An earlier debug logger appended to a file synchronously on every search. Besides
adding compositor-thread I/O to the typing path, it wrote **every query the user
typed** to disk in plaintext at a hardcoded developer path, and posted it to a
localhost HTTP endpoint. None of that belongs in a shipped extension.

**Rule:** `console.log`/`console.warn` only, and nothing per-keystroke.

---

## 6. Do not scrape engines — render the engine's own page

Two backends have been removed from this codebase: fetching engine HTML with `curl`
and parsing it with a Lexbor-backed native helper, and later listing links from a
user-run **SearXNG** instance over its JSON API. What remains is the engine's own
results page, rendered by `panel/sds-renderer.js` and shown as a texture. This
section records the measurements behind both removals so nobody re-litigates them.

Remote data is still hostile input, and the rule that matters survives every rewrite:

- Only `http`/`https` URLs may reach `Gio.AppInfo.launch_default_for_uri()`. It is
  checked in `sds-renderer.js` (`isSafeHttpUrl`, after `unwrapRedirect` has resolved
  the engine's tracking hop) **and** re-checked in
  `browserLauncher.openInDefaultBrowser()`, because the launcher is the actual sink
  and must not trust its caller. Anything else — `mailto:`, `magnet:`, an app scheme —
  is refused rather than handed to the desktop's handler list.
- The same applies to what the contained view will *display*: a response WebKit
  cannot render goes to the real browser instead of becoming a silent download.

### Scraping was never going to hold

Measured with a plain `curl` and a realistic user agent:

| Engine | Parseable results | Notes |
|---|---|---|
| DuckDuckGo (`html.duckduckgo.com`) | yes | reliable, but the only one that was |
| Mojeek | yes | CAPTCHA after ~1 query per 30–60s per IP |
| Brave | yes | class names are Svelte build hashes; break on each deploy |
| Google | no | JS bootstrap page, zero `<h3>`, zero result links |
| Bing | no | CAPTCHA |
| Startpage / Ecosia | no | no markup / HTTP 403 |

One reliable engine and a hand-rolled fallback is not a backend; it is a maintenance
treadmill where every upstream redesign ships as a broken search bar.

### Verification requests: avoid attributing a cause we cannot measure

Earlier tests observed Google's homepage loading while its search path returned
verification or an empty JavaScript bootstrap page. Those observations do not
isolate runtime fingerprinting from IP reputation, network state, request pacing,
consent, or other engine policy. The previous categorical conclusion that the
JavaScript runtime alone caused the block was not established by the experiment.

The current renderer uses ordinary search paths and its own persistent cookie
store. Cookies preserve session state; they are not proof that a visitor is human.
We do not extract browser cookies, spoof fingerprints, rotate proxies or solve
verification challenges. The UI offers a real-browser handoff and explicit engine
choice. Updated measurements, including browser differences and failed runs, are
in [SEARCH-ENGINE-FINDINGS.md](SEARCH-ENGINE-FINDINGS.md). The scraper measurements
above are historical observations, not availability guarantees.

### Why SearXNG looked right, and why it is gone too

SearXNG fans one query across many upstreams, owns the blocking problem, and degrades
gracefully when an individual engine refuses. Measured against a local instance:

```
rust ownership          1.05s  25 results  [duckduckgo, google cse]
gnome shell extension   1.12s  27 results  [duckduckgo, google cse]
postgres index          1.29s  26 results  [duckduckgo, google cse]
unresponsive: brave (too many requests), startpage (CAPTCHA)
```

Note `google cse` — Google's *sanctioned* Programmable Search endpoint — answering
where the scraper could not. Google-sourced results are reachable; scraping was
simply the wrong door. SearXNG's plain `google` engine returned nothing, exactly as
the table above predicts.

The trade-off was explicit: the user had to run a service. That is what killed it in
the end — the rendered results page already shows what the link list showed, so the
instance bought a duplicate of the page at the cost of a container to maintain. The
measurements above are kept because they are still the reason **not** to reintroduce a
scraper: the engines that refused a scripted client then refuse one now.

---

## 7. Top-level `await` breaks the main loop in test harnesses

If a module uses top-level `await`, the rest of the module runs inside a microtask.
Calling `loop.run()` from there blocks *inside* that job, and GJS never drains the
promise queue — every promise silently never settles.

**Rule:** in harnesses, use static imports and reach `loop.run()` from the module's
initial synchronous execution.

---

## Verifying

```bash
make check           # everything below
make check-freeze    # cancel-per-keystroke must never block the thread
make check-provider  # a page load is issued exactly when it should be
make nested          # the whole thing, in a throwaway GNOME session
```

`make check-freeze` hangs on a regression rather than failing fast — that *is* the
symptom — so it always runs under `timeout`.
