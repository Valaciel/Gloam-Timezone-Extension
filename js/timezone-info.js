/* globals offsets */
'use strict';

/*
 * Timezone lookup.
 * ================
 *
 * Turns an IANA timezone name ("America/New_York") into the facts the rest of
 * the extension needs: what its offset is right now, what its offset is in
 * winter, and what to call it.
 *
 * The raw table lives in data/offsets.js as `offsets`.
 */

var timezoneInfo = {};

/**
 * Is this a timezone we actually know about?
 *
 * A plain `offsets[name]` check would wrongly accept inherited property names
 * like "constructor" or "toString", which are truthy on every object.
 */
timezoneInfo.isKnown = name => typeof name === 'string'
    && Object.prototype.hasOwnProperty.call(offsets, name);

/**
 * The zone's offset from UTC at a given moment, in minutes EAST of UTC.
 * New York in summer is -240.
 *
 * Works by formatting the moment as wall-clock text in the target zone and
 * reading it back as though it were UTC; the gap is the offset.
 */
function currentOffsetMinutes(timezoneName, when = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezoneName,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(when);

    const partValue = type => Number(parts.find(part => part.type === type).value);

    const asIfUtc = Date.UTC(
        partValue('year'),
        partValue('month') - 1,
        partValue('day'),
        partValue('hour'),
        partValue('minute'),
        partValue('second'),
    );

    return Math.round((asIfUtc - when.getTime()) / 60000);
}

/**
 * Last-resort labels for zones the table has no name for.
 * "Europe/Amsterdam" becomes "Amsterdam Standard Time".
 */
function labelsFromZoneName(timezoneName) {
    const city = timezoneName.split('/')[1];
    const readable = city ? city.replace(/[-_]/g, ' ') : timezoneName;
    return {
        standard: readable + ' Standard Time',
        daylight: readable + ' Daylight Time',
    };
}

/**
 * Everything known about a zone.
 *
 * Returns `{ offset, baseline: { offset, labels } }` where `offset` is the
 * live offset (daylight saving included) and `baseline.offset` is the zone's
 * ordinary winter offset. When the two differ, daylight saving is in effect.
 *
 * Unknown or malformed names fall back to Etc/GMT rather than throwing.
 */
timezoneInfo.describe = timezoneName => {
    if (!timezoneInfo.isKnown(timezoneName)) {
        timezoneName = 'Etc/GMT';
    }

    const entry = offsets[timezoneName];
    const labels = entry.msg ? { ...entry.msg } : labelsFromZoneName(timezoneName);

    // Zones without daylight saving only list one name; use it for both.
    if (!labels.daylight) {
        labels.daylight = labels.standard || labelsFromZoneName(timezoneName).daylight;
    }
    if (!labels.standard) {
        labels.standard = labels.daylight || labelsFromZoneName(timezoneName).standard;
    }

    return {
        offset: currentOffsetMinutes(timezoneName),
        baseline: {
            offset: entry.offset,
            labels,
        },
    };
};

/** True when daylight saving is currently active in this zone. */
timezoneInfo.isDaylightSavingNow = description => description.offset !== description.baseline.offset;
