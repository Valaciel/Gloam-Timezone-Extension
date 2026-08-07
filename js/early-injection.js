/* globals settings, siteRules, installTimezoneHook */
'use strict';

/*
 * Early injection.
 * ================
 *
 * THE PROBLEM
 *
 * A content script cannot read extension storage synchronously, so the normal
 * path is: content script starts -> asks storage for the timezone -> waits ->
 * injects the hook. That wait is short, but it is not zero, and a page whose
 * very first inline script calls `new Date()` can read the real timezone
 * before the hook lands. The fallback path loses that race sometimes.
 *
 * THE FIX
 *
 * Bake the settings straight into the script. Chrome's userScripts API is the
 * only one that accepts a string of code (rather than a fixed file) and runs
 * it in the page's own world at document_start. Because the values are already
 * inside the code, there is nothing to wait for, and it always runs first.
 *
 * THE CATCH
 *
 * The API is off until the user turns on "Allow user scripts" for this
 * extension on chrome://extensions. Until they do, `chrome.userScripts` is
 * simply not there, and we fall back to the content script. The popup shows
 * which of the two is currently running.
 *
 * The registration is refreshed whenever settings change, because the
 * settings are compiled into the code and the site lists decide where it runs.
 */

var earlyInjection = {};

const SCRIPT_ID = 'gloam-timezone-hook';
const ALL_SITES = ['*://*/*'];

/**
 * Is the userScripts API usable right now?
 *
 * Presence of the property isn't enough - Chrome exposes it but throws on use
 * when the user hasn't granted the toggle, so we have to actually try a call.
 */
earlyInjection.isAvailable = () => {
    if (!chrome.userScripts) {
        return false;
    }
    try {
        const probe = chrome.userScripts.getScripts();
        // The call throws when the toggle is off, but swallow the promise too
        // so a rejection never surfaces as an unhandled error.
        if (probe && typeof probe.catch === 'function') {
            probe.catch(() => {});
        }
        return true;
    }
    catch (e) {
        return false;
    }
};

/**
 * Where the script should and shouldn't run.
 *
 * In allowlist mode we register only for the listed sites, so the hook is
 * never even delivered anywhere else. In blocklist mode we register
 * everywhere and exclude the listed sites.
 */
/**
 * Sites kept out regardless of the mode: bot-check hosts, and any site
 * currently sitting on a challenge we have stepped aside for.
 *
 * These have to be applied here as well as in siteRules.appliesTo. The early
 * script carries no site logic of its own - being registered for a page IS the
 * decision - so anything left out of excludeMatches gets masked whatever the
 * content script would have concluded.
 */
function alwaysExcluded(current) {
    return siteRules.toMatchPatterns([
        ...siteRules.ALWAYS_EXCLUDED,
        ...(current.challengeExemptions || []),
    ]);
}

function scopeFor(current) {
    const excluded = alwaysExcluded(current);

    if (current.siteMode === 'listed') {
        const patterns = siteRules.toMatchPatterns(current.allowlist);
        // An empty allowlist means "nowhere", and a registration needs at
        // least one match pattern, so there is nothing to register.
        return patterns.length ? { matches: patterns, excludeMatches: excluded } : null;
    }

    if (current.siteMode === 'blocked') {
        return {
            matches: ALL_SITES,
            excludeMatches: [...siteRules.toMatchPatterns(current.blocklist), ...excluded],
        };
    }

    return { matches: ALL_SITES, excludeMatches: excluded };
}

/** Removes the registration, ignoring "it wasn't registered" errors. */
async function unregister() {
    try {
        await chrome.userScripts.unregister({ ids: [SCRIPT_ID] });
    }
    catch (e) {
        // Nothing was registered, which is the state we wanted anyway.
    }
}

/**
 * Re-registers the early script to match the current settings.
 *
 * Returns true when early injection is active, false when we are relying on
 * the content script instead.
 */
earlyInjection.refresh = async () => {
    if (!earlyInjection.isAvailable()) {
        return false;
    }

    const current = await settings.read();

    /*
     * Random-per-tab can't work here: the code is compiled once and shared by
     * every page, so it cannot hand each tab a different zone. Those users get
     * the content-script path, which can ask the background per tab.
     */
    if (!current.enabled || current.randomPerTab) {
        await unregister();
        return false;
    }

    const scope = scopeFor(current);
    if (!scope) {
        await unregister();
        return false;
    }

    // The settings are frozen into the source at this moment. This is the
    // whole point: no storage read is needed at page load.
    const code = `(${installTimezoneHook})(${JSON.stringify(settings.toHookArguments(current))});`;

    const script = {
        id: SCRIPT_ID,
        matches: scope.matches,
        excludeMatches: scope.excludeMatches,
        js: [{ code }],
        runAt: 'document_start',
        allFrames: true,
        world: 'MAIN',
    };

    try {
        const existing = await chrome.userScripts.getScripts({ ids: [SCRIPT_ID] });
        if (existing.length) {
            await chrome.userScripts.update([script]);
        }
        else {
            await chrome.userScripts.register([script]);
        }
        return true;
    }
    catch (e) {
        // Registration can fail if the toggle was revoked between our check
        // and this call. The content script still covers the page.
        return false;
    }
};
