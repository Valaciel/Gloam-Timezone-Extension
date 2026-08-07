'use strict';

/*
 * Who this page actually talks to.
 * ===============================
 *
 * Runs in every frame and keeps a tally of the hosts this frame has fetched
 * anything from. The popup's Links panel shows that tally, because "I am on
 * youtube.com" and "this page has loaded code from a dozen other companies"
 * are very different statements, and only the first one is on screen.
 *
 * The list comes from the page's own Resource Timing entries, which the browser
 * records anyway. That is a deliberate choice over the webRequest API: watching
 * requests would mean asking for a permission that lets an extension see every
 * URL the browser fetches, which is a lot to ask of someone who installed a
 * privacy tool. This reads what the page can already see about itself, and
 * nothing leaves the browser.
 *
 * A PerformanceObserver rather than a one-off read of the buffer, because the
 * buffer holds a limited number of entries and any page may call
 * performance.clearResourceTimings() at will. Observed entries are counted as
 * they happen, so neither takes anything away from us.
 *
 * What it will not see: WebSocket traffic, and requests a page makes from a
 * worker (which has its own timeline). Both are noted in the panel rather than
 * quietly missing.
 */

// Counted per host, so a domain pulled in once looks different from one being
// talked to constantly.
const hitsByHost = new Map();

function noteUrl(rawUrl) {
    let hostname;
    try {
        hostname = new URL(rawUrl, location.href).hostname.toLowerCase();
    }
    catch (e) {
        return;
    }

    // data:, blob: and about: URLs have no host and are not connections.
    if (!hostname) {
        return;
    }

    hitsByHost.set(hostname, (hitsByHost.get(hostname) || 0) + 1);
}

function watch() {
    if (typeof PerformanceObserver !== 'function') {
        return;
    }

    try {
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                noteUrl(entry.name);
            }
        }).observe({ type: 'resource', buffered: true });
    }
    catch (e) {
        // Resource timing unavailable in this frame; the panel copes with an
        // empty list.
    }
}

/**
 * The host this frame belongs to.
 *
 * Mirrors content-script.js's frameHostname(): a sandboxed or about:blank frame
 * has no host of its own, so it is attributed to whatever opened it. (Kept
 * under a different name because every content script in this entry shares one
 * scope, so two files cannot both declare it.)
 */
function owningHostname() {
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
        // No usable ancestor.
    }

    return '';
}

/*
 * The popup asks the background, the background asks every frame, and each
 * frame answers with a message of its own rather than through sendResponse -
 * a broadcast to a tab only ever delivers one frame's reply, and the whole
 * point here is to hear from all of them.
 *
 * The scan token comes straight back so the background can tell this answer
 * from one left over by a previous page.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || !message || message.request !== 'CollectConnections') {
        return false;
    }

    const hosts = [...hitsByHost].map(([host, hits]) => ({ host, hits }));

    try {
        chrome.runtime.sendMessage({
            request: 'ReportConnections',
            token: message.token,
            frameHost: frameHostname(),
            hosts,
        }, () => {
            void chrome.runtime.lastError;
        });
    }
    catch (e) {
        // Extension context torn down mid-navigation.
    }

    return false;
});

watch();
