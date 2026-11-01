# Changelog

All notable changes to the Gloam Timezone Extension are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

1.0.2 is the first public version. The two entries below it are development
history, kept because the code they describe is what you are reading; neither
was ever distributed. Early commits carry `1.0.1` in the manifest throughout —
the numbering was settled when this file was written, and 1.0.0 is what that
first build is called here.

## 1.1.0 — 2026-11-01

The timezone override moves to native main-world declarative injection, eliminating
the asynchronous storage race on page load and removing the need for the browser's
"Allow user scripts" toggle. Prototype subclassing is replaced with zero-allocation
in-place patching, dynamic iframes are adopted on access, and challenge detection
now tracks clearance cookies.

### Changed

- **Native main-world injection via `manifest.json`.** Rather than relying on
`chrome.userScripts` or falling back to asynchronous isolated-world content script
injection, the timezone hook is now declared statically with `world: "MAIN"` at
`document_start`. The browser engine guarantees it executes in the page context before
any inline or external page script can run.
- **`Date.prototype` is patched in place instead of subclassed.** Replacing `Date` with
a subclass (`class FakeZoneDate extends RealDate`) and maintaining partner dates in a
`WeakMap` caused heavy garbage collection pressure on date-heavy pages and subtle
divergences in `instanceof`, cross-realm checks, and `structuredClone`. All local-time
methods are now patched directly on `Date.prototype` with zero per-instance allocations.
- **Permissions reduced to `"storage"` only.** Because injection is handled natively
by the manifest declaration, the elevated `"scripting"` and `"userScripts"` permissions
are no longer needed. The extension requests zero host or scripting permissions on install.
- **`Intl.DateTimeFormat` no longer wraps formatters in a `Proxy`.** Formatter instances
are constructed natively with default timezone options injected, preserving internal
engine brand slots and speeding up locale formatting in tight loops.
- **Daily offset caching.** Offsets are now verified across day boundaries ($t_0$ and $t_1$).
Constant days are cached in a single lookup, reducing cache churn by 24x compared to
hourly tracking.

### Added

- **Dynamic iframe trapping.** Scripts generating `about:blank` or `srcdoc` iframes
dynamically to read unpatched prototypes are now intercepted at the prototype layer:
accessing `HTMLIFrameElement.prototype.contentWindow` or `contentDocument` immediately
adopts and patches the child window before the caller receives it.
- **ECMA-262 compliant local-time math.** Ambiguous repeated and skipped hours across
daylight saving boundaries now strictly follow the ECMAScript specification, using the
offset in force prior to transition.
- **Chromium V8 `EquivalentYear` emulation.** `Date.prototype.toString()` output for
dates before 1970 and after 2038 now matches the engine's internal daylight label logic.
- **Cookie-aware challenge clearance.** Anti-bot challenge detection now monitors for
the `cf_clearance` cookie in addition to page transitions, immediately restoring protection
once a challenge is passed without waiting for arbitrary settle timeouts.
- **Explicit verification iframe exclusion.** Turnstile verification iframes are
strictly excluded from adoption, preventing verification spinner hangs.

### Removed

- **The Developer Mode / "Allow user scripts" prerequisite.** Early injection is now
the only path and is active for all users out of the box.

## 1.0.4 — 2026-08-27

Unresolved merge conflict markers had been committed into the shipped extension.

### Fixed

- **`LICENSE`, About panel, and popup styles showed raw `<<<<<<< HEAD` markers.**
A botched merge left conflict syntax in three files. Resolved in favour of the
GPL-3.0 licence and the open-source About text (GitHub link, GPL-3.0 link).

## 1.0.3 — 2026-08-15

The toolbar dot stops crying wolf, and inline Web Workers are covered on sites
that previously blocked every route into them.

### Fixed

- **Every site turned red a few seconds after it loaded.** Worker patching was
gated behind a probe that fires a throwaway `blob:` worker and waits for it to
report back. Until that round trip finished, every worker the page built took
the "not proven safe" branch and reported a leak — and most sites start a
worker a moment after load, for analytics or video or maps. The dot went green,
then red, on essentially everything. Worker coverage no longer turns on that
probe alone, and an uncovered worker no longer reports as a page leak.

### Changed

- **Workers are patched by how the page built them, not by what a probe says.**
A worker the page started *inline* — `new Worker(URL.createObjectURL(…))`, or
a `data:` URL — is now always covered, on every site. The page has just proved
`blob:` workers run there by minting one itself, so our replacement lands
inside the same allowance it did. A worker started from an ordinary URL is a
different matter: re-pointing it at a generated `blob:` is a change the site
never asked for, and where a Content-Security-Policy forbids that, the worker
does not fail quietly — it constructs, dies a moment later, and whatever it was
running disappears from the page. Those still wait on the probe, and where
`blob:` workers are refused they are passed through untouched.
- **Red on the toolbar dot now means the page itself.** An uncovered worker is a
real leak and still says so, in its own orange state — but it is a gap in one
corner of a page that is otherwise masked, and painting it the same red as "the
override never ran" told you nothing you could act on. Red is now reserved for
the hook never installing, or the mask being off for a bot check.

### Added

- **A fourth toolbar state: orange, *Masked · worker not covered*.** The page is
masked, but a Web Worker on it ran unmasked. Listed in **General ▸ Status dot**
alongside the other three.
- Inline workers are now covered even on sites with a strict CSP. Reading a
`blob:` URL's bytes at runtime means `fetch`, `XMLHttpRequest`, `importScripts`
or a `<script src>`, and a policy that allows `blob:` under `worker-src`
commonly refuses all four. The hook now keeps a weak reference to the `Blob`
itself as the page mints it, and prepends the override to it in memory, where
no policy directive applies.

## 1.0.2 — 2026-08-07

First public release, and the extension is now free software.

### Changed

- **Licence is now GPL-3.0.** Previously all rights reserved. An extension that
runs on every page you visit asks for a lot of trust, and the only honest
answer to *what is it doing?* is to let you read it. The source is at
<https://github.com/Valaciel/Gloam-Timezone-Extension>.

### Added

- A link to the source repository in **About**, next to the licence.
- `TRADEMARKS.md`. The code is GPL-3.0; the names *Valaciel* and *Gloam* and
the logo and icon set are not. Fork it freely under a name of your own.

## 1.0.1 — 2026-08-07 *(unreleased)*

The popup rebuilt around an icon rail, a Links panel for seeing what a page
actually talks to, and two brand themes.

### Added

- **Links panel.** Lists every domain the current tab has fetched from, grouped
by registrable domain, with one click to add the exact host, the whole domain
(`*.example.com`), or all of them to the allowlist or blocklist. The list is
read from the page's own Resource Timing entries in every frame, so it needs
no extra permission — at the cost of not seeing WebSocket or in-Worker
traffic.
- **Themes.** Gold (light) and Navy (dark), the app icon's own colours, or
*System* to follow the OS. Applies on click rather than on Save, and survives
`Reset` along with the site lists. A `localStorage` mirror of the choice lets
the popup paint in the right colours on the first frame instead of flipping a
frame later.
- **Status in the popup header.** The toolbar dot repeated next to the name, as
a coloured dot and a short label — green *Masked*, amber *Masked ·
unverified*, red *Real timezone leaked*, grey for off or out of scope — with
the full explanation on hover. **General ▸ Status dot** spells out what each
colour means.
- **Sidebar navigation.** Five sections — Zone, Sites, Links, General, About —
with one panel mounted at a time, so nothing you click makes the window grow.
- **`Temporal` coverage.** `Temporal.Now.timeZoneId()` and
`Temporal.Now.plainDateTimeISO()` are now overridden alongside `Date` and
`Intl`, in browsers that ship the API. Previously they reported the real zone
— the largest remaining hole in the mask.
- **A coloured dot on the toolbar icon**, telling you what actually happened on
the current tab rather than only what was configured.
- Styled scrollbars in the popup, in the current theme's ink rather than the
platform's default grey.
- `Asset/` is now tracked: the logo artwork and the palette both themes are
built from.

### Changed

- The per-tab coverage banner is gone. It spent three lines above every panel
saying what the toolbar dot already said in one dot; that verdict now lives in
the header status above.
- Toolbar and store icons redesigned, and re-exported smaller at every size.
- README covers the popup, the Links panel and the themes.
- **Bot checks are stepped around rather than masked.** A challenge page is in
the business of noticing the very inconsistency the mask creates, so masking
one could stop it passing and leave the tab reloading itself. The host is now
exempted for the duration of one challenge and remasked afterwards. This is
not a way around a bot check — a challenge caused by your IP and your reported
timezone disagreeing is the detection working as intended.

### Fixed

- **The fallback path was silently doing nothing on most large sites.** It
installed the hook through an inline `<script>`, which is governed by the
*page's* Content-Security-Policy, so any site whose CSP omits
`'unsafe-inline'` — most of them, now that nonces are standard — got no
override at all. The fallback now injects through `chrome.scripting` first,
which page CSP does not govern. This was long-standing; the new toolbar dot is
what made it visible.
- **The extension no longer announces itself to strict sites.** Attempting a
blocked inline script is not free: it fires a `securitypolicyviolation` event
at the page carrying a hash of the blocked code, telling the site an extension
was injecting into it. Inline is now a last resort for frames `chrome.scripting`
cannot reach.
- **A page could load unmasked after a bot check cleared.** The mask was
restored by reloading once the challenge was seen to be gone — but by then the
real site had already loaded and run its scripts against the real timezone,
and a reload does not take that back. It also tripped Chrome's "confirm form
resubmission" prompt, since challenges often clear via POST. The exemption is
now dropped as the challenge page unloads, so the next document is masked from
its first line, with no reload and no prompt.

### Removed

- The manual offset tweak on top of the chosen zone. A zone already carries its
own offset, DST included, and an offset laid over it produced a clock that
matched no real place — the exact inconsistency a bot check looks for.

## 1.0.0 — 2026-08-06 *(unreleased)*

The first working build. Recorded here after the fact — this file did not exist
yet — so it describes the feature set as it stood rather than what changed.

### Added

- **Timezone override.** Report any IANA timezone to every site, computed for
the moment being formatted, so DST is handled rather than frozen at a fixed
offset.
- **Both channels, together.** The zone *name*
(`Intl.DateTimeFormat().resolvedOptions().timeZone`) and the wall *clock*
(`Date.prototype.getTimezoneOffset`, `.getHours()`, `.toString()`) are patched
as a pair. Patching one and not the other is trivially detectable.
- **Web Worker coverage.** The same override is carried into workers, so a
worker cannot be used to read the real zone.
- **Random zone per tab**, as an alternative to a fixed choice.
- **Site rules.** Apply everywhere, only to an allowlist, or everywhere except
a blocklist. Entries are hostnames and cover subdomains; pasted URLs are
reduced to their hostname.
- **Master on/off toggle.**
- **Early injection.** Where the browser's *Allow user scripts* toggle is on,
settings are compiled into the script itself and registered through
`chrome.userScripts` to run in the page's own world at `document_start` —
nothing to await, so it lands before any page script. A content script serves
as the fallback when that toggle is off.
- No data collection, no external requests, no accounts.
