/* globals timezoneInfo, siteRules */
'use strict';

/*
 * Settings.
 * =========
 *
 * The one place that reads and writes extension storage. Everything arriving
 * from the popup is validated here, so no other file has to wonder whether a
 * stored value is trustworthy.
 *
 * What we keep:
 *   timezone        the chosen IANA name, e.g. "America/New_York"
 *   offset          minutes east of UTC that we report (daylight included)
 *   naturalOffset   what the offset would be without a manual tweak
 *   zoneLabels      { standard, daylight } fallback names
 *   enabled         master on/off
 *   randomPerTab    give every tab a different zone
 *   siteMode        "all" | "listed" | "blocked"
 *   allowlist       hostnames, used when siteMode is "listed"
 *   blocklist       hostnames, used when siteMode is "blocked"
 *   theme           "system" | "light" | "dark", for the popup's colours
 *   statusChannel   random attribute name the hook reports through
 */

var settings = {};

const DEFAULT_TIMEZONE = 'Etc/GMT';

// Light is Gold, dark is Navy; see the palettes at the top of popup.css.
const THEMES = ['system', 'light', 'dark'];

/**
 * A fresh name for the attribute the hook uses to tell the content script
 * whether it got there in time (see the status section of the hook).
 *
 * Random, and rolled once per browser session, so that a page cannot watch for
 * a name it knew in advance. Both sides read it from storage, so they always
 * agree on what this session's name is.
 */
function newStatusChannel() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return 'data-' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Looks like something newStatusChannel() produced? */
function isStatusChannel(value) {
    return typeof value === 'string' && /^data-[0-9a-f]{16}$/.test(value);
}

// A day either way is far more than any real zone needs, but it leaves room
// for deliberate nonsense without letting a bad value break date maths.
const MAX_OFFSET_MINUTES = 24 * 60;

/** Everything, with defaults filled in for anything not yet stored. */
settings.read = async () => {
    const stored = await chrome.storage.local.get();

    return {
        timezone: timezoneInfo.isKnown(stored.timezone) ? stored.timezone : DEFAULT_TIMEZONE,
        offset: Number.isFinite(stored.offset) ? stored.offset : 0,
        naturalOffset: Number.isFinite(stored.naturalOffset) ? stored.naturalOffset : 0,
        zoneLabels: stored.zoneLabels || { standard: 'GMT', daylight: 'GMT' },
        enabled: stored.enabled !== false,
        randomPerTab: stored.randomPerTab === true,
        siteMode: siteRules.isValidMode(stored.siteMode) ? stored.siteMode : siteRules.DEFAULT_MODE,
        allowlist: Array.isArray(stored.allowlist) ? stored.allowlist : [],
        blocklist: Array.isArray(stored.blocklist) ? stored.blocklist : [],
        theme: THEMES.includes(stored.theme) ? stored.theme : 'system',

        challengeExemptions: Array.isArray(stored.challengeExemptions)
            ? stored.challengeExemptions
            : [],

        // Deliberately not regenerated on a miss: a value that differed
        // between two reads would leave the two sides talking past each other.
        // An empty string just means "don't report", which costs us the dot
        // and nothing else.
        statusChannel: isStatusChannel(stored.statusChannel) ? stored.statusChannel : '',
    };
};

/**
 * The values the hook needs, in the order it expects them:
 *   [ timezone name, offset to report, this machine's real offset, zone label,
 *     worker base URL, status channel ]
 *
 * The fifth slot is only ever filled in by the hook itself when it re-injects
 * into a worker, so it is null here.
 *
 * The offset is negated because storage keeps "minutes east of UTC" (the way
 * people read timezones) while getTimezoneOffset() uses the opposite sign.
 */
settings.toHookArguments = current => {
    const label = current.offset === current.naturalOffset && current.zoneLabels.standard
        ? current.zoneLabels.standard
        : current.zoneLabels.daylight;

    return [
        current.timezone,
        -1 * current.offset,
        (new Date()).getTimezoneOffset(),
        label || 'GMT',
        null,
        current.statusChannel || '',
    ];
};

/**
 * Works out and stores everything that follows from a timezone choice.
 *
 * `manualAdjustment` carries across any hand-edited offset, so re-resolving
 * the zone (on browser start, or after a daylight saving change) doesn't
 * silently throw the user's tweak away.
 */
settings.applyTimezone = async (timezoneName = DEFAULT_TIMEZONE, manualAdjustment = 0) => {
    const description = timezoneInfo.describe(timezoneName);
    const offset = description.offset + manualAdjustment;

    await chrome.storage.local.set({
        timezone: timezoneInfo.isKnown(timezoneName) ? timezoneName : DEFAULT_TIMEZONE,
        offset: Math.max(-MAX_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, offset)),
        naturalOffset: description.offset,
        zoneLabels: description.baseline.labels,
    });
};

/**
 * Saves what the popup sent. Everything is checked: an unknown timezone falls
 * back to GMT, a silly offset is clamped, an unknown mode becomes "all", and
 * host lists are cleaned of anything that isn't a hostname.
 *
 * Returns what was actually stored, so the popup can show the user the real
 * result rather than what they typed.
 */
settings.save = async input => {
    const submitted = input && typeof input === 'object' ? input : {};

    const timezone = timezoneInfo.isKnown(submitted.timezone) ? submitted.timezone : DEFAULT_TIMEZONE;
    const description = timezoneInfo.describe(timezone);

    let offset = Number(submitted.offset);
    if (!Number.isFinite(offset)) {
        offset = description.offset;
    }
    offset = Math.max(-MAX_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, Math.round(offset)));

    const stored = {
        timezone,
        offset,
        naturalOffset: description.offset,
        zoneLabels: description.baseline.labels,
        enabled: submitted.enabled !== false,
        randomPerTab: submitted.randomPerTab === true,
        siteMode: siteRules.isValidMode(submitted.siteMode) ? submitted.siteMode : siteRules.DEFAULT_MODE,
        allowlist: siteRules.normaliseList(submitted.allowlist),
        blocklist: siteRules.normaliseList(submitted.blocklist),
    };

    await chrome.storage.local.set(stored);
    return stored;
};

/**
 * The popup's colours.
 *
 * Stored on its own, not through save(), because it takes effect the moment it
 * is clicked - waiting for Save to change what you are looking at would be a
 * strange thing to ask. Nothing about masking depends on it.
 */
settings.saveTheme = async value => {
    const theme = THEMES.includes(value) ? value : 'system';
    await chrome.storage.local.set({ theme });
    return theme;
};

/* ------------------------------------------------------- bot checks --- *
 *
 * A bot check is in the business of noticing exactly the inconsistency we
 * create, so masking one stops it from ever passing and the user is left on a
 * page that reloads itself forever. The answer is to step out of the way for
 * the challenge and step back in once it has passed:
 *
 *   1. challenge seen on a masked page  -> exempt the host, reload
 *   2. challenge passes, unmasked
 *   3. challenge gone                   -> drop the exemption, reload
 *   4. masked again, and the site's clearance cookie keeps it that way
 *
 * Step 3 is the whole point - the exemption is meant to last for one challenge,
 * not for the session. But if the site challenges us AGAIN after step 4 we must
 * not start over, or the tab reloads forever, so a host that has been round
 * once is remembered and left unmasked for the rest of the session.
 * ---------------------------------------------------------------------- */

/** True if the caller should now reload, i.e. this actually changed something. */
settings.exemptFromChallenge = async hostname => {
    const host = siteRules.normaliseEntry(hostname);
    if (!host) {
        return false;
    }

    const stored = await chrome.storage.local.get(['challengeExemptions']);
    const current = Array.isArray(stored.challengeExemptions) ? stored.challengeExemptions : [];

    if (siteRules.hostMatches(host, current)) {
        return false;
    }

    await chrome.storage.local.set({
        challengeExemptions: siteRules.normaliseList([...current, host]),
    });
    return true;
};

/** The other half: the challenge is over, so put the mask back. */
settings.remaskAfterChallenge = async hostname => {
    const host = siteRules.normaliseEntry(hostname);
    if (!host) {
        return false;
    }

    const stored = await chrome.storage.local.get(['challengeExemptions', 'challengeCycled']);
    const current = Array.isArray(stored.challengeExemptions) ? stored.challengeExemptions : [];
    const cycled = Array.isArray(stored.challengeCycled) ? stored.challengeCycled : [];

    if (!siteRules.hostMatches(host, current)) {
        return false;
    }

    /*
     * We have already put the mask back on this host once and it challenged us
     * again. Trying a second time would just start the cycle over, so leave it
     * unmasked and let the user browse.
     */
    if (siteRules.hostMatches(host, cycled)) {
        return false;
    }

    await chrome.storage.local.set({
        challengeExemptions: current.filter(entry => !siteRules.hostMatches(host, [entry])),
        challengeCycled: siteRules.normaliseList([...cycled, host]),
    });
    return true;
};

/**
 * Back to defaults - except the site lists, which are the one thing that is
 * laborious to retype and that nobody expects "Reset" to destroy, and the
 * theme, which is not a masking setting and has no business changing because
 * someone reset their timezone.
 */
settings.reset = async () => {
    const stored = await chrome.storage.local.get(['siteMode', 'allowlist', 'blocklist', 'theme']);

    await chrome.storage.local.clear();
    await chrome.storage.local.set({
        siteMode: siteRules.isValidMode(stored.siteMode) ? stored.siteMode : siteRules.DEFAULT_MODE,
        allowlist: siteRules.normaliseList(stored.allowlist),
        blocklist: siteRules.normaliseList(stored.blocklist),
        theme: THEMES.includes(stored.theme) ? stored.theme : 'system',

        // Cleared along with everything else a moment ago, and both sides need
        // one, so mint a replacement rather than leaving it blank.
        statusChannel: newStatusChannel(),
    });
    await settings.applyTimezone(DEFAULT_TIMEZONE);
};

/**
 * Brings storage up to date on install and on every browser start.
 *
 * Also re-resolves the timezone each time, so an offset stored before a
 * daylight saving changeover doesn't sit there being an hour wrong.
 */
settings.refresh = async () => {
    const stored = await chrome.storage.local.get();
    const patch = {};

    // Key names used before 1.0.1.
    if (stored.timezone === undefined && typeof stored.location === 'string') {
        patch.timezone = stored.location;
    }
    if (stored.siteMode === undefined && siteRules.isValidMode(stored.allowlistMode)) {
        patch.siteMode = stored.allowlistMode;
    }
    if (stored.randomPerTab === undefined && stored.random !== undefined) {
        patch.randomPerTab = stored.random === 'true' || stored.random === true;
    }
    if (stored.zoneLabels === undefined && (stored.standard || stored.daylight)) {
        patch.zoneLabels = { standard: stored.standard, daylight: stored.daylight };
    }
    if (!siteRules.isValidMode(stored.siteMode) && patch.siteMode === undefined) {
        patch.siteMode = siteRules.DEFAULT_MODE;
    }
    if (!Array.isArray(stored.allowlist)) {
        patch.allowlist = [];
    }
    if (!Array.isArray(stored.blocklist)) {
        patch.blocklist = [];
    }

    // Rolled every browser start, which is what makes it a session secret.
    patch.statusChannel = newStatusChannel();

    // Likewise cleared every browser start: a site that tripped a bot check
    // once should get another chance next time, not be written off for good.
    patch.challengeExemptions = [];
    patch.challengeCycled = [];

    if (Object.keys(patch).length) {
        await chrome.storage.local.set(patch);
    }

    const retired = ['location', 'allowlistMode', 'random', 'standard', 'daylight', 'isDST']
        .filter(key => stored[key] !== undefined);
    if (retired.length) {
        await chrome.storage.local.remove(retired);
    }

    const timezone = patch.timezone || stored.timezone;
    const manualAdjustment = Number.isFinite(stored.offset) && Number.isFinite(stored.naturalOffset)
        ? stored.offset - stored.naturalOffset
        : 0;

    await settings.applyTimezone(
        timezoneInfo.isKnown(timezone) ? timezone : DEFAULT_TIMEZONE,
        manualAdjustment,
    );
};
