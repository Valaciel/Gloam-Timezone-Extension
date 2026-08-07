/* globals offsets, popup */
'use strict';

/*
 * The timezone picker.
 * ====================
 *
 * The filter box, the dropdown, the "sites will see..." preview, and the
 * random-per-tab switch.
 */

popup.zones = {};

// Sorted east to west, so the list reads like a map rather than an alphabet.
const ZONE_NAMES = Object.keys(offsets)
    .sort((a, b) => offsets[b].offset - offsets[a].offset || a.localeCompare(b));

/*
 * The chosen zone is tracked here rather than read off the <select>. Filtering
 * rebuilds the options, and if we trusted the element's value a filter that
 * matched nothing would silently reset the user's choice.
 */
let selectedZone = 'Etc/GMT';

popup.zones.selected = () => selectedZone;

/** Rebuilds the dropdown, showing only zones matching the filter text. */
function renderOptions(filterText) {
    // Treat "/" and "_" as spaces so "new york" finds "America/New_York".
    const needle = filterText.trim().toLowerCase().replace(/[_/]/g, ' ');

    const visible = needle
        ? ZONE_NAMES.filter(name => name.toLowerCase().replace(/[_/]/g, ' ').includes(needle))
        : ZONE_NAMES.slice();

    // The current choice always stays in the list so a filter cannot drop it.
    if (!visible.includes(selectedZone)) {
        visible.unshift(selectedZone);
    }

    const options = document.createDocumentFragment();
    for (const name of visible) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = `${name.replace(/_/g, ' ')}  ·  ${popup.formatUtcOffset(offsets[name].offset)}`;
        options.appendChild(option);
    }

    popup.el.zoneSelect.replaceChildren(options);
    popup.el.zoneSelect.value = selectedZone;
}

/** Shows what the current time looks like in the chosen zone. */
function renderPreview() {
    if (popup.el.randomPerTab.checked) {
        popup.el.zonePreview.textContent = 'Each tab gets its own random zone';
        return;
    }

    try {
        const time = new Intl.DateTimeFormat(undefined, {
            timeZone: selectedZone,
            weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
        }).format(new Date());
        popup.el.zonePreview.textContent = `Sites will see ${time}`;
    }
    catch (e) {
        popup.el.zonePreview.textContent = ' ';
    }
}

popup.zones.render = () => {
    renderOptions(popup.el.zoneSearch.value);
    renderPreview();
};

/** Sets the picker up from stored settings. */
popup.zones.load = current => {
    selectedZone = Object.prototype.hasOwnProperty.call(offsets, current.timezone)
        ? current.timezone
        : 'Etc/GMT';

    popup.el.randomPerTab.checked = current.randomPerTab === true;

    popup.zones.render();
    updateRandomState();
};

/** Random mode chooses the zone for you, so the manual controls switch off. */
function updateRandomState() {
    const isRandom = popup.el.randomPerTab.checked;
    popup.el.zoneSelect.disabled = isRandom;
    popup.el.zoneSearch.disabled = isRandom;
    renderPreview();
}

popup.el.zoneSearch.addEventListener('input', () => renderOptions(popup.el.zoneSearch.value));

popup.el.zoneSelect.addEventListener('change', () => {
    selectedZone = popup.el.zoneSelect.value;
    renderPreview();
});

popup.el.randomPerTab.addEventListener('change', updateRandomState);
