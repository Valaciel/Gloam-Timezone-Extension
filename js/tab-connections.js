'use strict';

/*
 * Collecting a tab's connections.
 * ===============================
 *
 * data/connections.js keeps a per-frame tally of the hosts that frame has
 * fetched from. This is the other half: it asks every frame in a tab at once
 * and merges the answers into one list for the popup.
 *
 * It has to be done this way round because a broadcast to a tab delivers only
 * a single frame's reply, and a page's third-party connections are mostly made
 * by its iframes - the ad frame is exactly the one you want to see. So frames
 * answer with messages of their own, and this file waits for them to arrive.
 *
 * Nothing is cached between scans. The service worker is shut down when idle
 * and a stale list is worse than no list, so every popup open asks again.
 */

var tabConnections = {};

// How long to let frames answer. Frames reply immediately - this is a message
// round trip, not a network one - so the wait only has to cover a tab with a
// lot of them.
const COLLECT_MS = 250;

/*
 * The scan in progress, if any. Only one at a time: the popup is the only
 * caller, and a second open supersedes the first.
 */
let scan = null;

/** A frame answering. Ignored unless it belongs to the scan we are running. */
tabConnections.report = (tabId, message) => {
    if (!scan || scan.tabId !== tabId || scan.token !== message.token) {
        return;
    }

    if (typeof message.frameHost === 'string' && message.frameHost) {
        scan.frameHosts.add(message.frameHost);
    }

    if (!Array.isArray(message.hosts)) {
        return;
    }

    for (const entry of message.hosts) {
        if (!entry || typeof entry.host !== 'string' || !entry.host) {
            continue;
        }
        const hits = Number(entry.hits);
        scan.hits.set(
            entry.host,
            (scan.hits.get(entry.host) || 0) + (Number.isFinite(hits) && hits > 0 ? hits : 1),
        );
    }
};

/**
 * Asks every frame in a tab and returns what they say.
 *
 * `frameHosts` is the set of hosts that own a frame here, which is how the
 * popup can say "this page embeds a whole other site" rather than lumping an
 * embedded player in with the images it loaded.
 */
tabConnections.collect = async tabId => {
    if (tabId === undefined) {
        return { hosts: [], frameHosts: [], reachable: false };
    }

    const token = Math.random().toString(36).slice(2);
    scan = { tabId, token, hits: new Map(), frameHosts: new Set() };

    try {
        // Fire and forget: replies come back as ReportConnections messages, and
        // the callback here only ever sees whichever frame answered first.
        chrome.tabs.sendMessage(tabId, { request: 'CollectConnections', token }, () => {
            void chrome.runtime.lastError;
        });
    }
    catch (e) {
        // Tab already gone. The empty result below is the right answer.
    }

    await new Promise(resolve => setTimeout(resolve, COLLECT_MS));

    // A later scan started while we waited; that one owns the results now.
    if (!scan || scan.token !== token) {
        return { hosts: [], frameHosts: [], reachable: false };
    }

    const hosts = [...scan.hits]
        .map(([host, hits]) => ({ host, hits }))
        .sort((a, b) => b.hits - a.hits || a.host.localeCompare(b.host));

    // At least one frame answered, so this is a page we can speak about. An
    // empty list from a reachable page means "nothing third-party here", which
    // is a real answer; an unreachable one means "we cannot tell", which is not.
    const frameHosts = [...scan.frameHosts];
    const reachable = scan.frameHosts.size > 0 || hosts.length > 0;
    scan = null;

    return { hosts, frameHosts, reachable };
};
