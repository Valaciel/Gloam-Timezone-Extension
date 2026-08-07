'use strict';

/*
 * Shared popup plumbing.
 * ======================
 *
 * Element references and the few helpers used by more than one popup file.
 * Loaded first; everything else builds on it.
 */

var popup = {};

/** Every element the popup touches, looked up once. */
popup.el = {
    form: document.getElementById('form'),
    enabled: document.getElementById('enabled'),
    status: document.getElementById('status'),
    statusText: document.getElementById('statusText'),
    notice: document.getElementById('notice'),

    zoneSearch: document.getElementById('zoneSearch'),
    zoneSelect: document.getElementById('zoneSelect'),
    zonePreview: document.getElementById('zonePreview'),
    randomPerTab: document.getElementById('randomPerTab'),

    listSection: document.getElementById('listSection'),
    listHint: document.getElementById('listHint'),
    listText: document.getElementById('listText'),
    listCounts: document.getElementById('listCounts'),
    exportButton: document.getElementById('exportButton'),
    importButton: document.getElementById('importButton'),
    importFile: document.getElementById('importFile'),

    connectionsBadge: document.getElementById('connectionsBadge'),
    connectionsSummary: document.getElementById('connectionsSummary'),
    connectionsNote: document.getElementById('connectionsNote'),
    connectionsList: document.getElementById('connectionsList'),
    connectionsRefresh: document.getElementById('connectionsRefresh'),
    connectionsAddAll: document.getElementById('connectionsAddAll'),

    aboutVersion: document.getElementById('aboutVersion'),

    resetButton: document.getElementById('resetButton'),
    message: document.getElementById('message'),
};

/** Sends a request to the background worker, as a promise. */
popup.ask = request => new Promise(resolve => {
    chrome.runtime.sendMessage(request, response => {
        resolve(chrome.runtime.lastError ? null : response);
    });
});

let messageTimer = 0;

/** Brief feedback in the footer. */
popup.showMessage = (text, isError = false) => {
    popup.el.message.textContent = text;
    popup.el.message.classList.toggle('is-error', isError);
    popup.el.message.classList.add('is-visible');

    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => popup.el.message.classList.remove('is-visible'), 2200);
};

/** Splits textarea content into trimmed, non-empty lines. */
popup.linesOf = text => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

/** Formats minutes east of UTC as "UTC-05:00". */
popup.formatUtcOffset = minutes => {
    const sign = minutes < 0 ? '-' : '+';
    const absolute = Math.abs(minutes);
    const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
    const remainder = String(absolute % 60).padStart(2, '0');
    return `UTC${sign}${hours}:${remainder}`;
};
