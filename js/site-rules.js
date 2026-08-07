'use strict';

/*
 * Site rules.
 * ===========
 *
 * Decides which sites the timezone override applies to. Shared by the
 * background service worker and the content script, so it must not assume
 * either environment.
 *
 * Three modes:
 *   "all"      - every site
 *   "listed"   - only sites on the allowlist
 *   "blocked"  - every site except those on the blocklist
 *
 * A list entry is a hostname. "example.com" covers example.com and all of its
 * subdomains; "*.example.com" is accepted as the same thing, since that is
 * what most people expect to be able to type.
 */

var siteRules = {};

siteRules.MODES = ['all', 'listed', 'blocked'];
siteRules.DEFAULT_MODE = 'all';

/*
 * Hosts we never touch, whatever the settings say.
 *
 * These serve nothing but bot checks, in an iframe, and a bot check is in the
 * business of noticing exactly the kind of inconsistency we create. Masking
 * them does not protect anything - the widget has no interest in you, only in
 * whether the browser is real - and it stops the check from passing, which
 * leaves the user staring at a page that never loads.
 */
siteRules.ALWAYS_EXCLUDED = [
    'challenges.cloudflare.com',
];

// Roughly the longest a hostname can legally be.
const MAX_HOSTNAME_LENGTH = 253;

// How many entries we will store per list, to keep a runaway paste or a
// corrupted import from filling up extension storage.
const MAX_LIST_LENGTH = 1000;

// Hostname characters: letters, digits, hyphen, dot, plus the non-ASCII range
// so international domain names survive.
//
// The range is written with \u escapes rather than literal characters on
// purpose. Its upper bound is U+FFFF, a Unicode noncharacter, and Chromium
// refuses to load a content script whose source contains one ("It isn't UTF-8
// encoded."), even though the bytes are well-formed UTF-8.
const HOSTNAME_PATTERN =
    /^[a-z0-9\u00a1-\uffff]([a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?(\.[a-z0-9\u00a1-\uffff]([a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?)*$/;

siteRules.isValidMode = mode => siteRules.MODES.includes(mode);

/**
 * Cleans up one list entry, or returns null if it isn't usable.
 *
 * Tolerant on purpose: people paste whole URLs out of the address bar, so
 * "https://user@www.example.com:8443/page?x=1" is accepted and reduced to
 * "www.example.com".
 */
siteRules.normaliseEntry = raw => {
    if (typeof raw !== 'string') {
        return null;
    }

    let entry = raw.trim().toLowerCase();
    if (!entry) {
        return null;
    }

    entry = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
    entry = entry.split('/')[0].split('?')[0].split('#')[0]; // path, query, fragment
    entry = entry.replace(/^[^@]*@/, '');                    // credentials
    entry = entry.replace(/:\d+$/, '');                      // port

    // "*.example.com" and "example.com" mean the same thing to us; keep the
    // wildcard the user typed so their list still reads the way they wrote it.
    const hasWildcard = entry.startsWith('*.');
    const hostname = hasWildcard ? entry.slice(2) : entry;

    if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH || !HOSTNAME_PATTERN.test(hostname)) {
        return null;
    }

    return hasWildcard ? '*.' + hostname : hostname;
};

/** Cleans a whole list: drops junk, removes duplicates, enforces the cap. */
siteRules.normaliseList = list => {
    if (!Array.isArray(list)) {
        return [];
    }

    const cleaned = new Set();
    for (const raw of list) {
        const entry = siteRules.normaliseEntry(raw);
        if (entry) {
            cleaned.add(entry);
        }
        if (cleaned.size >= MAX_LIST_LENGTH) {
            break;
        }
    }

    return [...cleaned];
};

/** Does this hostname match any entry in the list? Subdomains count. */
siteRules.hostMatches = (hostname, list) => {
    if (!hostname || !Array.isArray(list) || !list.length) {
        return false;
    }

    const host = hostname.toLowerCase();

    return list.some(raw => {
        if (typeof raw !== 'string') {
            return false;
        }
        const entry = raw.trim().toLowerCase().replace(/^\*\./, '');
        if (!entry) {
            return false;
        }
        return host === entry || host.endsWith('.' + entry);
    });
};

/** Should the override run on this hostname, given the current settings? */
siteRules.appliesTo = (hostname, settings) => {
    if (siteRules.hostMatches(hostname, siteRules.ALWAYS_EXCLUDED)) {
        return false;
    }

    /*
     * Sites where a bot check was seen looping. Rolled at every browser start,
     * so a site is never written off for good on the strength of one bad load.
     */
    if (siteRules.hostMatches(hostname, settings.challengeExemptions)) {
        return false;
    }

    const mode = siteRules.isValidMode(settings.siteMode) ? settings.siteMode : siteRules.DEFAULT_MODE;

    if (mode === 'listed') {
        return siteRules.hostMatches(hostname, settings.allowlist);
    }
    if (mode === 'blocked') {
        return !siteRules.hostMatches(hostname, settings.blocklist);
    }
    return true;
};

/**
 * Converts list entries into browser match patterns, for registering the
 * early-injection script against exactly the right sites.
 *
 * One entry becomes two patterns, because "*://*.example.com/*" matches the
 * subdomains but not example.com itself.
 */
siteRules.toMatchPatterns = list => {
    const patterns = new Set();

    for (const raw of siteRules.normaliseList(list)) {
        const hostname = raw.replace(/^\*\./, '');
        patterns.add(`*://${hostname}/*`);
        patterns.add(`*://*.${hostname}/*`);
    }

    return [...patterns];
};
