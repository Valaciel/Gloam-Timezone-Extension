/* globals siteRules */
'use strict';

/*
 * Gloam Timezone Extension — data/content-script.js (Bridge)
 * =========================================================
 *
 * Runs in every frame at document_start in the extension's ISOLATED world.
 *
 * Responsibilities:
 *   1. Reads configuration from extension storage and evaluates site rules
 *      (Allowlist / Blocklist / Listed mode) for the current frame hostname.
 *   2. Bridges the verified configuration into the MAIN world's timezone-hook
 *      via custom window events (__gloam_tz_cfg and __gloam_tz_req).
 *   3. Watches for Cloudflare and bot challenges: temporarily steps aside so
 *      bot checks pass cleanly without endless loops, then restores the mask.
 *   4. Listens to storage changes to propagate popup edits live to all open
 *      tabs and frames without requiring a page reload.
 *   5. Reports accurate status to the background worker for the toolbar dot.
 */

(function () {
    const EVT_CFG = '__gloam_tz_cfg';
    const EVT_REQ = '__gloam_tz_req';

    const SETTING_KEYS = [
        'timezone', 'offset', 'naturalOffset', 'zoneLabels',
        'enabled', 'randomPerTab',
        'siteMode', 'allowlist', 'blocklist',
        'statusChannel', 'challengeExemptions',
    ];

    const CHALLENGE_MARKERS = [
        'script[src*="/cdn-cgi/challenge-platform/"]',
        '#challenge-form',
        '#challenge-running',
        '#cf-challenge-running',
        'iframe[src*="challenges.cloudflare.com"]',
        '#challenge-stage',
        '.cf-turnstile',
        'div[data-sitekey]',
    ];

    const CHALLENGE_TITLES = [
        'just a moment...',
        'attention required! | cloudflare',
        'checking your browser',
        'ddos-guard',
    ];

    const CHALLENGE_SETTLE_MS = 2000;

    let lastConfig = { enabled: false, timezone: null, ts: 0 };
    let statusChannel = '';

    function frameHostname() {
        if (location.hostname) {
            return location.hostname.toLowerCase();
        }
        try {
            const ancestors = location.ancestorOrigins;
            if (ancestors && ancestors.length) {
                return new URL(ancestors[ancestors.length - 1]).hostname.toLowerCase();
            }
        } catch (e) { /* ignore */ }
        return '';
    }

    function looksLikeChallenge() {
        if (typeof window._cf_chl_opt !== 'undefined') {
            return true;
        }

        const title = (document.title || '').trim().toLowerCase();
        if (CHALLENGE_TITLES.some(t => title.includes(t))) {
            return true;
        }

        return CHALLENGE_MARKERS.some(selector => {
            try {
                return document.querySelector(selector) !== null;
            } catch (e) {
                return false;
            }
        });
    }

    function hasClearanceCookie() {
        try {
            return Boolean(document.cookie && document.cookie.includes('cf_clearance='));
        } catch (e) {
            return false;
        }
    }

    function tellBackground(request) {
        try {
            chrome.runtime.sendMessage({ request }, () => {
                void chrome.runtime.lastError;
            });
        } catch (e) { /* context invalidated */ }
    }

    function sendStatus(state, reason) {
        try {
            chrome.runtime.sendMessage({ request: 'ReportStatus', state, reason }, () => {
                void chrome.runtime.lastError;
            });
        } catch (e) { /* context invalidated */ }
    }

    function dispatchConfig(cfg) {
        lastConfig = cfg;
        try {
            window.dispatchEvent(new CustomEvent(EVT_CFG, {
                detail: JSON.stringify(cfg),
            }));
        } catch (e) { /* page is gone */ }
    }

    function watchForChallenge(isExempt) {
        if (window.top !== window) {
            return;
        }

        if (isExempt) {
            window.addEventListener(
                'pagehide',
                () => tellBackground('ChallengeCleared'),
                { once: true },
            );

            // Periodically check for clearance cookie acquisition or challenge resolution
            const clearanceInterval = setInterval(() => {
                if (hasClearanceCookie() && !looksLikeChallenge()) {
                    clearInterval(clearanceInterval);
                    tellBackground('ChallengeCleared');
                    syncSettings();
                }
            }, 1000);
        }

        const decide = () => {
            const onChallenge = looksLikeChallenge();

            if (onChallenge && !isExempt) {
                tellBackground('ChallengeSeen');
                // Temporarily disable hook so challenge widget succeeds
                dispatchConfig({ enabled: false, timezone: null, ts: Date.now() });
                return;
            }

            if (!onChallenge && isExempt) {
                tellBackground('ChallengeCleared');
                syncSettings();
            }
        };

        const start = () => setTimeout(decide, CHALLENGE_SETTLE_MS);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            start();
        }
    }

    function syncSettings() {
        try {
            chrome.storage.local.get(SETTING_KEYS, stored => {
                if (chrome.runtime.lastError || !stored) {
                    return;
                }

                statusChannel = typeof stored.statusChannel === 'string' ? stored.statusChannel : '';
                const hostname = frameHostname();
                const isExempt = siteRules && typeof siteRules.hostMatches === 'function'
                    ? siteRules.hostMatches(hostname, stored.challengeExemptions)
                    : false;

                watchForChallenge(isExempt);

                const applies = siteRules && typeof siteRules.appliesTo === 'function'
                    ? siteRules.appliesTo(hostname, stored)
                    : true;

                if (stored.enabled === false || !applies || isExempt) {
                    dispatchConfig({ enabled: false, timezone: null, ts: Date.now(), statusChannel });
                    sendStatus('off');
                    return;
                }

                // Random-per-tab query
                if (stored.randomPerTab === true) {
                    chrome.runtime.sendMessage({ request: 'GetTimezone' }, response => {
                        let tz = stored.timezone;
                        if (Array.isArray(response) && response.length > 0 && typeof response[0] === 'string') {
                            tz = response[0];
                        } else if (response && typeof response.timezone === 'string') {
                            tz = response.timezone;
                        } else if (typeof response === 'string') {
                            tz = response;
                        }
                        dispatchConfig({
                            enabled: true,
                            timezone: tz,
                            ts: Date.now(),
                            statusChannel,
                        });
                        sendStatus('masked');
                    });
                    return;
                }

                dispatchConfig({
                    enabled: true,
                    timezone: stored.timezone,
                    ts: Date.now(),
                    statusChannel,
                });
                sendStatus('masked');
            });
        } catch (e) { /* context invalidated */ }
    }

    // Hook asks for configuration on start
    window.addEventListener(EVT_REQ, () => {
        dispatchConfig(lastConfig);
    }, true);

    // Live update when popup or background changes storage
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local') {
                syncSettings();
            }
        });
    } catch (e) { /* ignore */ }

    // Initial sync
    syncSettings();
})();
