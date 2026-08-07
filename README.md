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

### Turn on "Allow user scripts"

On the extension's card in `chrome://extensions`, enable **Allow user scripts**.

This matters more than it sounds. It switches the extension from the fallback
path to the early-injection path — see below. The popup shows which one is
currently active.

## How injection works

There are three paths, tried in this order.

**Early injection (fast path, requires "Allow user scripts").** The settings are
compiled directly into a script string and registered through
`chrome.userScripts` to run in the page's own world at `document_start`. Since
the values are already inside the code, there is nothing to await, so it always
runs before any page script. See [`js/early-injection.js`](js/early-injection.js).

**Content script (fallback).** Runs at `document_start` in the isolated world,
reads settings from storage, then asks the background to place the hook through
`chrome.scripting` with `world: 'MAIN'`. Reading storage is asynchronous, so a
page whose first inline script reads the clock immediately can win the race. See
[`data/content-script.js`](data/content-script.js).

**Inline `<script>` (last resort).** Faster than the above — no round trip — but
it is only tried when `chrome.scripting` could not reach the frame. An inline
script added by a content script is governed by the **page's** CSP, and there is
no way to ask a page whether it allows one except by trying: a blocked attempt
is logged to the page's console *and* fires a `securitypolicyviolation` event at
the page, carrying a hash of the blocked code. On a strict site that happens
every load and tells the site an extension is injecting into it — so this is
last, not first.

Whichever lands first wins; the hook's install guard makes later attempts
no-ops.

## Bot checks

A bot check is in the business of noticing exactly the inconsistency this
extension creates, so masking one stops it from ever passing and the page
reloads itself forever. The extension steps out of the way instead:

1. Challenge detected on a masked page → exempt the host, reload
2. Challenge passes, unmasked
3. The challenge page **unloads** → drop the exemption, no reload
4. The next document is masked from its first line

Only step 1 reloads, and that matters. The obvious way to write step 3 — wait
for the next page, see that the challenge is gone, then reload with the mask
back on — is wrong twice over. By the time you can see the challenge is gone,
the real site has already loaded and run its scripts unmasked, and reloading
does not take that back. And a challenge is often cleared by a POST, so the
reload makes Chrome ask the user to confirm resubmitting the form.

Dropping the exemption on `pagehide` avoids both: it happens before the next
document exists, so that document is covered from the start with no reload and
nothing leaked.

There is still a safety net for the case where the challenge clears without the
document ever unloading. That one *is* a leak, it cannot be undone, and it is
reported as a red dot saying so rather than papered over with a reload.

The exemption lasts for one challenge, not for the session. If a site
challenges again *after* step 4, the cycle is not restarted — the host is left
unmasked for the rest of the session, because the alternative is a tab that
reloads forever. Everything is cleared at browser start, so no site is written
off for good.

`challenges.cloudflare.com` is never masked at all. It is the iframe the widget
runs in, it has no interest in you beyond whether the browser is real, and
masking it only breaks the check.

This is **not** a way around a bot check, and it does not try to be. If a site
challenges you because your IP and your reported timezone disagree, that is the
detection working; the fix is a matching VPN exit, or leaving the site out of
scope.

## Reading the dot

A small dot in the top-right corner of the toolbar icon, per tab. The popup
carries the same dot in its header, next to the name, with a one-line label —
*Masked*, *Masked · unverified*, *Real timezone leaked* — and the full sentence
on hover. The colours are written out under **General ▸ Status dot**.

| Dot | Meaning |
| --- | --- |
| 🟢 green | **Masked.** The hook was already in place before the content script ran, so it beat the page's own scripts. |
| 🟠 amber | **Masked, not verified.** The hook is installed, but *we* installed it from the content script after an async storage read. A script at the top of the page could have read the clock first — we cannot tell whether one did. |
| 🔴 red | **Leaked.** Something definitely saw the real timezone: the hook never installed, or a worker had to run unpatched. |
| none | Not covering this page by design — override off, or the site is out of scope. |

Green versus amber is the whole point of having three states. "We injected the
hook" is not the same claim as "nothing read the clock before us", and a privacy
tool that blurs the two is lying to its user. In practice, turning on "Allow
user scripts" is what turns amber into green.

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

Honest list. None of these are common, but they are real. The first two are the
ones the dot exists to tell you about.

- **The fallback path loses races.** Without "Allow user scripts", a page that
  reads the clock in its very first inline script can see the real timezone.
  This is the default state of a fresh install, and it is the single biggest
  reason to enable the toggle. Shows as an amber dot.
- **Workers on strict-CSP sites.** Hooked workers are booted from a generated
  `blob:` URL. Where a Content-Security-Policy forbids `blob:` workers, the
  extension falls back to the page's original worker, which sees the real
  timezone. Keeping the site working is preferred over breaking it. Shows as a
  red dot.
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
  background.js         wiring: settings changes -> re-registration
  settings.js           storage schema, defaults, migration
  site-rules.js         allowlist/blocklist matching (shared)
  early-injection.js    userScripts registration (fast path)
  tab-status.js         the coloured dot on the toolbar icon
  tab-connections.js    asks a tab's frames which hosts they fetched from
  timezone-info.js      zone lookup and labels
data/
  timezone-hook.js      the hook itself — patches Date, Intl and Temporal
  content-script.js     fallback injection path
  connections.js        per-frame tally of hosts the page loaded from
  offsets.js            IANA zone table
  popup/                popup UI — one file per section of the side nav
  icons/
_locales/en/            extension name and description
```

`data/timezone-hook.js` only *defines* `installTimezoneHook`; it never runs on
its own. Three places load it: the background (as a registered user script), the
content script (as the fallback), and the hook itself (inside each Web Worker).
Because of the worker case it must never touch `document`.

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
| `userScripts` | Early injection at `document_start` |
| `scripting` | Reaching pages whose CSP blocks the inline fallback |
| `*://*/*` host access | The hook has to run on the sites you visit |

No data leaves your machine. Note what is *not* here: the Links panel reads what
each page already knows about its own subresources, so listing a tab's
connections needs no `webRequest` and adds no permission at all.

## License

Free software under the [GNU General Public License v3.0](LICENSE). An
extension that runs on every page you visit asks for a lot of trust, and the
only honest answer to *what is it doing?* is to let you read it.

The names **Valaciel** and **Gloam**, and the logo and icon set, are trademarks
and are not covered by that licence — fork the code freely, under a name of
your own. See [TRADEMARKS.md](TRADEMARKS.md).

Copyright © 2020–2026 Valaciel.
