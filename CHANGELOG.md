# Changelog

All notable changes to the Gloam Timezone Extension are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

<<<<<<< HEAD
1.0.2 is the first public version. The two entries below it are development
history, kept because the code they describe is what you are reading; neither
was ever distributed. Early commits carry `1.0.1` in the manifest throughout —
the numbering was settled when this file was written, and 1.0.0 is what that
first build is called here.

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
=======
## 1.0.1 — 2026-08-07

The popup rebuilt around an icon rail, a Links panel for seeing what a page
actually talks to, and two brand themes. The extension version is unchanged.
>>>>>>> 2e93fd1 (Say the coverage state in the header, and stop shouting it over every panel)

### Added

- **Links panel.** Lists every domain the current tab has fetched from, grouped
<<<<<<< HEAD
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
=======
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
- Styled scrollbars in the popup, in the current theme's ink rather than the
  platform's default grey.
- `Asset/` is now tracked: the logo artwork and the palette both themes are
  built from.
>>>>>>> 2e93fd1 (Say the coverage state in the header, and stop shouting it over every panel)

### Changed

- The per-tab coverage banner is gone. It spent three lines above every panel
<<<<<<< HEAD
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
=======
  saying what the toolbar dot already said in one dot; that verdict now lives in
  the header status above.
- Toolbar and store icons redesigned, and re-exported smaller at every size.
- README covers the popup, the Links panel and the themes.

### Removed

- The 42 translated `_locales` bundles, which only ever held the extension name
  and description while the interface itself was English throughout. `en`
  remains.
- The manual offset tweak on top of the chosen zone. A zone already carries its
  own offset, DST included, and an offset laid over it produced a clock that
  matched no real place — the exact inconsistency a bot check looks for.

---

Earlier work — the initial 1.0.1 release and the masking fixes that followed —
predates this file and is recorded in the commit history.
>>>>>>> 2e93fd1 (Say the coverage state in the header, and stop shouting it over every panel)
