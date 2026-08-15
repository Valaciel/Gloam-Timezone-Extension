/* globals popup, gloamTheme */
'use strict';

/*
 * Popup startup and wiring.
 * =========================
 *
 * Loads current settings, then handles the master switch, Save and Reset.
 * The sections themselves live next door: popup-nav.js switches between them,
 * popup-zones.js is the timezone picker, popup-sites.js the site lists, and
 * popup-connections.js the Links panel.
 */

/*
 * The header status.
 * ------------------
 *
 * The same green/amber/red the toolbar icon wears for this tab, put into words
 * next to the name. It used to be a banner over every panel, which spent three
 * lines of the popup saying the thing the icon already said in one dot.
 *
 * Short label in the header, whole sentence on hover, and the colours are spelt
 * out in General > Status dot for anyone who wants them written down.
 */
const STATUS_LABEL = {
    masked: 'Masked',
    unverified: 'Masked · unverified',
    partial: 'Masked · worker not covered',
    leaked: 'Real timezone leaked',
    off: 'Not masking this tab',
    disabled: 'Override is off',
    unknown: 'Checking this tab…',
};

const STATUS_DETAIL = {
    masked: 'This tab is masked — the override was in place before the page ran.',
    unverified: 'This tab is masked, but not verified — the override loaded late, '
        + 'so a script at the top of the page could have read the real timezone first.',
    partial: 'This tab is masked, but a Web Worker on it ran unmasked and saw the '
        + 'real timezone.',
    leaked: 'This tab leaked — something on it saw the real timezone.',
    off: 'Nothing is being masked here: this page is out of scope, or it is not a '
        + 'page the override can run on.',
    disabled: 'The override is switched off, so every site sees your real timezone.',
    unknown: '',
};

// Only shown for a gap or a leak, where knowing which one it was is actionable.
const STATUS_REASON = {
    worker: ' This site’s security policy blocks the way we normally cover workers, '
        + 'and covering it anyway would have stopped the worker running at all.',
    'no-hook': ' The override could not be installed on this page at all.',
    challenge: ' The mask was off for a bot check, and this page loaded before it '
        + 'could go back on. Reload to browse masked.',
};

// What the tab last told us, so flipping the switch can re-render without
// asking the background again.
let tabCoverage = null;

/**
 * Greys out the body when the override is switched off, and repaints the
 * header status.
 */
function renderEnabled() {
    const isOn = popup.el.enabled.checked;
    document.body.classList.toggle('is-disabled', !isOn);

    // The switch wins: with the override off, whatever the tab reported before
    // is history, and saying "masked" next to an off switch would be a lie.
    const state = !isOn ? 'disabled'
        : tabCoverage ? (STATUS_LABEL[tabCoverage.state] ? tabCoverage.state : 'off')
            : 'unknown';

    const detail = STATUS_DETAIL[state]
        + (state === 'leaked' || state === 'partial'
            ? (STATUS_REASON[tabCoverage && tabCoverage.reason] || '') : '');

    popup.el.status.className = `status is-${state}`;
    popup.el.status.title = detail;
    popup.el.statusText.textContent = STATUS_LABEL[state];
}

/** Remembers what the tab reported, then shows it. */
function renderCoverage(tab) {
    tabCoverage = tab || null;
    renderEnabled();
}

/**
 * Explains which injection path is running.
 *
 * Early injection needs a toggle only the user can flip, so when it is off we
 * say what to do about it rather than silently running the slower path.
 */
function renderInjectionNotice(isEarlyInjectionAvailable) {
    if (isEarlyInjectionAvailable) {
        popup.el.notice.hidden = true;
        return;
    }

    popup.el.notice.hidden = false;
    popup.el.notice.textContent =
        'For best coverage, turn on “Allow user scripts” for this extension on '
        + 'chrome://extensions. Without it a page can occasionally read the real '
        + 'timezone before the override loads.';
}

/*
 * Theme, and the About panel.
 * ---------------------------
 *
 * The theme is applied and stored on click rather than on Save. It changes what
 * you are looking at, so making someone press Save to see their own choice
 * would be strange - and it is a display preference, with nothing to do with
 * what sites are told.
 */
function wireTheme(current) {
    const chosen = gloamTheme.isValid(current.theme) ? current.theme : 'system';

    // Storage is the source of truth; correct the fast-path mirror if the two
    // have drifted (settings cleared, or another window changed it).
    gloamTheme.apply(chosen);
    gloamTheme.remember(chosen);

    const radio = document.querySelector(`input[name="theme"][value="${chosen}"]`);
    if (radio) {
        radio.checked = true;
    }

    for (const option of document.querySelectorAll('input[name="theme"]')) {
        option.addEventListener('change', () => {
            gloamTheme.apply(option.value);
            gloamTheme.remember(option.value);
            void popup.ask({ request: 'SetTheme', value: option.value });
        });
    }
}

function renderAbout() {
    const manifest = chrome.runtime.getManifest();
    popup.el.aboutVersion.textContent = `Version ${manifest.version}`;
}

popup.el.enabled.addEventListener('change', renderEnabled);

popup.el.form.addEventListener('submit', async event => {
    event.preventDefault();

    popup.sites.captureTextarea();
    const before = popup.sites.total();

    const response = await popup.ask({
        request: 'Save',
        value: {
            timezone: popup.zones.selected(),
            enabled: popup.el.enabled.checked,
            randomPerTab: popup.el.randomPerTab.checked,
            siteMode: popup.sites.mode(),
            allowlist: popup.sites.allowlist(),
            blocklist: popup.sites.blocklist(),
        },
    });

    if (!response || !response.ok) {
        popup.showMessage('Could not save', true);
        return;
    }

    // Show what was actually stored, not what was typed - the background drops
    // anything that isn't a valid hostname.
    popup.sites.adoptSaved(response.allowlist, response.blocklist);
    const dropped = before - popup.sites.total();

    if (dropped > 0) {
        popup.showMessage(`Saved — ignored ${dropped} invalid ${dropped === 1 ? 'entry' : 'entries'}`);
    }
    else {
        popup.showMessage('Saved — reload open tabs to apply');
    }
});

popup.el.resetButton.addEventListener('click', async () => {
    await popup.ask({ request: 'Reset' });
    location.reload();
});

(async () => {
    const status = await popup.ask({ request: 'GetStatus' });
    const current = (status && status.current) || {};

    popup.el.enabled.checked = current.enabled !== false;

    popup.zones.load(current);
    popup.sites.load(current);
    popup.connections.load(current);
    wireTheme(current);
    renderAbout();
    renderCoverage(status && status.tab); // also does renderEnabled
    renderInjectionNotice(Boolean(status && status.earlyInjectionAvailable));

    // Last, and not awaited: it asks every frame in the tab and waits for them
    // to answer, and none of the settings above should sit blank meanwhile.
    void popup.connections.scan();
})();
