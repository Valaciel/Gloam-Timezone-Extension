/* globals siteRules, installTimezoneHook */
'use strict';

/*
 * Content script - the fallback path.
 * ===================================
 *
 * Runs in every frame at document_start, in the extension's isolated world.
 * Its job is to get the hook into the page's own world.
 *
 * This is the SECOND choice. When "Allow user scripts" is enabled, the
 * background registers the hook to run before any page code at all (see
 * js/early-injection.js) and this script finds the work already done - the
 * hook's own guard makes the second attempt a no-op.
 *
 * We keep this path because that toggle is off by default, and covering a page
 * a moment late is much better than not covering it.
 *
 * The unavoidable weakness: reading settings from storage is asynchronous, so
 * a page whose first inline script reads the clock immediately can beat us to
 * it. That gap is exactly what early injection exists to close.
 */

const SETTING_KEYS = [
    'timezone', 'offset', 'naturalOffset', 'zoneLabels',
    'enabled', 'randomPerTab',
    'siteMode', 'allowlist', 'blocklist',
    'statusChannel', 'challengeExemptions',
];

/*
 * Telltales of an interstitial bot check.
 *
 * The first is the reliable one - it is in the initial HTML of every Cloudflare
 * challenge - and the rest are the wrappers those pages put their widget in.
 * Being wrong in either direction costs at most one reload, so this errs
 * towards recognising a challenge rather than missing one.
 */
const CHALLENGE_MARKERS = [
    'script[src*="/cdn-cgi/challenge-platform/"]',
    '#challenge-form',
    '#challenge-running',
    '#cf-challenge-running',
    'iframe[src*="challenges.cloudflare.com"]',
];

/** How long to let a challenge render before deciding it is not there. */
const CHALLENGE_SETTLE_MS = 2000;

function looksLikeChallenge() {
    return CHALLENGE_MARKERS.some(selector => {
        try {
            return document.querySelector(selector) !== null;
        }
        catch (e) {
            return false;
        }
    });
}

function tellBackground(request) {
    try {
        chrome.runtime.sendMessage({ request }, () => {
            void chrome.runtime.lastError;
        });
    }
    catch (e) {
        // Extension context torn down mid-navigation.
    }
}

/**
 * Takes the mask off for a bot check, and puts it back the moment the check is
 * over.
 *
 * Top frame only: a challenge is a property of the page, not of some iframe
 * inside it, and the top frame's host is the only one we would be exempting.
 *
 * Only the first direction reloads. Putting the mask back must NOT, for two
 * reasons that both came out of real use:
 *
 *   - Noticing "the challenge is gone" by looking at the page that replaced it
 *     means the real site has already loaded, and run its scripts, unmasked.
 *     Reloading afterwards does not take that back. So the exemption is dropped
 *     when the CHALLENGE PAGE LEAVES, before the next document exists, and the
 *     next document is masked from its first line with no reload at all.
 *   - A challenge is often cleared by a POST, and reloading a page reached that
 *     way makes the browser ask the user to resubmit the form - which, if they
 *     say yes, submits it again for real.
 */
function watchForChallenge(isExempt) {
    if (window.top !== window) {
        return;
    }

    if (isExempt) {
        // This document is the bot check, running bare. When it goes away the
        // check is over, and that is the last moment we can act before the
        // next document starts.
        window.addEventListener(
            'pagehide',
            () => tellBackground('ChallengeCleared'),
            { once: true },
        );
    }

    const decide = () => {
        const onChallenge = looksLikeChallenge();

        if (onChallenge && !isExempt) {
            tellBackground('ChallengeSeen');
            return;
        }

        if (!onChallenge && isExempt) {
            /*
             * Safety net. We are exempt, but this is not a challenge - so the
             * check cleared without this document ever unloading, and the real
             * site is on screen with the mask off. Drop the exemption so the
             * next page is covered, and say plainly that this one was not.
             */
            tellBackground('ChallengeCleared');
            sendStatus('leaked', 'challenge');
        }
    };

    const start = () => setTimeout(decide, CHALLENGE_SETTLE_MS);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    }
    else {
        start();
    }
}

/*
 * The attribute the hook reports through. Filled in once settings arrive; an
 * empty value simply means we do not get to confirm anything.
 */
let statusChannel = '';

/** Tells the background what happened here, for the toolbar dot. */
function sendStatus(state, reason) {
    try {
        chrome.runtime.sendMessage({ request: 'ReportStatus', state, reason }, () => {
            void chrome.runtime.lastError; // The worker may be asleep; harmless.
        });
    }
    catch (e) {
        // Extension context torn down mid-navigation.
    }
}

/**
 * Reads the hook's note off <html>, and takes it away again.
 *
 * Removing it keeps the attribute out of the page for all but an instant. A
 * determined page can still catch it with a MutationObserver, which is why the
 * name is a random one the extension rolls each session.
 */
function readReportedStatus() {
    const root = document.documentElement;
    if (!statusChannel || !root) {
        return null;
    }

    const reported = root.getAttribute(statusChannel);
    if (reported === null) {
        return null;
    }

    root.removeAttribute(statusChannel);
    return reported;
}

/**
 * Keeps listening after the initial read, because the hook can only discover
 * some things later - a worker blocked by the site's security policy is the
 * one that matters.
 */
function watchForLaterReports() {
    const root = document.documentElement;
    if (!statusChannel || !root || typeof MutationObserver !== 'function') {
        return;
    }

    new MutationObserver(() => {
        if (readReportedStatus() === 'worker') {
            sendStatus('partial', 'worker');
        }
    }).observe(root, { attributes: true, attributeFilter: [statusChannel] });
}

/**
 * The hostname to test site rules against.
 *
 * about:blank and sandboxed frames have no hostname of their own, so we use
 * the hostname of the page that created them - otherwise an ad frame on an
 * allowlisted site would quietly miss out.
 */
function frameHostname() {
    if (location.hostname) {
        return location.hostname.toLowerCase();
    }

    try {
        const ancestors = location.ancestorOrigins;
        if (ancestors && ancestors.length) {
            return new URL(ancestors[ancestors.length - 1]).hostname.toLowerCase();
        }
    }
    catch (e) {
        // No usable ancestor; fall through.
    }

    return '';
}

/**
 * Turns stored settings into the four values the hook takes.
 * Mirrors settings.toHookArguments in the background.
 */
function toHookArguments(stored) {
    const offset = Number(stored.offset);
    const labels = stored.zoneLabels || {};
    const isNaturalOffset = offset === Number(stored.naturalOffset);

    return [
        stored.timezone || 'Etc/GMT',
        -1 * (Number.isFinite(offset) ? offset : 0),
        (new Date()).getTimezoneOffset(),
        (isNaturalOffset ? labels.standard : labels.daylight) || labels.standard || 'GMT',
        null,
        statusChannel,
    ];
}

/**
 * Runs the hook in the page's world.
 *
 * The code is set as the script's text rather than its `src`, because a `src`
 * would be fetched asynchronously and the page's own scripts would run first.
 * Inline text executes the moment the element is attached.
 *
 * Passing the settings as a function argument (rather than, say, a data
 * attribute) also keeps them out of the DOM, where the page could read them.
 */
function runHookInPage(hookArguments) {
    if (typeof installTimezoneHook !== 'function') {
        return;
    }

    let code;
    try {
        code = `(${installTimezoneHook})(${JSON.stringify(hookArguments)});`;
    }
    catch (e) {
        return;
    }

    const script = document.createElement('script');
    script.textContent = code;

    const root = document.documentElement || document.head || document;
    root.prepend(script);
    script.remove();
}

/**
 * Gets the hook into the page, then reports the strongest claim we can
 * honestly make.
 *
 * "unverified", never "masked", even once the hook confirms it installed: we
 * put it there from here, after an asynchronous storage read, so a script at
 * the top of the page may already have looked at the clock. Nothing we can
 * check afterwards would tell us whether one did.
 *
 * chrome.scripting goes first even though it costs a message round trip, and
 * the faster inline <script> is kept only as a last resort. The reason is that
 * there is no way to ask a page whether it allows inline scripts - you find out
 * by trying one - and a blocked attempt is not free. It is written to the
 * page's console, and it fires a securitypolicyviolation event AT THE PAGE,
 * carrying a hash of the blocked code. On a site with a strict policy that
 * happens on every single load, and it tells the site that an extension is
 * injecting into it: precisely what this extension exists to avoid.
 */
function injectAndReport(hookArguments) {
    chrome.runtime.sendMessage({ request: 'InjectHook' }, response => {
        const reachedByScripting = !chrome.runtime.lastError && response && response.ok;

        const settle = () => {
            const reported = readReportedStatus();
            if (reported === 'masked') {
                sendStatus('unverified');
                return true;
            }
            if (reported === 'worker') {
                sendStatus('partial', 'worker');
                return true;
            }
            return false;
        };

        if (statusChannel && settle()) {
            return;
        }

        /*
         * chrome.scripting could not reach this frame. Inline is all that is
         * left - and where chrome.scripting failed, a strict CSP is unlikely to
         * be the reason, so this attempt is not the doomed one it looks like.
         */
        runHookInPage(hookArguments);

        if (!statusChannel) {
            // Nothing to confirm through, so we cannot claim more than this.
            sendStatus('unverified');
            return;
        }

        if (settle()) {
            return;
        }

        /*
         * Nothing could run here at all. If even chrome.scripting could not
         * reach the frame, it executes no page script either - a sandboxed
         * iframe, or one that has already gone - so there is nothing here to
         * read the clock and nothing to warn about.
         */
        sendStatus(reachedByScripting ? 'leaked' : 'off', 'no-hook');
    });
}

function start(stored) {
    if (chrome.runtime.lastError || !stored) {
        return;
    }

    statusChannel = typeof stored.statusChannel === 'string' ? stored.statusChannel : '';

    const hostname = frameHostname();
    const isExempt = siteRules.hostMatches(hostname, stored.challengeExemptions);

    // Runs whether or not we are masking this page: one direction watches for a
    // challenge to step aside for, the other for the challenge being over.
    watchForChallenge(isExempt);

    if (stored.enabled === false || !siteRules.appliesTo(hostname, stored)) {
        sendStatus('off');
        return;
    }

    /*
     * Has early injection already done the job? A report waiting for us before
     * we have run a single line means the hook beat us here, and therefore beat
     * the page's own scripts too. That is the one case that earns a green dot.
     */
    const initialReport = readReportedStatus();
    watchForLaterReports();

    if (initialReport === 'masked') {
        sendStatus('masked');
        return;
    }
    if (initialReport === 'worker') {
        sendStatus('partial', 'worker');
        return;
    }

    // Random-per-tab needs the background to say which zone this tab got, so
    // that every frame in the tab agrees. Costs a round trip, which is why it
    // is only done for this one mode.
    if (stored.randomPerTab === true) {
        chrome.runtime.sendMessage({ request: 'GetTimezone' }, hookArguments => {
            if (chrome.runtime.lastError
                || !Array.isArray(hookArguments) || hookArguments.length < 4) {
                sendStatus('leaked', 'no-hook');
                return;
            }
            injectAndReport(hookArguments);
        });
        return;
    }

    injectAndReport(toHookArguments(stored));
}

chrome.storage.local.get(SETTING_KEYS, start);
