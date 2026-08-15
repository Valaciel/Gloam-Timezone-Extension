'use strict';

/*
 * The timezone hook.
 * =================
 *
 * This is the code that actually lies to the page. It replaces `Date` and
 * `Intl.DateTimeFormat` so that every way a page can ask "what timezone is
 * this browser in?" gets the same made-up answer.
 *
 * There are two questions a page can ask, and they must never disagree:
 *
 *   1. The zone NAME   - Intl.DateTimeFormat().resolvedOptions().timeZone
 *   2. The WALL CLOCK  - new Date().getTimezoneOffset(), .getHours(), .toString()
 *
 * Patching only one of them is trivially detectable, so we do both. `Temporal`
 * asks the same two questions through its own door, so it is covered too.
 *
 * This file only DEFINES the function. It never runs on its own. Three
 * different places load it and run it:
 *
 *   - background.js  reads its source and registers it as an early-running
 *                    user script (the fast path that always wins the race)
 *   - content-script.js  runs it as a fallback when that path is unavailable
 *   - the hook itself    re-runs it inside any Web Worker the page creates
 *
 * It must therefore never touch `document` or anything else that only exists
 * in a normal page - Web Workers have no DOM.
 */

// eslint-disable-next-line no-unused-vars
var installTimezoneHook = function installTimezoneHook(settings) {
    if (!Array.isArray(settings) || settings.length < 4) {
        return;
    }

    // Guard against running twice in one context. This matters because the
    // fast path and the fallback path can both fire on the same page; whoever
    // gets there first wins and the second one quietly does nothing.
    const INSTALLED_FLAG = '__gloam_timezone_installed__';
    if (Object.prototype.hasOwnProperty.call(globalThis, INSTALLED_FLAG)) {
        return;
    }
    Object.defineProperty(globalThis, INSTALLED_FLAG, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
    });

    const [
        timezoneName, chosenOffsetMinutes, , fallbackZoneLabel,
        inheritedBaseUrl, statusChannel,
    ] = settings;

    /* ------------------------------------------------------------------ *
     * Telling the toolbar dot what happened
     *
     * The content script sits in the extension's isolated world and cannot
     * see anything we do in here, so we leave it a note somewhere both worlds
     * can reach: an attribute on <html>. The attribute NAME is a random value
     * the extension generates each browser session and hands to both sides, so
     * a page cannot simply watch for a name it knows in advance. The content
     * script removes the attribute as soon as it has read it.
     *
     * Workers have no DOM, so there this is a no-op - which costs us nothing,
     * because the one worker leak we can detect is detected out here in the
     * page, at the moment we hand back an unpatched worker.
     * ------------------------------------------------------------------ */

    const reportStatus = (() => {
        if (!statusChannel || typeof document === 'undefined') {
            return () => {};
        }

        let latest = null;

        const write = () => {
            const root = document.documentElement;
            if (!root || !latest) {
                return;
            }
            try {
                root.setAttribute(statusChannel, latest);
            }
            catch (e) {
                // Nothing useful to do; the dot stays unverified, which is the
                // honest answer when we cannot confirm anything.
            }
        };

        return status => {
            // Once something has leaked, it stays leaked. "masked" is the only
            // status a later one is allowed to overwrite.
            if (latest !== null && latest !== 'masked') {
                return;
            }
            latest = status;

            // At document_start <html> can still be a moment away.
            if (document.documentElement) {
                write();
            }
            else {
                setTimeout(write, 0);
            }
        };
    })();

    /*
     * What relative worker URLs are resolved against.
     *
     * Normally that is just the current location. Inside a worker we started,
     * though, `location` is the generated blob: URL we booted it from, which
     * relative paths cannot resolve against - so we pass the worker's real
     * script URL down as a fifth setting and use that instead.
     */
    const baseUrlForWorkers = inheritedBaseUrl
        || (globalThis.location ? globalThis.location.href : undefined);

    // Grab the real implementations before we start replacing things.
    const RealDate = Date;
    const RealDateTimeFormat = Intl.DateTimeFormat;
    const realGetTimezoneOffset = RealDate.prototype.getTimezoneOffset;
    const realFunctionToString = Function.prototype.toString;

    // Our own source code, captured now so we can re-inject it into any Web
    // Worker later. It has to be read before we start masking toString(),
    // otherwise we would read back the fake "[native code]" string.
    const hookSource = realFunctionToString.call(installTimezoneHook);

    /* ================================================================== *
     * Disguising our functions as native ones
     *
     * A page can detect a patched builtin by printing it:
     *     Date.toString()  ->  "class ShiftedDate extends ..."  (busted)
     * Real builtins print as "function Date() { [native code] }", so we keep
     * a registry of our replacements and make toString() lie about them.
     * ================================================================== */

    const nativeLookalikes = new WeakMap();

    const markAsNative = (fn, displayName) => {
        try {
            Object.defineProperty(fn, 'name', { value: displayName, configurable: true });
        }
        catch (e) {
            // Some functions have a non-configurable name; the toString
            // disguise below still applies, which is the part pages check.
        }
        nativeLookalikes.set(fn, displayName);
        return fn;
    };

    const fakeFunctionToString = function toString() {
        const displayName = nativeLookalikes.get(this);
        if (displayName !== undefined) {
            return 'function ' + displayName + '() { [native code] }';
        }
        // Anything we did not touch prints its real source, as it should.
        return realFunctionToString.call(this);
    };
    markAsNative(fakeFunctionToString, 'toString');
    Function.prototype.toString = fakeFunctionToString;

    /* ================================================================== *
     * Working out the offset for a given moment
     *
     * A fixed offset would be a giveaway: a genuine America/New_York browser
     * reports -300 in January and -240 in July. So instead of trusting one
     * stored number, we ask the browser's own timezone database what the
     * offset was at each specific moment.
     *
     * The trick: format the timestamp as wall-clock text in the target zone,
     * then read that text back as if it were UTC. The gap between the two is
     * the zone's offset at that moment.
     * ================================================================== */

    const zonePartsFormatter = new RealDateTimeFormat('en-US', {
        timeZone: timezoneName,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    });

    const zoneLabelFormatter = new RealDateTimeFormat('en-US', {
        timeZone: timezoneName,
        timeZoneName: 'long',
    });

    // Offsets and labels only change at DST boundaries, so results are cached
    // per hour. Without this, date-heavy pages would pay for a full Intl
    // format on every single Date they construct.
    const offsetCache = new Map();
    const labelCache = new Map();
    const cacheKeyFor = milliseconds => Math.floor(milliseconds / 3600000);

    const forgetOldest = cache => {
        if (cache.size > 4096) {
            cache.clear();
        }
    };

    /**
     * The offset of the fake zone at a given moment, in getTimezoneOffset()'s
     * convention: minutes to ADD to local time to reach UTC. So New York in
     * summer is +240, not -240.
     */
    const zoneOffsetAt = milliseconds => {
        if (!Number.isFinite(milliseconds)) {
            return chosenOffsetMinutes;
        }

        const key = cacheKeyFor(milliseconds);
        const cached = offsetCache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        let offset;
        try {
            const parts = zonePartsFormatter.formatToParts(new RealDate(milliseconds));
            const partValue = type => {
                const part = parts.find(candidate => candidate.type === type);
                return part ? Number(part.value) : 0;
            };

            const year = partValue('year');
            let asIfUtc = RealDate.UTC(
                year, partValue('month') - 1, partValue('day'),
                partValue('hour'), partValue('minute'), partValue('second'),
            );

            // Date.UTC maps years 0-99 onto 1900-1999; undo that for old dates.
            if (year >= 0 && year < 100) {
                const corrected = new RealDate(asIfUtc);
                corrected.setUTCFullYear(year);
                asIfUtc = corrected.getTime();
            }

            offset = -Math.round((asIfUtc - milliseconds) / 60000);
        }
        catch (e) {
            offset = chosenOffsetMinutes;
        }

        forgetOldest(offsetCache);
        offsetCache.set(key, offset);
        return offset;
    };

    /** The zone's human label at a moment, e.g. "Eastern Daylight Time". */
    const zoneLabelAt = milliseconds => {
        if (!Number.isFinite(milliseconds)) {
            return fallbackZoneLabel;
        }

        const key = cacheKeyFor(milliseconds);
        const cached = labelCache.get(key);
        if (cached !== undefined) {
            return cached;
        }

        let label = fallbackZoneLabel;
        try {
            const parts = zoneLabelFormatter.formatToParts(new RealDate(milliseconds));
            const namePart = parts.find(candidate => candidate.type === 'timeZoneName');
            if (namePart && namePart.value) {
                label = namePart.value;
            }
        }
        catch (e) {
            // Keep the stored fallback label.
        }

        forgetOldest(labelCache);
        labelCache.set(key, label);
        return label;
    };

    /*
     * If the user hand-edited the offset in Advanced settings, their number
     * won't match what the zone database says. We keep that difference and
     * apply it on top of the real DST-aware offset, so a manual tweak still
     * behaves correctly across a DST boundary.
     */
    const manualAdjustmentMinutes = (() => {
        const difference = chosenOffsetMinutes - zoneOffsetAt(RealDate.now());
        return Number.isFinite(difference) ? difference : 0;
    })();

    /** What we tell the page its offset is, at a given moment. */
    const fakeOffsetAt = milliseconds => zoneOffsetAt(milliseconds) + manualAdjustmentMinutes;

    /** What this machine's offset actually is, at a given moment. */
    const realOffsetAt = milliseconds => realGetTimezoneOffset.call(new RealDate(milliseconds));

    /*
     * How far to slide a timestamp so that reading it with the machine's real
     * clock produces the wall-clock time of the fake zone. This is the single
     * idea the whole Date patch is built on.
     */
    const clockShiftAt = milliseconds => (realOffsetAt(milliseconds) - fakeOffsetAt(milliseconds)) * 60000;

    /* ================================================================== *
     * Intl.DateTimeFormat
     *
     * Every formatter defaults to our fake zone. If the page explicitly asks
     * for a specific zone we honour that - a page formatting a meeting in
     * Asia/Tokyo should still get Tokyo.
     * ================================================================== */

    function DateTimeFormat(locales, options) {
        const formatterOptions = { ...(options || {}) };
        if (formatterOptions.timeZone === undefined) {
            formatterOptions.timeZone = timezoneName;
        }

        const realFormatter = new RealDateTimeFormat(locales, formatterOptions);

        // A Proxy lets every method work exactly as normal while we override
        // just the one call that would reveal the substitution.
        return new Proxy(realFormatter, {
            get(target, property) {
                if (property === 'resolvedOptions') {
                    const reportOptions = () => {
                        const report = RealDateTimeFormat.prototype.resolvedOptions.call(target);
                        report.timeZone = formatterOptions.timeZone;
                        return report;
                    };
                    return markAsNative(reportOptions, 'resolvedOptions');
                }

                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }

    DateTimeFormat.prototype = RealDateTimeFormat.prototype;
    DateTimeFormat.supportedLocalesOf = markAsNative(
        (...args) => RealDateTimeFormat.supportedLocalesOf(...args),
        'supportedLocalesOf',
    );
    markAsNative(DateTimeFormat, 'DateTimeFormat');
    Intl.DateTimeFormat = DateTimeFormat;

    /* ================================================================== *
     * Date
     * ================================================================== */

    // The unpatched methods, saved so our replacements can call through.
    const {
        getTime, setTime,
        getDate, getDay, getFullYear, getHours, getMilliseconds, getMinutes,
        getMonth, getSeconds, getYear,
        toDateString, toLocaleString, toString, toTimeString,
        toLocaleTimeString, toLocaleDateString, toISOString,
        setYear, setHours, setFullYear, setMilliseconds, setMinutes, setMonth,
        setSeconds, setDate,
        setUTCDate, setUTCFullYear, setUTCHours, setUTCMilliseconds,
        setUTCMinutes, setUTCMonth, setUTCSeconds,
    } = RealDate.prototype;

    /*
     * Each fake Date keeps a hidden partner date, slid forward or back so that
     * reading it with the machine's real clock yields the fake zone's wall
     * clock. All the "local time" getters read from the partner; everything
     * absolute (getTime, toISOString) reads from the real one.
     *
     * The partner lives in a WeakMap rather than on the object, because an own
     * property would show up in Object.keys() and give the game away.
     */
    const localViews = new WeakMap();

    const localViewOf = date => {
        let view = localViews.get(date);
        if (view === undefined) {
            const timestamp = getTime.call(date);
            view = new RealDate(Number.isFinite(timestamp) ? timestamp + clockShiftAt(timestamp) : NaN);
            localViews.set(date, view);
        }
        return view;
    };

    /** Re-slide the partner after the real timestamp has been changed. */
    const refreshLocalView = date => {
        const timestamp = getTime.call(date);
        const view = localViewOf(date);
        setTime.call(view, Number.isFinite(timestamp) ? timestamp + clockShiftAt(timestamp) : NaN);
    };

    /*
     * Inputs written without a zone - new Date(2026, 0, 1) or
     * new Date("2026-07-04T09:15") - are defined as LOCAL time. The engine
     * reads them in the machine's real zone, which is the wrong answer for us.
     * We work backwards to find the real timestamp whose FAKE wall clock is
     * what was actually written.
     */
    const ISO_DATE_WITHOUT_TIME = /^\d{4}(-\d{2}(-\d{2})?)?$/;
    const ENDS_WITH_EXPLICIT_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

    const stringMeansLocalTime = value => {
        const text = String(value).trim();
        if (!text) {
            return false;
        }
        // Date-only ISO strings are defined as UTC, not local.
        if (ISO_DATE_WITHOUT_TIME.test(text)) {
            return false;
        }
        // Anything carrying its own zone already has an unambiguous answer.
        if (ENDS_WITH_EXPLICIT_ZONE.test(text)) {
            return false;
        }
        return !/\b(?:GMT|UTC|[A-Z]{3,5}T)\b/.test(text);
    };

    const argumentsMeanLocalTime = args => {
        if (args.length >= 2) {
            return true;
        }
        return args.length === 1 && typeof args[0] === 'string' && stringMeansLocalTime(args[0]);
    };

    const reinterpretAsFakeLocalTime = timestamp => {
        if (!Number.isFinite(timestamp)) {
            return timestamp;
        }
        // We want the real timestamp R where R + clockShiftAt(R) === timestamp.
        // One refinement pass settles the answer around DST boundaries.
        const firstGuess = timestamp - clockShiftAt(timestamp);
        return timestamp - clockShiftAt(firstGuess);
    };

    /* -------------------------------- rewriting Date.toString() output --- */

    const padToTwoDigits = value => (value < 10 ? '0' : '') + value;

    /** Turns +240 into "-0400", matching what Date.toString() prints. */
    const formatGmtOffset = offsetMinutes => {
        const sign = offsetMinutes <= 0 ? '+' : '-';
        const absolute = Math.abs(offsetMinutes);
        return sign + padToTwoDigits((absolute / 60) | 0) + padToTwoDigits(absolute % 60);
    };

    /*
     * Date.toString() prints like:
     *     "Sat Jul 04 2026 13:30:00 GMT+0100 (British Summer Time)"
     * The partner date supplies the right numbers but the wrong tail, so we
     * swap the offset and the zone label for the fake zone's versions.
     */
    const rewriteZoneInDateString = (text, milliseconds) => {
        if (typeof text !== 'string' || !Number.isFinite(milliseconds)) {
            return text;
        }

        // Matches the "+0100" in "GMT+0100" and in "(GMT+0100)".
        text = text.replace(/([T(])[+-]\d{4}/g, '$1' + formatGmtOffset(fakeOffsetAt(milliseconds)));

        const labelStart = text.indexOf(' (');
        if (labelStart !== -1) {
            text = text.slice(0, labelStart) + ' (' + zoneLabelAt(milliseconds) + ')';
        }
        return text;
    };

    /* ------------------------------------------------ the replacement --- */

    /**
     * Applies a "local time" setter (setHours, setDate, ...). The change is
     * made on the partner date, then the same amount of movement is mirrored
     * onto the real timestamp.
     */
    function setViaLocalClock(date, setter, args) {
        const view = localViewOf(date);
        const before = getTime.call(view);
        const after = setter.apply(view, args);
        setTime.call(date, getTime.call(date) + (after - before));
        return after;
    }

    /**
     * Applies a UTC setter (setUTCHours, setTime, ...). Those are absolute, so
     * they act on the real timestamp and the partner is recomputed.
     */
    function setViaUtcClock(date, setter, args) {
        const result = setter.apply(date, args);
        refreshLocalView(date);
        return result;
    }

    class FakeZoneDate extends RealDate {
        constructor(...args) {
            super(...args);
            if (argumentsMeanLocalTime(args)) {
                setTime.call(this, reinterpretAsFakeLocalTime(getTime.call(this)));
            }
            localViewOf(this);
        }

        // --- local-time readers: answered from the partner date ---
        toLocaleString(...args) { return toLocaleString.apply(localViewOf(this), args); }
        toLocaleTimeString(...args) { return toLocaleTimeString.apply(localViewOf(this), args); }
        toLocaleDateString(...args) { return toLocaleDateString.apply(localViewOf(this), args); }
        toDateString(...args) { return toDateString.apply(localViewOf(this), args); }
        getDate(...args) { return getDate.apply(localViewOf(this), args); }
        getDay(...args) { return getDay.apply(localViewOf(this), args); }
        getFullYear(...args) { return getFullYear.apply(localViewOf(this), args); }
        getHours(...args) { return getHours.apply(localViewOf(this), args); }
        getMilliseconds(...args) { return getMilliseconds.apply(localViewOf(this), args); }
        getMinutes(...args) { return getMinutes.apply(localViewOf(this), args); }
        getMonth(...args) { return getMonth.apply(localViewOf(this), args); }
        getSeconds(...args) { return getSeconds.apply(localViewOf(this), args); }
        getYear(...args) { return getYear.apply(localViewOf(this), args); }

        // --- local-time writers ---
        setHours(...args) { return setViaLocalClock(this, setHours, args); }
        setFullYear(...args) { return setViaLocalClock(this, setFullYear, args); }
        setMilliseconds(...args) { return setViaLocalClock(this, setMilliseconds, args); }
        setMinutes(...args) { return setViaLocalClock(this, setMinutes, args); }
        setMonth(...args) { return setViaLocalClock(this, setMonth, args); }
        setSeconds(...args) { return setViaLocalClock(this, setSeconds, args); }
        setDate(...args) { return setViaLocalClock(this, setDate, args); }
        setYear(...args) { return setViaLocalClock(this, setYear, args); }

        // --- absolute writers ---
        setTime(...args) { return setViaUtcClock(this, setTime, args); }
        setUTCDate(...args) { return setViaUtcClock(this, setUTCDate, args); }
        setUTCFullYear(...args) { return setViaUtcClock(this, setUTCFullYear, args); }
        setUTCHours(...args) { return setViaUtcClock(this, setUTCHours, args); }
        setUTCMilliseconds(...args) { return setViaUtcClock(this, setUTCMilliseconds, args); }
        setUTCMinutes(...args) { return setViaUtcClock(this, setUTCMinutes, args); }
        setUTCMonth(...args) { return setViaUtcClock(this, setUTCMonth, args); }
        setUTCSeconds(...args) { return setViaUtcClock(this, setUTCSeconds, args); }

        // --- text with a zone in it ---
        toString(...args) {
            return rewriteZoneInDateString(toString.apply(localViewOf(this), args), getTime.call(this));
        }
        toTimeString(...args) {
            return rewriteZoneInDateString(toTimeString.apply(localViewOf(this), args), getTime.call(this));
        }

        /*
         * Absolute values are deliberately left alone. The instant in time is
         * genuine - only its local interpretation is faked - so timestamps
         * sent to a server stay correct and nothing breaks.
         */
        toISOString(...args) { return toISOString.apply(this, args); }
        toJSON() { return toISOString.call(this); }
        valueOf() { return getTime.call(this); }
        getTime(...args) { return getTime.apply(this, args); }

        getTimezoneOffset() { return fakeOffsetAt(getTime.call(this)); }
    }

    FakeZoneDate.now = markAsNative(() => RealDate.now(), 'now');
    FakeZoneDate.UTC = markAsNative((...args) => RealDate.UTC(...args), 'UTC');
    FakeZoneDate.parse = markAsNative(function parse(value) {
        const timestamp = RealDate.parse(value);
        return typeof value === 'string' && stringMeansLocalTime(value)
            ? reinterpretAsFakeLocalTime(timestamp)
            : timestamp;
    }, 'parse');

    // Real dates made before we loaded should still pass `x instanceof Date`.
    Object.defineProperty(FakeZoneDate, Symbol.hasInstance, {
        value: value => value instanceof RealDate,
        configurable: true,
    });

    markAsNative(FakeZoneDate, 'Date');
    for (const methodName of Object.getOwnPropertyNames(FakeZoneDate.prototype)) {
        if (methodName === 'constructor') {
            continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(FakeZoneDate.prototype, methodName);
        if (descriptor && typeof descriptor.value === 'function') {
            markAsNative(descriptor.value, methodName);
        }
    }

    globalThis.Date = FakeZoneDate;

    /* ================================================================== *
     * Temporal
     *
     * Temporal asks the same two questions as Date, through a different door,
     * and none of the work above covers it:
     *
     *   Temporal.Now.timeZoneId()          hands out the zone name outright
     *   Temporal.Now.plainDateTimeISO()    reads the wall clock
     *   Temporal.Now.zonedDateTimeISO()    both at once
     *
     * Each of those (except timeZoneId) takes an optional zone and falls back
     * to the system one, so all we have to do is change what "no zone given"
     * means.
     *
     * We answer with the IANA zone NAME rather than a fixed offset. That keeps
     * Temporal's own timezone database in charge of daylight saving, and keeps
     * its answers consistent with what Intl.DateTimeFormat reports - the two
     * disagreeing would be exactly the tell we are trying to avoid.
     *
     * The one thing that does not carry across is a hand-edited offset from
     * Advanced settings: Temporal is told a zone, not an adjustment, so it
     * reports that zone's real offset.
     * ================================================================== */

    const TemporalNamespace = globalThis.Temporal;

    if (TemporalNamespace && typeof TemporalNamespace === 'object') {
        /** Replaces a method, quietly giving up if the property is locked. */
        const replaceMethod = (owner, methodName, build) => {
            const realMethod = owner[methodName];
            if (typeof realMethod !== 'function') {
                return;
            }
            const replacement = build(realMethod);
            markAsNative(replacement, methodName);
            try {
                owner[methodName] = replacement;
            }
            catch (e) {
                // Non-writable in this engine; leave the original in place.
            }
        };

        const TemporalNow = TemporalNamespace.Now;

        if (TemporalNow && typeof TemporalNow === 'object') {
            // These all read "now" in a zone, defaulting to the system zone.
            for (const methodName of [
                'zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO',
            ]) {
                replaceMethod(TemporalNow, methodName, realMethod =>
                    function (timeZone, ...rest) {
                        return realMethod.call(
                            TemporalNow,
                            timeZone === undefined ? timezoneName : timeZone,
                            ...rest,
                        );
                    });
            }

            // The blunt one: it just returns the system zone's name.
            replaceMethod(TemporalNow, 'timeZoneId', () => function timeZoneId() {
                return timezoneName;
            });

            /*
             * Temporal.Now.instant() is deliberately untouched, for the same
             * reason Date.now() is: it names a moment, not a local reading of
             * one, so it is not ours to lie about.
             */
        }

        /*
         * An Instant is absolute, but rendering one for a human has to pick a
         * zone, and toLocaleString() picks the system's. Same substitution.
         *
         * Instant.prototype.toString() is left alone on purpose: it defaults
         * to UTC, not to the system zone, so it gives nothing away.
         */
        const Instant = TemporalNamespace.Instant;

        if (Instant && Instant.prototype) {
            replaceMethod(Instant.prototype, 'toLocaleString', realMethod =>
                function toLocaleString(locales, options) {
                    const withZone = { ...(options && typeof options === 'object' ? options : {}) };
                    if (withZone.timeZone === undefined) {
                        withZone.timeZone = timezoneName;
                    }
                    return realMethod.call(this, locales, withZone);
                });
        }
    }

    /* ================================================================== *
     * Web Workers
     *
     * A worker is a fresh JavaScript context with its own untouched Date, so
     * without this a page could just do:
     *
     *     new Worker(url)  ->  worker posts back new Date().getTimezoneOffset()
     *
     * ...and read the machine's real timezone straight through the patch.
     *
     * We can't reach inside a worker after it starts, so we replace the script
     * it boots from: a small generated script that installs this hook first,
     * then loads the page's real worker code.
     *
     * The replacement has to be a blob: URL, and that is not free. On a site
     * whose policy forbids blob: workers it does not fail quietly - the worker
     * constructs, dies a moment later, and whatever it was running is gone from
     * the page. So the rule we go by is: do nothing at the URL layer that the
     * site has not already committed to itself.
     *
     *   inline worker      new Worker(URL.createObjectURL(blob)), or a data:
     *                      URL. The site just minted one, so blob: workers
     *                      plainly run here. Always rewritten.
     *
     *   URL worker         new Worker('/w.js'). Rewriting is our idea, not the
     *                      site's, so it waits on a probe that says blob:
     *                      workers are allowed - and where they are not, the
     *                      worker is passed through untouched.
     *
     * A worker we passed through sees the real timezone. That is worth saying
     * out loud in the popup, and it is NOT the same thing as the page itself
     * leaking, so it does not turn the toolbar dot red.
     * ================================================================== */

    /* ------------------------------------------------------------------ *
     * Repairing relative URLs inside a worker we booted
     *
     * We start workers from a generated blob: script, which means the worker's
     * own `location` is that blob rather than the script the page asked for.
     * Anything the worker resolves relatively - importScripts('./chunk.js'),
     * fetch('./data.json'), a nested worker - would resolve against the blob
     * and fail.
     *
     * So whenever we are running inside a worker we started, we point those
     * APIs back at the real script URL. This only applies there; in a normal
     * page `inheritedBaseUrl` is undefined and none of it runs.
     * ------------------------------------------------------------------ */

    if (inheritedBaseUrl) {
        const resolveFromRealScript = value => {
            try {
                return new URL(String(value), inheritedBaseUrl).href;
            }
            catch (e) {
                return value;
            }
        };

        if (typeof globalThis.importScripts === 'function') {
            const realImportScripts = globalThis.importScripts;
            globalThis.importScripts = markAsNative(
                (...urls) => realImportScripts.apply(globalThis, urls.map(resolveFromRealScript)),
                'importScripts',
            );
        }

        if (typeof globalThis.fetch === 'function') {
            const realFetch = globalThis.fetch;
            globalThis.fetch = markAsNative(
                (input, init) => realFetch.call(
                    globalThis,
                    typeof input === 'string' ? resolveFromRealScript(input) : input,
                    init,
                ),
                'fetch',
            );
        }

        if (typeof globalThis.XMLHttpRequest === 'function') {
            const realOpen = globalThis.XMLHttpRequest.prototype.open;
            globalThis.XMLHttpRequest.prototype.open = markAsNative(
                function open(method, url, ...rest) {
                    return realOpen.call(this, method, resolveFromRealScript(url), ...rest);
                },
                'open',
            );
        }

        // Code that works out its own base path from location.href - a common
        // trick for locating a .wasm file - should see the real script URL too.
        try {
            const realScriptLocation = new URL(inheritedBaseUrl);
            Object.defineProperty(globalThis, 'location', {
                configurable: true,
                get: () => realScriptLocation,
            });
        }
        catch (e) {
            // Not redefinable here; the API patches above still cover most uses.
        }
    }

    const canCreateBlobUrls = typeof globalThis.Blob === 'function'
        && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';

    // Captured before the shim below goes on, so our own blob URLs neither go
    // through it nor end up tracked.
    const realCreateObjectURL = canCreateBlobUrls ? URL.createObjectURL.bind(URL) : null;
    const realRevokeObjectURL = canCreateBlobUrls ? URL.revokeObjectURL.bind(URL) : null;

    /* ------------------------------------------------------------------ *
     * Holding on to the page's own worker blobs
     *
     * When a page builds a worker inline - new Worker(URL.createObjectURL(blob))
     * - the only way to get in front of its code is to read that code. Every
     * route that reads a blob: URL at runtime goes through the network layer:
     * fetch and XHR are governed by connect-src, importScripts and <script src>
     * by script-src. A strict policy commonly allows blob: under worker-src and
     * nowhere else, so all of them are refused.
     *
     * The one thing no directive governs is holding the Blob object itself. So
     * we shim URL.createObjectURL, keep the Blob it was handed, and later build
     * `new Blob([prelude, thatBlob])` - concatenation in memory, no request, no
     * directive to violate.
     *
     * The reference is weak and dropped on revokeObjectURL, so this never keeps
     * a page's blobs alive past their welcome.
     * ------------------------------------------------------------------ */

    const trackedBlobs = new Map();

    /*
     * A page is under no obligation to revoke the URLs it mints, and some churn
     * through thousands of them - image previews, downloads, video segments. The
     * Blob references are weak, so those pages are not held in memory by us, but
     * the map entries themselves would pile up. So once the map is big enough to
     * notice, drop every entry whose Blob has already been collected.
     */
    const TRACKED_BLOB_LIMIT = 256;

    const pruneTrackedBlobs = () => {
        for (const [url, reference] of trackedBlobs) {
            if (!reference.deref()) {
                trackedBlobs.delete(url);
            }
        }

        // Everything is still live: this page is genuinely holding that many
        // blobs at once. Forget the oldest rather than grow without limit - a
        // worker built from one of those would run unpatched, which is the same
        // outcome as any other blob we cannot read.
        while (trackedBlobs.size > TRACKED_BLOB_LIMIT) {
            trackedBlobs.delete(trackedBlobs.keys().next().value);
        }
    };

    if (canCreateBlobUrls) {
        const WeakReference = typeof WeakRef === 'function' ? WeakRef : null;

        URL.createObjectURL = markAsNative(object => {
            const url = realCreateObjectURL(object);
            try {
                if (object instanceof Blob) {
                    if (trackedBlobs.size >= TRACKED_BLOB_LIMIT) {
                        pruneTrackedBlobs();
                    }
                    trackedBlobs.set(url, WeakReference
                        ? new WeakReference(object)
                        : { deref: () => object });
                }
            }
            catch (e) {
                // instanceof can throw across realms; not worth tracking then.
            }
            return url;
        }, 'createObjectURL');

        URL.revokeObjectURL = markAsNative(url => {
            trackedBlobs.delete(url);
            return realRevokeObjectURL(url);
        }, 'revokeObjectURL');
    }

    /** The Blob a blob: URL was minted from, if we still have it. */
    const trackedBlobFor = url => {
        const reference = trackedBlobs.get(url);
        if (!reference) {
            return null;
        }
        const blob = reference.deref();
        if (!blob) {
            trackedBlobs.delete(url);
            return null;
        }
        return blob;
    };

    /** The source text of a data: URL, or null if it will not decode. */
    const decodeDataUrl = url => {
        const comma = url.indexOf(',');
        if (comma === -1) {
            return null;
        }
        const meta = url.slice(5, comma);
        const body = url.slice(comma + 1);
        try {
            return meta.includes(';base64') ? atob(body) : decodeURIComponent(body);
        }
        catch (e) {
            return null;
        }
    };

    /*
     * Can we run a blob: worker on this page?
     *
     * Only asked about workers the page started from an ordinary URL, where
     * rewriting to a blob: is a change the site never asked for. Plenty of
     * sites set a Content-Security-Policy that forbids them, and a blocked
     * worker does NOT throw - it constructs happily and then fires an error
     * event a moment later, far too late for us to quietly hand back an
     * unmodified worker instead. Rewriting optimistically would take the
     * feature that worker was running off the page entirely.
     *
     * So we settle the question once with a throwaway worker, and leave
     * URL-based workers alone until it comes back.
     */
    let blobWorkersAllowed = false;

    const probeBlobWorkerSupport = RealWorkerConstructor => {
        let probeUrl = null;
        try {
            probeUrl = realCreateObjectURL(new Blob(['self.postMessage(0);'], { type: 'text/javascript' }));
            const probe = new RealWorkerConstructor(probeUrl);

            const finish = allowed => {
                blobWorkersAllowed = allowed;
                try {
                    probe.terminate();
                }
                catch (e) {
                    // Already gone.
                }
                realRevokeObjectURL(probeUrl);
            };

            probe.onmessage = () => finish(true);
            probe.onerror = () => finish(false);
        }
        catch (e) {
            if (probeUrl) {
                realRevokeObjectURL(probeUrl);
            }
        }
    };

    /**
     * The code that boots a worker: install this hook, then load the script the
     * page actually asked for.
     *
     * The worker is told to resolve its own relative URLs against the script it
     * is really running, so a worker that starts another worker still works.
     */
    const workerPreludeFor = realScriptUrl => {
        const workerSettings = [
            timezoneName, chosenOffsetMinutes, settings[2], fallbackZoneLabel,
            realScriptUrl, statusChannel,
        ];
        return '(' + hookSource + ')(' + JSON.stringify(workerSettings) + ');\n';
    };

    /*
     * Resolve a worker script URL against the right base.
     *
     * This matters even when we are not rewriting the worker: inside a worker
     * we booted from a blob, a relative path like "worker.js" would otherwise
     * be resolved against the blob URL and simply fail.
     */
    const resolveWorkerUrl = scriptUrl => {
        try {
            return new URL(String(scriptUrl), baseUrlForWorkers).href;
        }
        catch (e) {
            return scriptUrl;
        }
    };

    /**
     * A worker the page built inline, with our prelude in front of its code.
     *
     * Safe on every site, whatever its policy: the page has just minted a
     * blob: or data: URL and handed it to a worker, so blob: workers are
     * demonstrably allowed here. Our replacement is a blob: URL on the same
     * origin, and lands inside the same allowance.
     *
     * The prelude inherits no base URL. An inline worker's own `location` was
     * already a blob: or data: URL that its relative paths could not resolve
     * against, and it is one afterwards too, so nothing about the worker's view
     * of itself changes.
     */
    const startInlineWorker = (RealWorkerConstructor, scriptUrl, urlText, options, isModule) => {
        /*
         * A module worker resolves its imports against its own URL, and ours is
         * a different blob. Leave it be - bundlers ship module workers from
         * ordinary URLs anyway, which take the other path.
         */
        if (isModule || !canCreateBlobUrls) {
            reportStatus('worker');
            return new RealWorkerConstructor(scriptUrl, options);
        }

        let generatedUrl = null;
        try {
            const prelude = workerPreludeFor(null);

            if (urlText.startsWith('blob:')) {
                const original = trackedBlobFor(urlText);
                if (original) {
                    generatedUrl = realCreateObjectURL(
                        new Blob([prelude, original], { type: 'text/javascript' }),
                    );
                }
            }
            else {
                const source = decodeDataUrl(urlText);
                if (source !== null) {
                    generatedUrl = realCreateObjectURL(
                        new Blob([prelude + source], { type: 'text/javascript' }),
                    );
                }
            }

            if (generatedUrl === null) {
                /*
                 * The URL was minted before we were installed, or has already
                 * been revoked, or the data: URL would not decode. There is
                 * nothing to read, so the worker runs as the page wrote it.
                 */
                reportStatus('worker');
                return new RealWorkerConstructor(scriptUrl, options);
            }

            const worker = new RealWorkerConstructor(generatedUrl, options);

            // The blob has to outlive construction while the worker fetches
            // it; a generous delay is safer than revoking immediately.
            setTimeout(() => realRevokeObjectURL(generatedUrl), 60000);
            return worker;
        }
        catch (e) {
            if (generatedUrl) {
                realRevokeObjectURL(generatedUrl);
            }
            reportStatus('worker');
            return new RealWorkerConstructor(scriptUrl, options);
        }
    };

    /**
     * A worker the page started from an ordinary URL.
     *
     * Here the blob: rewrite is a change the site never asked for, and it costs
     * something even where it is allowed: the worker's `location` becomes the
     * blob rather than its own script. We repair that below, but the repair is
     * ours to get wrong, so this only happens once the probe says blob: workers
     * run on this site at all. Everywhere else the worker is passed through
     * untouched - it sees the real timezone, and the page keeps working.
     */
    const startUrlWorker = (RealWorkerConstructor, urlText, options, isModule) => {
        const realScriptUrl = resolveWorkerUrl(urlText);

        if (!blobWorkersAllowed || !canCreateBlobUrls) {
            reportStatus('worker');
            return new RealWorkerConstructor(realScriptUrl, options);
        }

        let generatedUrl = null;
        try {
            // Module workers have no importScripts(), so they use import().
            const bootstrap = workerPreludeFor(realScriptUrl) + (isModule
                ? `import(${JSON.stringify(realScriptUrl)});`
                : `importScripts(${JSON.stringify(realScriptUrl)});`);

            generatedUrl = realCreateObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));

            const worker = new RealWorkerConstructor(generatedUrl, options);

            setTimeout(() => realRevokeObjectURL(generatedUrl), 60000);
            return worker;
        }
        catch (e) {
            if (generatedUrl) {
                realRevokeObjectURL(generatedUrl);
            }
            reportStatus('worker');
            return new RealWorkerConstructor(realScriptUrl, options);
        }
    };

    const patchWorkerConstructor = (RealWorkerConstructor, constructorName) => {
        function PatchedWorker(scriptUrl, options) {
            let urlText;
            try {
                urlText = scriptUrl instanceof URL ? scriptUrl.href : String(scriptUrl);
            }
            catch (e) {
                // A Symbol, or an object whose toString throws. Not ours to
                // fix: hand it to the real constructor and let it complain.
                return new RealWorkerConstructor(scriptUrl, options);
            }

            const isModule = !!options && typeof options === 'object' && options.type === 'module';

            /*
             * Which of the two paths a worker takes turns entirely on whether
             * the page chose an inline URL itself. Anything it did choose we
             * can safely rewrite; anything it did not, we mostly leave alone.
             */
            if (urlText.startsWith('blob:') || urlText.startsWith('data:')) {
                return startInlineWorker(
                    RealWorkerConstructor, scriptUrl, urlText, options, isModule,
                );
            }

            return startUrlWorker(RealWorkerConstructor, urlText, options, isModule);
        }

        PatchedWorker.prototype = RealWorkerConstructor.prototype;
        Object.defineProperty(PatchedWorker, Symbol.hasInstance, {
            value: value => value instanceof RealWorkerConstructor,
            configurable: true,
        });
        markAsNative(PatchedWorker, constructorName);
        return PatchedWorker;
    };

    /*
     * Dedicated workers can spawn their own workers, and this hook runs inside
     * those too - so the patch follows the page down every level of nesting.
     */
    if (canCreateBlobUrls && typeof globalThis.Worker === 'function') {
        // The same CSP directive governs both kinds of worker, so one probe
        // answers for both.
        probeBlobWorkerSupport(globalThis.Worker);

        globalThis.Worker = patchWorkerConstructor(globalThis.Worker, 'Worker');

        if (typeof globalThis.SharedWorker === 'function') {
            globalThis.SharedWorker = patchWorkerConstructor(globalThis.SharedWorker, 'SharedWorker');
        }
    }

    // Everything above is in place. Anything that goes wrong from here on is
    // reported separately, and overrides this.
    reportStatus('masked');
};
