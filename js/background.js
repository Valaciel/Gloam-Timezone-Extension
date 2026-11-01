/* globals offsets, timezoneInfo, settings, tabStatus, tabConnections */
'use strict';

/*
 * Background service worker.
 * ==========================
 *
 * Handles the jobs nothing else can do:
 *
 *   - answering the popup (look up a zone, save, reset, report status)
 *   - handing out a per-tab zone when "random per tab" is on, so that every
 *     frame in a tab agrees with each other
 *   - keeping the early-injection registration in step with the settings
 *   - re-resolving the timezone on browser start, in case daylight saving
 *     changed while the browser was closed
 *
 * A service worker is not a persistent background page: Chrome shuts it down
 * when idle and starts it again for the next event. Nothing may be kept in
 * memory that matters after that, which is why every setting lives in storage.
 */

// Requests the popup is allowed to make. Anything else is ignored.
const HANDLED_REQUESTS = new Set([
    'GetTimezone', 'Save', 'Reset', 'GetStatus', 'ReportStatus', 'InjectHook',
    'ChallengeSeen', 'ChallengeCleared', 'GetConnections', 'ReportConnections', 'SetTheme',
]);

/*
 * Which random zone each tab was given. Purely a cache: if the worker is shut
 * down and restarted, tabs simply get re-rolled, which is harmless.
 */
const randomZoneByTab = Object.create(null);

chrome.tabs.onRemoved.addListener(tabId => {
    delete randomZoneByTab[tabId];
    tabStatus.forget(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    // Only ever act on messages from our own popup and content scripts.
    if (sender.id !== chrome.runtime.id || !message || !HANDLED_REQUESTS.has(message.request)) {
        respond();
        return false;
    }

    // Settings may only be changed from an extension page. Content scripts run
    // alongside untrusted web pages, so they get read-only requests only.
    const fromExtensionPage = !sender.tab;

    switch (message.request) {
        case 'GetTimezone':
            void respondWithTimezone(respond, sender.tab && sender.tab.id, sender.frameId);
            return true;

        case 'GetStatus':
            void respondWithStatus(respond);
            return true;

        /*
         * A content script saying how its frame went. Only the sender's own
         * tab and frame are trusted here - both come from the browser, not
         * from the message - so a frame can only ever speak for itself.
         */
        case 'ReportStatus':
            if (sender.tab) {
                tabStatus.report(sender.tab.id, sender.frameId, message.state, message.reason);
            }
            respond();
            return false;

        /*
         * The content script could not get the hook into the page itself.
         * Note that nothing from the message is used: the frame to inject into
         * and the settings to inject both come from the browser and from
         * storage, never from the sender.
         */
        case 'InjectHook':
            if (!sender.tab) {
                respond({ ok: false });
                return false;
            }
            void injectHookIntoFrame(sender.tab.id, sender.frameId, respond);
            return true;

        /*
         * A bot check, and the mask has to come off for it to pass. Only the
         * top frame of a real tab may say so, and the hostname comes from the
         * sender's own URL rather than from the message, so a frame cannot ask
         * us to stop masking somewhere it has no business speaking for.
         */
        case 'ChallengeSeen':
        case 'ChallengeCleared':
            if (!sender.tab || sender.frameId !== 0) {
                respond({ ok: false });
                return false;
            }
            void applyChallengeChange(message.request, sender, respond);
            return true;

        /*
         * A frame listing the hosts it has fetched from. As with ReportStatus,
         * which tab it belongs to comes from the browser rather than from the
         * message, so no frame can file a report against another tab.
         */
        case 'ReportConnections':
            if (sender.tab) {
                tabConnections.report(sender.tab.id, message);
            }
            respond();
            return false;

        case 'GetConnections':
            if (!fromExtensionPage) {
                respond(null);
                return false;
            }
            void respondWithConnections(respond);
            return true;

        case 'SetTheme':
            if (!fromExtensionPage) {
                respond(null);
                return false;
            }
            void settings.saveTheme(message.value).then(theme => respond({ ok: true, theme }));
            return true;

        case 'Save':
            if (!fromExtensionPage) {
                respond({ ok: false });
                return false;
            }
            void saveAndRespond(message.value, respond);
            return true;

        case 'Reset':
            if (!fromExtensionPage) {
                respond({ ok: false });
                return false;
            }
            void resetAndRespond(respond);
            return true;
    }

    return false;
});

/**
 * The values the hook needs for one frame, or null if we are not covering it.
 *
 * Only the background can answer this when "random per tab" is on, because
 * only the background remembers what a tab was given.
 */
async function hookArgumentsFor(tabId, frameId) {
    const current = await settings.read();

    if (!current.enabled) {
        return null;
    }

    if (current.randomPerTab && tabId !== undefined) {
        const names = Object.keys(offsets);

        // The top frame picks; sub-frames reuse the tab's pick so that an
        // iframe never contradicts the page it sits in.
        if (frameId === 0 || randomZoneByTab[tabId] === undefined) {
            randomZoneByTab[tabId] = names[Math.floor(Math.random() * names.length)];
        }

        const timezone = randomZoneByTab[tabId];
        const description = timezoneInfo.describe(timezone);

        return settings.toHookArguments({
            ...current,
            timezone,
            offset: description.offset,
            naturalOffset: description.baseline.offset,
            zoneLabels: description.baseline.labels,
        });
    }

    return settings.toHookArguments(current);
}

/** Gives a content script the values the hook needs. */
async function respondWithTimezone(respond, tabId, frameId) {
    respond(await hookArgumentsFor(tabId, frameId));
}

/**
 * Hook injection is handled declaratively via manifest.json (world: "MAIN").
 * Kept as an acknowledgement for backward compatibility.
 */
async function injectHookIntoFrame(tabId, frameId, respond) {
    respond({ ok: true });
}

async function respondWithStatus(respond) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    respond({
        earlyInjectionAvailable: true,
        tab: activeTab ? tabStatus.stateOf(activeTab.id) : { state: 'off', reason: '' },
        current: await settings.read(),
    });
}

/**
 * Everything the active tab has connected to, plus the page's own host so the
 * popup can tell first party from third.
 */
async function respondWithConnections(respond) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!activeTab) {
        respond({ pageHost: '', hosts: [], frameHosts: [], reachable: false });
        return;
    }

    let pageHost = '';
    try {
        pageHost = new URL(activeTab.url || '').hostname.toLowerCase();
    }
    catch (e) {
        // A page we have no host permission for, so no URL to read.
    }

    const collected = await tabConnections.collect(activeTab.id);
    respond({ pageHost, ...collected });
}

/**
 * Steps out of the way of a bot check, or steps back in once it has passed.
 *
 * Only stepping ASIDE reloads. By the time we know a challenge is on screen it
 * has already run against a masked clock, so the page has to be loaded again
 * for the exemption to mean anything.
 *
 * Stepping back in must not reload. That message arrives as the challenge page
 * unloads, which is early enough for the next document to be masked from its
 * first line - no reload needed, nothing leaked, and no "confirm form
 * resubmission" prompt on a challenge that was cleared by a POST.
 *
 * Both helpers return false when nothing changed, which is what keeps a site
 * that challenges on every load from reloading the tab over and over.
 */
async function applyChallengeChange(request, sender, respond) {
    let hostname;
    try {
        hostname = new URL(sender.url).hostname;
    }
    catch (e) {
        respond({ ok: false });
        return;
    }

    const steppingAside = request === 'ChallengeSeen';

    const changed = steppingAside
        ? await settings.exemptFromChallenge(hostname)
        : await settings.remaskAfterChallenge(hostname);

    if (!changed) {
        respond({ ok: false });
        return;
    }

    respond({ ok: true });

    if (steppingAside) {
        chrome.tabs.reload(sender.tab.id);
    }
}

async function saveAndRespond(value, respond) {
    const stored = await settings.save(value);

    respond({
        ok: true,
        offset: stored.offset,
        allowlist: stored.allowlist,
        blocklist: stored.blocklist,
        earlyInjectionActive: true,
    });
}

async function resetAndRespond(respond) {
    await settings.reset();
    respond({ ok: true });
}

/** Runs on install and on every browser start. */
async function start() {
    await settings.refresh();
}

chrome.runtime.onInstalled.addListener(() => void start());
chrome.runtime.onStartup.addListener(() => void start());
