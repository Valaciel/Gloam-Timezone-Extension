# Gloam Timezone Extension

Override the timezone your browser reports to websites. Everything happens
locally — no tracking, no external requests, no accounts.

Sites read your timezone through two channels, and they must never disagree:

| Channel | Example |
| --- | --- |
| The zone **name** | `Intl.DateTimeFormat().resolvedOptions().timeZone`, `Temporal.Now.timeZoneId()` |
| The wall **clock** | `new Date().getTimezoneOffset()`, `.getHours()`, `.toString()`, `Temporal.Now.plainDateTimeISO()` |

Patching only one is trivially detectable, so this extension patches both,
through both `Date`/`Intl` and `Temporal`, and carries the same lie into Web
Workers.

## Features

- A coloured dot on the toolbar icon telling you what actually happened on the
  current tab — see [Reading the dot](#reading-the-dot).
- Pick any IANA timezone, or let the extension pick a random one per tab.
- Site rules: apply everywhere, only to an allowlist, or everywhere except a
  blocklist. Entries are hostnames and cover subdomains; pasted URLs are
  accepted and reduced to their hostname.
- A **Links** panel listing every domain the current tab has actually fetched
  from, grouped by owner, with one click to put the exact host, the whole domain
  (`*.example.com`) or all of them onto either list — see
  [Seeing what a page connects to](#seeing-what-a-page-connects-to).
- Master on/off toggle.
- Two brand themes — Gold (light) and Navy (dark) — or follow the system.
- DST-aware: the offset is computed for the moment being formatted, not fixed.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked**, and select this folder.

Early injection runs natively out of the box at `document_start` on Chromium 111+ without requiring special toggles or elevated permissions.

## How injection works

Gloam uses a two-tier architecture combining native Chromium Manifest V3 declarative injection with an isolated-world configuration bridge:

1. **Native Main-World Injection ([`data/timezone-hook.js`](data/timezone-hook.js)).**
   Declared statically in `manifest.json` under `content_scripts` with `"world": "MAIN"` at `document_start`. The browser engine guarantees it executes in the page context before any inline or external page script can run.
   - **In-place prototype patching**: Mutates methods directly on `Date.prototype` rather than replacing `Date` with a subclass. Reuses a single static `scratch` Date object for all getters, ensuring strictly $O(1)$ memory overhead with zero extra object allocations.
   - **ECMA-262 compliance**: All local-time math flows through `offsetAt(t)` and `localToUTC(L)` adhering to the ECMAScript specification for daylight saving transitions. Local setters delegate to native `setUTC*` methods on local fields.
   - **Dynamic iframe trapping**: Traps `HTMLIFrameElement.prototype.contentWindow` and `contentDocument` via prototype getters (`adopt`), ensuring scripts that dynamically mint `about:blank` or `srcdoc` iframes never see unpatched native prototypes.
   - **Clean `Intl.DateTimeFormat`**: Injects default timezone options into constructor arguments without wrapping formatters in a `Proxy`, preserving internal V8 brand slots.

2. **Isolated-World Bridge ([`data/content-script.js`](data/content-script.js)).**
   Runs at `document_start` in the extension's isolated world where it can safely access extension storage and APIs.
   - Reads stored settings and evaluates site rules (allowlist, blocklist, or all sites).
   - Monitors for anti-bot challenges and temporarily steps aside so challenge widgets pass cleanly.
   - Dispatches verified settings to the main-world hook via custom window events (`__gloam_tz_cfg` and `__gloam_tz_req`).
   - Listens to `chrome.storage.onChanged` to forward settings edits live across all open tabs and child frames without requiring a page reload.

3. **Zero CSP Friction.**
   Because injection is handled declaratively by Chromium's manifest engine, page Content Security Policies (`script-src`) cannot block the hook. No inline `<script>` tags or `chrome.scripting` round-trips are needed.

## Bot checks

A bot check is in the business of noticing exactly the inconsistency this
extension creates, so masking one stops it from ever passing and the page
reloads itself forever. The extension steps out of the way instead:

1. Challenge detected on a masked page → exempt the host, reload
2. Challenge passes, unmasked
3. Challenge resolution or `cf_clearance` cookie detected → drop the exemption, no reload
4. The next document is masked from its first line

Only step 1 reloads, and that matters. The exemption is dropped the moment
clearance is verified (via `cf_clearance` cookie acquisition or on `pagehide`
as the challenge page unloads), so the next document is masked from its first
line with no reload and no form-resubmission prompts.

`challenges.cloudflare.com` and challenge platform verification frames are
strictly excluded from adoption at the prototype layer, preventing verification
spinner hangs while keeping the rest of the page protected.

This is **not** a way around a bot check, and it does not try to be. If a site
challenges you because your IP and your reported timezone disagree, that is the
detection working; the fix is a matching VPN exit, or leaving the site out of
scope.

## Reading the dot

A small dot in the top-right corner of the toolbar icon, per tab. The popup
carries the same dot in its header, next to the name, with a one-line label —
*Masked*, *Masked · unverified*, *Masked · worker not covered*, *Real timezone
leaked* — and the full sentence on hover. The colours are written out under
**General ▸ Status dot**.

| Dot | Meaning |
| --- | --- |
| 🟢 green | **Masked.** The hook was already in place before the content script ran, so it beat the page's own scripts. |
| 🟡 amber | **Masked, not verified.** The hook is installed, but *we* installed it from the content script after an async storage read. A script at the top of the page could have read the clock first — we cannot tell whether one did. |
| 🟠 orange | **Worker not covered.** The page itself is masked, but a Web Worker on it ran unmasked. This site's policy blocks the only way we can reach into one, and reaching in anyway would have stopped the worker running at all. |
| 🔴 red | **Leaked.** The page itself saw the real timezone: the hook never installed, or the mask was off for a bot check. |
| none | Not covering this page by design — override off, or the site is out of scope. |

Green versus amber is the whole point of having the first two states. "We
injected the hook" is not the same claim as "nothing read the clock before us",
and a privacy tool that blurs the two is lying to its user. With native
declarative injection at `document_start`, the hook is guaranteed to be in place
before the page's own scripts run, reliably earning a green dot.

Red is reserved for the page's own world. An uncovered worker is a real leak and
gets its own colour to say so, but it is a gap in one corner of a page that is
otherwise masked — and almost every site starts a worker sooner or later, so
painting that the same red as "the override never ran" told you nothing you
could act on.

Frames report independently and the worst answer in a tab wins — a leak in an ad
iframe is still a leak.

**How the status gets out of the page.** The hook runs in the page's world and
the content script in the extension's isolated world; neither can see the
other's variables. They pass the verdict through an attribute on `<html>`, whose
name is a random value the extension rolls each browser session and hands to
both sides, so a page cannot watch for a name it knows in advance. The content
script removes the attribute as soon as it reads it. A determined page could
still catch it with a `MutationObserver`; the alternative was not being able to
tell you when the extension failed, which seemed worse.

## The popup

Five sections down an icon rail — Zone, Sites, Links, General, About — with one
panel mounted at a time. The window is a fixed size and nothing you click makes
it grow, which is why Advanced stopped being an expanding `<details>`.

There is exactly **one** scrolling surface, the panel area. Panels are plain
content that runs as long as it needs to; nothing inside them scrolls on its own,
because a scroll box inside a scroll box never tells you which one your wheel is
about to move.

**General** carries the theme: *Light* is Gold (warm cream, navy accent — the app
icon's own background), *Dark* is Navy (the logo's colours worn as a skin, gold
accent), and *System* follows the OS between the two. Both palettes come from
[`Asset/theme-color.md`](Asset/theme-color.md).

The theme applies on click rather than on Save — making someone press Save to see
their own colours would be strange — and it is the one setting `Reset` leaves
alone along with the site lists. It is stored like everything else, but also
mirrored into `localStorage`, which an extension page can read *synchronously*.
That mirror is what lets [`popup-theme.js`](data/popup/popup-theme.js) run from
`<head>` and set the theme before the first paint, instead of opening in the
wrong colours and flipping a frame later.

## Seeing what a page connects to

Opening `youtube.com` loads code from `ytimg.com`, `googlevideo.com`,
`ggpht.com`, `doubleclick.net` and several more. The address bar shows one name;
the page talks to a dozen, and each one of them runs in your browser with its own
view of your clock. Site rules are only useful if you know what is actually on
the page, so the **Links** panel shows the real list for the current tab.

Each domain can be added to the allowlist or blocklist three ways:

| Button | Adds | Means |
| --- | --- | --- |
| `Add` | `i-1.ytimg.com` | this exact server |
| `*.domain` | `*.ytimg.com` | this company, all of it |
| Add everything | every domain listed | whatever this page uses |

Nothing is stored until **Save**, so closing the popup undoes a misclick.

The list comes from the page's own [Resource Timing][rt] entries, read in every
frame by [`data/connections.js`](data/connections.js) and merged by
[`js/tab-connections.js`](js/tab-connections.js). That is a deliberate choice
over the `webRequest` API, which would have meant asking for a permission that
lets the extension see every URL the browser fetches — too much to ask of
someone installing a privacy tool. The cost is that WebSocket traffic and
requests made from inside a Web Worker do not appear, since neither is recorded
on the document's timeline.

Domains are grouped by their registrable domain, using a short built-in list of
two-label suffixes so `news.bbc.co.uk` groups under `bbc.co.uk` rather than
offering you `*.co.uk`. It is an approximation of the Public Suffix List, not a
copy of it; a miss costs an odd-looking grouping, and never a broader entry than
the one clicked, because the per-host button is always exact.

[rt]: https://developer.mozilla.org/docs/Web/API/Performance_API/Resource_timing

## Known leaks

Honest list. None of these are common, but they are real.

- **URL-based workers on strict-CSP sites.** A worker started from an ordinary
  URL can only be hooked by re-pointing it at a generated `blob:` URL — a change
  the site never asked for. Where a Content-Security-Policy forbids `blob:`
  workers that does not fail quietly: the worker constructs, dies a moment
  later, and whatever it was running disappears from the page. So the rewrite
  waits on a probe that says `blob:` workers run at all here, and where they do
  not, the worker is passed through and sees the real timezone. Shows as an
  orange dot.

  Workers the page itself started inline — `new Worker(URL.createObjectURL(…))`
  or a `data:` URL — are always covered, on every site. The page has just proved
  `blob:` workers are allowed by minting one, and the hook is prepended to the
  original `Blob` in memory rather than fetched, so no CSP directive is in play.
- **A hand-edited offset does not reach `Temporal`.** `Temporal` is told the
  zone name, not the adjustment, so it reports that zone's real offset. Picking
  a zone rather than typing an offset avoids this entirely.
- **Sites you excluded.** In `listed` / `blocked` mode, uncovered sites see the
  truth by design.
- **Not a timezone channel, but still a mismatch.** Your IP geolocation and
  `Accept-Language` are untouched. A site that cross-references them against the
  reported zone will notice the inconsistency.

## Project layout

```
manifest.json           MV3 manifest
js/
  bg-worker.js          service worker entry
  background.js         wiring: settings changes -> status & challenge updates
  settings.js           storage schema, defaults, migration
  site-rules.js         allowlist/blocklist matching (shared)
  tab-status.js         the coloured dot on the toolbar icon
  tab-connections.js    asks a tab's frames which hosts they fetched from
  timezone-info.js      zone lookup and labels
data/
  timezone-hook.js      main-world hook — patches Date, Intl, Temporal, and dynamic iframes
  content-script.js     isolated-world bridge — evaluates site rules and challenge status
  connections.js        per-frame tally of hosts the page loaded from
  offsets.js            IANA zone table
  popup/                popup UI — one file per section of the side nav
  icons/
_locales/en/            extension name and description
```

`data/timezone-hook.js` runs in the page's `MAIN` world at `document_start`,
installing in-place prototype traps before any page script executes.
`data/content-script.js` acts as an isolated-world bridge, querying extension
storage and dispatching configuration events to the hook.

## Development notes

- Source files must stay free of Unicode noncharacters (`U+FFFE`, `U+FFFF`) and
  lone surrogates. Chromium's UTF-8 validator rejects them and refuses to load
  the file with *"It isn't UTF-8 encoded"*, even though the bytes are well-formed
  UTF-8. Write such ranges as `\u` escapes — see the hostname pattern in
  [`js/site-rules.js`](js/site-rules.js).
- Files should be UTF-8 without BOM, and preferably ASCII-only.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save your settings |
| `<all_urls>` host access | The hook has to run on the sites you visit |

No data leaves your machine. Note what is *not* here: the extension requires
zero elevated scripting permissions (`scripting` and `userScripts` are not needed),
and the Links panel reads what each page already knows about its own subresources
without needing `webRequest`.

## License

Free software under the [GNU General Public License v3.0](LICENSE). An
extension that runs on every page you visit asks for a lot of trust, and the
only honest answer to *what is it doing?* is to let you read it.

The names **Valaciel** and **Gloam**, and the logo and icon set, are trademarks
and are not covered by that licence — fork the code freely, under a name of
your own. See [TRADEMARKS.md](TRADEMARKS.md).

Copyright © 2020–2026 Valaciel.
