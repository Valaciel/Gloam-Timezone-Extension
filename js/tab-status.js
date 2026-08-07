'use strict';

/*
 * The toolbar dot.
 * ================
 *
 * A small coloured dot drawn over the toolbar icon, per tab, saying what we
 * actually managed to do on that page:
 *
 *   green   masked      the hook was already in place before our content
 *                       script even ran, so nothing on the page could have
 *                       read the clock first
 *   amber   unverified  the hook is installed, but WE installed it, from the
 *                       content script, after an async storage read - so a
 *                       script running at the top of the page could have got
 *                       there first. We cannot tell whether one did.
 *   red     leaked      something definitely saw the real timezone: the hook
 *                       never installed, or a worker had to run unpatched
 *   none    off         we are not covering this page, by design (override
 *                       switched off, or the site is out of scope)
 *
 * The distinction between green and amber is the whole point. "We injected the
 * hook" is not the same claim as "nothing read the clock before us", and a
 * privacy tool that blurs the two is lying to its user.
 *
 * Frames report independently and the worst answer in a tab wins: a leak in an
 * ad iframe is still a leak.
 */

var tabStatus = {};

// Worst last. A frame may only ever move a tab further down this list.
const SEVERITY = ['off', 'masked', 'unverified', 'leaked'];

const DOT_COLOUR = {
    masked: '#22c55e',
    unverified: '#f59e0b',
    leaked: '#ef4444',
};

const TOOLTIP = {
    off: '',
    masked: 'Gloam TZ - masked. The override was in place before this page ran.',
    unverified: 'Gloam TZ - masked, but not verified. The override loaded on the '
        + 'fallback path, so a script at the top of the page could have read the real '
        + 'timezone first. Turn on "Allow user scripts" on chrome://extensions to close '
        + 'this gap.',
    leaked: 'Gloam TZ - leak. Something on this page saw the real timezone.',
};

// Appended to the tooltip when we know what went wrong.
const REASON = {
    worker: ' A Web Worker had to run unmasked, because this site\'s security '
        + 'policy blocks the way we normally cover them.',
    'no-hook': ' The override could not be installed on this page at all.',
    challenge: ' The mask was off for a bot check, and this page loaded before it '
        + 'could go back on. Reload to browse masked.',
};

const DEFAULT_ICON_PATHS = {
    16: '/data/icons/icon-16.png',
    32: '/data/icons/icon-32.png',
    48: '/data/icons/icon-48.png',
};

// The sizes Chrome actually asks for on the toolbar.
const DOT_SIZES = [16, 32];

/*
 * Purely a cache. The service worker is shut down when idle, and when it comes
 * back this map is empty - but the icons themselves persist in the browser, and
 * the next page load reports again, so nothing needs to survive.
 */
const stateByTab = new Map();
const reasonByTab = new Map();

/* ---------------------------------------------------------- drawing --- */

const baseBitmaps = new Map();

async function baseBitmap(size) {
    let bitmap = baseBitmaps.get(size);
    if (!bitmap) {
        const response = await fetch(chrome.runtime.getURL(`data/icons/icon-${size}.png`));
        bitmap = await createImageBitmap(await response.blob());
        baseBitmaps.set(size, bitmap);
    }
    return bitmap;
}

/**
 * The icon with a dot in its top-right corner.
 *
 * The dot is drawn over a hole punched out of the artwork rather than straight
 * on top of it, so it stays legible whatever the icon has in that corner and
 * on whatever colour the toolbar happens to be.
 */
async function iconWithDot(size, colour) {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');

    context.drawImage(await baseBitmap(size), 0, 0, size, size);

    const radius = size * 0.27;
    const centreX = size - radius - size * 0.05;
    const centreY = radius + size * 0.05;
    const gap = Math.max(1, size / 16);

    context.globalCompositeOperation = 'destination-out';
    context.beginPath();
    context.arc(centreX, centreY, radius + gap, 0, Math.PI * 2);
    context.fill();

    context.globalCompositeOperation = 'source-over';
    context.fillStyle = colour;
    context.beginPath();
    context.arc(centreX, centreY, radius, 0, Math.PI * 2);
    context.fill();

    return context.getImageData(0, 0, size, size);
}

async function paint(tabId, state, reason) {
    try {
        if (state === 'off' || !DOT_COLOUR[state]) {
            await chrome.action.setIcon({ tabId, path: DEFAULT_ICON_PATHS });
        }
        else {
            const drawn = await Promise.all(
                DOT_SIZES.map(size => iconWithDot(size, DOT_COLOUR[state])),
            );
            const imageData = {};
            DOT_SIZES.forEach((size, index) => {
                imageData[size] = drawn[index];
            });
            await chrome.action.setIcon({ tabId, imageData });
        }

        // An empty title puts the manifest's name back.
        const tooltip = TOOLTIP[state] ? TOOLTIP[state] + (REASON[reason] || '') : '';
        await chrome.action.setTitle({ tabId, title: tooltip });
    }
    catch (e) {
        // The tab closed or navigated somewhere we have no say over. Nothing
        // to do, and nothing worth logging.
    }
}

/* ----------------------------------------------------------- state --- */

/**
 * A frame reporting in.
 *
 * The top frame reporting means a new document has started loading in the tab,
 * which is our cue to forget what the previous one told us. Sub-frames of the
 * new page always report after their top frame, so this is enough to keep the
 * two pages' verdicts from bleeding into each other - and it needs no extra
 * permission, unlike watching navigation directly.
 */
tabStatus.report = (tabId, frameId, state, reason) => {
    if (tabId === undefined || !SEVERITY.includes(state)) {
        return;
    }

    if (frameId === 0) {
        stateByTab.delete(tabId);
        reasonByTab.delete(tabId);
    }

    const previous = stateByTab.get(tabId);
    if (previous !== undefined && SEVERITY.indexOf(state) <= SEVERITY.indexOf(previous)) {
        return;
    }

    stateByTab.set(tabId, state);
    if (reason) {
        reasonByTab.set(tabId, reason);
    }
    else {
        reasonByTab.delete(tabId);
    }

    void paint(tabId, state, reason);
};

tabStatus.stateOf = tabId => ({
    state: stateByTab.get(tabId) || 'off',
    reason: reasonByTab.get(tabId) || '',
});

tabStatus.forget = tabId => {
    stateByTab.delete(tabId);
    reasonByTab.delete(tabId);
};

/**
 * Clear the dot when a tab moves somewhere no content script will ever run -
 * chrome://settings, the web store, a PDF viewer. Those pages never report, so
 * without this the previous page's dot would sit there looking authoritative.
 *
 * Reading the URL here is slightly indirect. Chrome only tells an extension a
 * tab's URL when it has permission for that URL, and our host permissions are
 * exactly the pages we run on - so "we cannot see the URL" is itself the signal
 * that this is a page we have no business on.
 *
 * The upshot is that pages we DO cover never take this branch, so clearing can
 * never race a report that has already arrived.
 */
const RUNNABLE_URL = /^(?:https?:|about:blank)/i;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading') {
        return;
    }

    const url = changeInfo.url || (tab && tab.url) || '';
    if (!RUNNABLE_URL.test(url)) {
        tabStatus.forget(tabId);
        void paint(tabId, 'off');
    }
});
