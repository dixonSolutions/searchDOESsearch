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
in a smoke test (`make check-fetch`).

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

## 6. Do not scrape engines — query a SearXNG instance

The extension used to fetch engine HTML with `curl` and parse it with a Lexbor-backed
native helper. That backend is gone. Results now come from a user-run **SearXNG**
instance over its JSON API, and this section records the measurements behind that
decision so nobody re-litigates it.

Remote data is still hostile input, so two rules survive the rewrite:

- Every child process gets a wall-clock timeout (`PROCESS_TIMEOUT_MS`) in case
  `curl` wedges.
- Only `http`/`https` URLs may reach `Gio.AppInfo.launch_default_for_uri()`. This is
  checked in `webSearch.normalizeResultUrl()` **and** re-checked in
  `browserLauncher.openInDefaultBrowser()`, because the launcher is the actual sink
  and must not trust its caller. The configured instance address is validated the
  same way by `normalizeInstanceUrl()` — a GSettings string is handed to `curl`, so
  allowing arbitrary schemes would let a bad setting reach `file://` or `scp://`.

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

### Google specifically: the block is environmental, not behavioural

An obvious idea is "render the JavaScript" or "look more like a human". Neither works.

Google's response to a scripted client is ~45 KB containing **168 characters of
visible text** — a redirect notice — with no result data in any form. Adding realism
changes nothing:

| Attempt | Result |
|---|---|
| Plain `curl` | `enablejs` page, 0 results |
| `curl` + full Chrome headers, cookie jar, warm session, `Referer` | **identical** 168-char page |
| WebKitGTK, clean IP, persistent profile — homepage | renders perfectly |
| WebKitGTK, same warm session — `/search` | `unusual traffic` on the **first** request |

The last two rows are the important pair. The same engine, session, and IP that
render `google.com` correctly are refused at `/search`, and the refusal lands on
request one — before any behaviour exists to look suspicious.

That rules out the whole "simulate human activity" category. Typing cadence, mouse
movement, dwell time, and randomised delays are not being measured. Google
fingerprints the **JS runtime environment** and gates `/search` on it. The remaining
levers are fingerprint spoofing, residential proxy rotation, and CAPTCHA-solving
services; all three violate Google's ToS, would block publication on
extensions.gnome.org, and push the cost onto the user, whose home IP gets flagged for
ordinary browsing.

> Correction to an earlier revision of this document, which concluded the block was
> on "IP and request pattern". That was wrong, and wrong for an instructive reason:
> the CAPTCHA observed at the time was self-inflicted by ~10 rapid test requests. On
> a rested IP the baseline is the `enablejs` page, and the WebKit result above shows
> the gate is environmental. Rate your own test traffic before drawing conclusions
> from a rate limiter.

### Why SearXNG is the right shape

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

The trade-off is explicit: the user must run a service. When it is missing,
misconfigured, or serving HTML instead of JSON, the provider surfaces a row that
names the cause and links to the fix, rather than showing an empty list that is
indistinguishable from "no matches".

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
make searxng        # start a local instance with JSON output enabled
make check          # freeze regression + live fetch smoke test
make check-freeze   # cancel-per-keystroke must never block the thread
make check-fetch    # live query must yield results
```

`make check-freeze` hangs on a regression rather than failing fast — that *is* the
symptom — so it always runs under `timeout`.
