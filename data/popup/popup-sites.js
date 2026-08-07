/* globals popup, siteRules */
'use strict';

/*
 * Site lists.
 * ===========
 *
 * The All sites / Allowlist / Blocklist choice, the hostname box, and backing
 * the lists up to a file.
 */

popup.sites = {};

const HINT_FOR_MODE = {
    listed: 'Only override the timezone on these sites.',
    blocked: 'Override everywhere except these sites.',
};

const EXPORT_FORMAT = 'gloam-timezone-sites';
const MAX_IMPORT_BYTES = 1024 * 1024;

/*
 * Both lists are held here, and the textarea shows whichever one the current
 * mode uses. Keeping them separate means switching modes to look at the other
 * list never costs you the one you were editing.
 */
const lists = { listed: [], blocked: [] };

// Which list the textarea is currently showing, so we know where its contents
// belong when the user switches away.
let visibleList = null;

popup.sites.mode = () => {
    const checked = document.querySelector('input[name="siteMode"]:checked');
    return checked ? checked.value : 'all';
};

popup.sites.allowlist = () => lists.listed;
popup.sites.blocklist = () => lists.blocked;

/** Moves whatever is in the textarea back into the list it belongs to. */
function captureTextarea() {
    if (visibleList) {
        lists[visibleList] = popup.linesOf(popup.el.listText.value);
    }
}

function renderCounts() {
    popup.el.listCounts.textContent = `${lists.listed.length} allowed · ${lists.blocked.length} blocked`;
}

/** Shows the right list (or hides the box entirely on "All sites"). */
popup.sites.render = () => {
    const mode = popup.sites.mode();

    if (visibleList !== mode) {
        captureTextarea();
    }

    if (mode === 'all') {
        popup.el.listSection.hidden = true;
        visibleList = null;
    }
    else {
        popup.el.listSection.hidden = false;
        popup.el.listHint.textContent = HINT_FOR_MODE[mode];
        popup.el.listText.value = lists[mode].join('\n');
        visibleList = mode;
    }

    renderCounts();
};

popup.sites.load = current => {
    lists.listed = Array.isArray(current.allowlist) ? current.allowlist : [];
    lists.blocked = Array.isArray(current.blocklist) ? current.blocklist : [];

    const mode = ['all', 'listed', 'blocked'].includes(current.siteMode) ? current.siteMode : 'all';
    const radio = document.querySelector(`input[name="siteMode"][value="${CSS.escape(mode)}"]`)
        || document.querySelector('input[name="siteMode"][value="all"]');
    radio.checked = true;

    visibleList = null;
    popup.sites.render();
};

/** Replaces both lists with what the background actually stored. */
popup.sites.adoptSaved = (allowlist, blocklist) => {
    if (Array.isArray(allowlist)) {
        lists.listed = allowlist;
    }
    if (Array.isArray(blocklist)) {
        lists.blocked = blocklist;
    }
    visibleList = null;
    popup.sites.render();
};

popup.sites.captureTextarea = captureTextarea;
popup.sites.total = () => lists.listed.length + lists.blocked.length;

/*
 * Adding from somewhere other than the textarea - the Links panel.
 * ---------------------------------------------------------------
 *
 * Entries go into the in-memory list, exactly as typing them would, so the
 * usual Save path validates and stores them. Nothing here writes to storage.
 */

/**
 * Is this host already covered by the list?
 *
 * Covered, not present: an entry for example.com already covers
 * ads.example.com, so offering to add the subdomain as well would be adding a
 * line that changes nothing.
 */
popup.sites.covers = (listName, host) => {
    captureTextarea();
    return siteRules.hostMatches(host, lists[listName]);
};

/** Adds entries to a list, skipping any the list already covers. Returns how many. */
popup.sites.add = (listName, entries) => {
    captureTextarea();

    let added = 0;
    for (const raw of entries) {
        const entry = String(raw).trim().toLowerCase();
        const host = entry.replace(/^\*\./, '');

        if (!host || lists[listName].includes(entry)) {
            continue;
        }

        /*
         * A wildcard is allowed to replace narrower entries under it: adding
         * *.doubleclick.net when ads.doubleclick.net is already there should
         * leave one line that says the broader thing, not two.
         */
        if (entry.startsWith('*.')) {
            lists[listName] = lists[listName].filter(
                existing => !siteRules.hostMatches(existing.replace(/^\*\./, ''), [host]),
            );
        }
        else if (siteRules.hostMatches(host, lists[listName])) {
            continue;
        }

        lists[listName].push(entry);
        added += 1;
    }

    visibleList = null;
    popup.sites.render();
    return added;
};

/* ---------------------------------------------------------------- backup - */

/*
 * A rough hostname check, used only when reading an imported file. The
 * background validates properly before storing; this exists so that opening
 * the wrong file cannot silently wipe someone's list and replace it with
 * whatever text happened to be inside.
 */
const LOOKS_LIKE_HOSTNAME = /^(\*\.)?[^\s,;/\\?#]+\.[^\s,;/\\?#]+$/;

function keepHostnames(entries) {
    return entries.filter(entry => LOOKS_LIKE_HOSTNAME.test(
        entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0],
    ));
}

popup.el.exportButton.addEventListener('click', () => {
    captureTextarea();

    const backup = {
        format: EXPORT_FORMAT,
        version: 1,
        exported: new Date().toISOString(),
        siteMode: popup.sites.mode(),
        allowlist: lists.listed,
        blocklist: lists.blocked,
    };

    const datestamp = new Date().toISOString().slice(0, 10);
    const fileUrl = URL.createObjectURL(
        new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
    );

    const link = document.createElement('a');
    link.href = fileUrl;
    link.download = `gloam-tz-sites-${datestamp}.json`;
    link.click();

    // The popup often closes as the download starts, so clean up on a delay
    // rather than immediately.
    setTimeout(() => URL.revokeObjectURL(fileUrl), 10000);

    popup.showMessage(`Exported ${popup.sites.total()} entries`);
});

popup.el.importButton.addEventListener('click', () => {
    // Clearing first means re-picking the same file still fires a change event.
    popup.el.importFile.value = '';
    popup.el.importFile.click();
});

/**
 * Reads an imported file.
 *
 * Accepts our own JSON export, which restores both lists and the mode; or a
 * plain text/CSV list of hostnames, which goes into whichever list is showing.
 * Returns a message to display, or null if there was nothing usable.
 */
function readBackup(text) {
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    }
    catch (e) {
        // Not JSON - treat it as a plain list below.
    }

    const isOurFormat = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (Array.isArray(parsed.allowlist) || Array.isArray(parsed.blocklist));

    if (isOurFormat) {
        lists.listed = keepHostnames(popup.linesOf((parsed.allowlist || []).map(String).join('\n')));
        lists.blocked = keepHostnames(popup.linesOf((parsed.blocklist || []).map(String).join('\n')));

        if (['all', 'listed', 'blocked'].includes(parsed.siteMode)) {
            const radio = document.querySelector(`input[name="siteMode"][value="${CSS.escape(parsed.siteMode)}"]`);
            if (radio) {
                radio.checked = true;
            }
        }

        visibleList = null;
        popup.sites.render();
        return `Imported ${lists.listed.length} allowed · ${lists.blocked.length} blocked — press Save`;
    }

    const mode = popup.sites.mode();
    if (mode === 'all') {
        return null;
    }

    // Plain lists may be separated by newlines, commas or semicolons.
    const source = Array.isArray(parsed) ? parsed.map(String).join('\n') : text;
    const entries = keepHostnames(popup.linesOf(String(source).replace(/[,;]/g, '\n')));
    if (!entries.length) {
        return null;
    }

    lists[mode] = entries;
    visibleList = null;
    popup.sites.render();
    return `Imported ${entries.length} entries — press Save`;
}

popup.el.importFile.addEventListener('change', async () => {
    const file = popup.el.importFile.files && popup.el.importFile.files[0];
    if (!file) {
        return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
        popup.showMessage('That file is too large', true);
        return;
    }

    let text;
    try {
        text = await file.text();
    }
    catch (e) {
        popup.showMessage('Could not read that file', true);
        return;
    }

    const result = readBackup(text);
    if (result) {
        // Nothing is stored until Save, so a bad import is undone by closing
        // the popup - worth saying, since import replaces rather than merges.
        popup.showMessage(result);
    }
    else {
        popup.showMessage(
            popup.sites.mode() === 'all' ? 'Choose Allowlist or Blocklist first' : 'No hostnames found',
            true,
        );
    }
});

/* ----------------------------------------------------------------- wiring - */

for (const radio of document.querySelectorAll('input[name="siteMode"]')) {
    radio.addEventListener('change', popup.sites.render);
}

popup.el.listText.addEventListener('input', () => {
    captureTextarea();
    renderCounts();
});
