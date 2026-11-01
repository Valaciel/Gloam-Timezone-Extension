/*
 * Gloam Timezone Extension — data/timezone-hook.js
 *
 * Runs in the page's MAIN world at document_start (declared in manifest.json),
 * ensuring it executes before any page script or inline code can run.
 *
 * Core Capabilities:
 *   1. Consistent Local-Time Model: All local time operations flow through
 *      offsetAt() and localToUTC() adhering strictly to ECMA-262 (including
 *      DST transitions and skipped/repeated local times).
 *   2. Zero-Allocation Prototype Patching: Mutates Date.prototype in-place.
 *      Does not subclass Date or create per-instance WeakMap partner objects.
 *      Reuses a single scratch Date for getters, giving O(1) memory footprint.
 *   3. Dynamic Iframe Interception: Hooks HTMLIFrameElement.prototype.contentWindow
 *      and contentDocument to immediately patch dynamic / about:blank frames
 *      before page scripts can inspect unpatched native prototypes.
 *   4. Clean Intl.DateTimeFormat: Replaces constructor without wrapping instances
 *      in a Proxy, maintaining full V8 private slot integrity and performance.
 *   5. Deep V8 Engine Emulation: Replicates Chromium's EquivalentYear logic for
 *      historical/future dates and CLDR timezone fallbacks.
 *   6. Native Disguises: Function.prototype.toString returns authentic [native code]
 *      for all patched functions.
 */

(function () {
  'use strict';

  const DAY = 86400000;
  const MAX_TIME = 8.64e15;

  const EVT_CFG = '__gloam_tz_cfg';
  const EVT_REQ = '__gloam_tz_req';
  const EVT_ACK = '__gloam_tz_ack';
  const FRAME_MARK = Symbol.for('__gloam_tz_frame');

  function install(root) {
    const NativeDate = root.Date;
    const NativeIntl = root.Intl;
    const NativeDTF = NativeIntl ? NativeIntl.DateTimeFormat : undefined;
    const FnProto = root.Function.prototype;
    const OrigFnToString = FnProto.toString;
    const apply = Reflect.apply;
    const construct = Reflect.construct;
    const defineProperty = Object.defineProperty;
    const P = NativeDate.prototype;

    // ---- Captured natives (immune to later tampering by the page) ----------
    const nativeNow = NativeDate.now;
    const nativeParse = NativeDate.parse;
    const nativeUTC = NativeDate.UTC;
    const N = {};
    [
      'getTime', 'setTime',
      'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay',
      'getUTCHours', 'getUTCMinutes', 'getUTCSeconds', 'getUTCMilliseconds',
      'setUTCFullYear', 'setUTCMonth', 'setUTCDate', 'setUTCHours',
      'setUTCMinutes', 'setUTCSeconds', 'setUTCMilliseconds',
    ].forEach((k) => { N[k] = P[k]; });

    // ---- State -------------------------------------------------------------
    const state = { active: false, tz: null, offFmt: null, nameFmt: null, refNames: null };
    const offsetCache = new Map();
    const OFFSET_CACHE_LIMIT = 4096;
    const scratch = new NativeDate(0); // reused by getters only

    const registry = new WeakMap(); // fake function -> native-looking source text
    const register = (fn, name) => {
      registry.set(fn, 'function ' + name + '() { [native code] }');
    };

    function setConfig(cfg) {
      let ok = false;
      if (cfg && cfg.enabled && typeof cfg.timezone === 'string' && cfg.timezone && NativeDTF) {
        try {
          const offFmt = new NativeDTF('en-US-u-ca-gregory-nu-latn', {
            timeZone: cfg.timezone, hourCycle: 'h23', era: 'short',
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
          });
          const nameFmt = new NativeDTF('en-US', { timeZone: cfg.timezone, timeZoneName: 'long' });
          state.tz = cfg.timezone;
          state.offFmt = offFmt;
          state.nameFmt = nameFmt;
          ok = true;
        } catch (e) {
          ok = false;
        }
      }
      offsetCache.clear();
      localeFormatters.clear();
      state.refNames = null;
      state.active = ok;
      if (!ok) {
        state.tz = null;
        state.offFmt = null;
        state.nameFmt = null;
      }
    }

    // ---- Offset model ------------------------------------------------------
    function utcFromFields(y, mo, d, h, mi, s) {
      apply(N.setTime, scratch, [0]);
      apply(N.setUTCFullYear, scratch, [y, mo, d]);
      apply(N.setUTCHours, scratch, [h, mi, s, 0]);
      return apply(N.getTime, scratch, []);
    }

    // Offset (local - UTC, in ms) of the target zone at UTC instant t
    function rawOffset(t) {
      if (!state.offFmt) return 0;
      let parts;
      try {
        parts = state.offFmt.formatToParts(t);
      } catch (e) {
        return 0;
      }
      let y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0, bc = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        switch (p.type) {
          case 'era': bc = p.value.charAt(0) === 'B'; break;
          case 'year': y = +p.value; break;
          case 'month': mo = +p.value; break;
          case 'day': d = +p.value; break;
          case 'hour': h = +p.value; break;
          case 'minute': mi = +p.value; break;
          case 'second': s = +p.value; break;
          default: break;
        }
      }
      if (bc) y = 1 - y;
      if (h === 24) h = 0;
      const L = utcFromFields(y, mo - 1, d, h, mi, s);
      const off = L - Math.floor(t / 1000) * 1000;
      return off === off ? off : 0;
    }

    // Cached per UTC day: if offset is identical at both ends of the day,
    // it is constant throughout the day. Otherwise compute rawOffset(t).
    function offsetAt(t) {
      if (!(t >= -MAX_TIME && t <= MAX_TIME)) return 0;
      const b = Math.floor(t / DAY);
      let v = offsetCache.get(b);
      if (v === undefined) {
        const a = rawOffset(b * DAY);
        const c = rawOffset((b + 1) * DAY);
        v = a === c ? a : null;
        if (offsetCache.size >= OFFSET_CACHE_LIMIT) offsetCache.clear();
        offsetCache.set(b, v);
      }
      return v === null ? rawOffset(t) : v;
    }

    // Local wall-clock (in ms) -> real UTC instant following ECMA-262
    function localToUTC(L) {
      if (L !== L) return NaN;
      const e = offsetAt(L - DAY);
      const l = offsetAt(L + DAY);
      if (e === l) return L - e;
      const tA = L - e;
      const tB = L - l;
      if (tA + offsetAt(tA) === L) return tA;
      if (tB + offsetAt(tB) === L) return tB;
      return tA;
    }

    function loadLocal(t) {
      apply(N.setTime, scratch, [t + offsetAt(t)]);
      return scratch;
    }

    // ---- String formatting helpers -----------------------------------------
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n, w) => {
      let s = String(n);
      while (s.length < w) s = '0' + s;
      return s;
    };

    function datePart(sc) {
      const y = apply(N.getUTCFullYear, sc, []);
      return DAYS[apply(N.getUTCDay, sc, [])] + ' ' + MONTHS[apply(N.getUTCMonth, sc, [])] + ' ' +
        pad(apply(N.getUTCDate, sc, []), 2) + ' ' + (y < 0 ? '-' : '') + pad(Math.abs(y), 4);
    }

    function intlZoneName(t) {
      if (!state.nameFmt) return '';
      try {
        const parts = state.nameFmt.formatToParts(t);
        for (let i = 0; i < parts.length; i++) {
          if (parts[i].type === 'timeZoneName') return parts[i].value;
        }
      } catch (e) { /* ignore */ }
      return '';
    }

    // V8 EquivalentYear emulation for dates outside 1970..2038
    function equivalentTime(t) {
      if (t >= 0 && t <= 2147483647000) return t;
      const sc = new NativeDate(t);
      const y = apply(N.getUTCFullYear, sc, []);
      const m = apply(N.getUTCMonth, sc, []);
      const d = apply(N.getUTCDate, sc, []);
      const withinDay = t - Math.floor(t / DAY) * DAY;
      apply(N.setTime, scratch, [0]);
      apply(N.setUTCFullYear, scratch, [y, 0, 1]);
      const weekday = apply(N.getUTCDay, scratch, []);
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const recent = (leap ? 1956 : 1967) + ((weekday * 12) % 28);
      const eq = 2008 + ((recent + 3 * 28 - 2008) % 28);
      apply(N.setTime, scratch, [0]);
      apply(N.setUTCFullYear, scratch, [eq, m, d]);
      return apply(N.getTime, scratch, []) + withinDay;
    }

    const REF_JAN = 1579046400000; // 2020-01-15
    const REF_JUL = 1594771200000; // 2020-07-15
    function referenceNames() {
      if (state.refNames) return state.refNames;
      const nJan = intlZoneName(REF_JAN);
      const nJul = intlZoneName(REF_JUL);
      let lo = Infinity;
      let hi = -Infinity;
      for (let m = 0; m < 12; m++) {
        const o = offsetAt(REF_JAN + m * 30.4375 * DAY);
        if (o < lo) lo = o;
        if (o > hi) hi = o;
      }
      const names = offsetAt(REF_JAN) > offsetAt(REF_JUL) ? { std: nJul, dst: nJan } : { std: nJan, dst: nJul };
      names.rawStd = lo;
      names.saving = hi - lo;
      state.refNames = names;
      return names;
    }

    const BARE_GMT = /^GMT(?:[+-]|$)/;
    function gmtLabel(off) {
      if (off === 0) return 'GMT';
      const m = Math.floor(Math.abs(off) / 60000);
      return 'GMT' + (off < 0 ? '-' : '+') + pad(Math.floor(m / 60), 2) + ':' + pad(m % 60, 2);
    }

    function eraStandardOffset(t) {
      const y = apply(N.getUTCFullYear, new NativeDate(t), []);
      return Math.min(offsetAt(utcFromFields(y, 0, 1, 0, 0, 0)), offsetAt(utcFromFields(y, 6, 1, 0, 0, 0)));
    }

    function zoneName(t0) {
      const t = equivalentTime(t0);
      const ref = referenceNames();

      if (BARE_GMT.test(ref.std) && BARE_GMT.test(ref.dst)) {
        return gmtLabel(ref.rawStd + (offsetAt(t) > ref.rawStd ? ref.saving : 0));
      }

      const name = intlZoneName(t);
      if (name === ref.std || name === ref.dst) return name;

      const bare = !name || BARE_GMT.test(name);
      const daylight = bare ? offsetAt(t) > eraStandardOffset(t) : /daylight|summer/i.test(name);
      if (ref.std !== ref.dst) return daylight ? ref.dst : ref.std;
      if (!daylight) return ref.std;
      const word = /daylight/i.test(name) ? 'Daylight' : 'Summer';
      return ref.std.indexOf('Standard') >= 0 ? ref.std.replace('Standard', word) : (name || ref.std);
    }

    function timePart(sc, t, off) {
      const abs = Math.floor(Math.abs(off) / 60000);
      return pad(apply(N.getUTCHours, sc, []), 2) + ':' + pad(apply(N.getUTCMinutes, sc, []), 2) + ':' +
        pad(apply(N.getUTCSeconds, sc, []), 2) + ' GMT' + (off < 0 ? '-' : '+') +
        pad(Math.floor(abs / 60), 2) + pad(abs % 60, 2) + ' (' + zoneName(t) + ')';
    }

    function fakeToString(t) {
      if (t !== t) return 'Invalid Date';
      const off = offsetAt(t);
      const sc = loadLocal(t);
      return datePart(sc) + ' ' + timePart(sc, t, off);
    }

    // ---- Date.prototype: local getters -------------------------------------
    const fakes = {};

    ['getDate', 'getDay', 'getFullYear', 'getHours', 'getMilliseconds', 'getMinutes', 'getMonth', 'getSeconds']
      .forEach((name) => {
        const orig = P[name];
        const utcFn = N['getUTC' + name.slice(3)];
        fakes[name] = ({
          [name]() {
            if (!state.active) return apply(orig, this, []);
            const t = apply(N.getTime, this, []);
            if (t !== t) return NaN;
            return apply(utcFn, loadLocal(t), []);
          },
        })[name];
      });

    if (P.getYear) {
      const origGetYear = P.getYear;
      fakes.getYear = ({
        getYear() {
          if (!state.active) return apply(origGetYear, this, []);
          const t = apply(N.getTime, this, []);
          if (t !== t) return NaN;
          return apply(N.getUTCFullYear, loadLocal(t), []) - 1900;
        },
      }).getYear;
    }

    {
      const orig = P.getTimezoneOffset;
      fakes.getTimezoneOffset = ({
        getTimezoneOffset() {
          if (!state.active) return apply(orig, this, []);
          const t = apply(N.getTime, this, []);
          if (t !== t) return NaN;
          const r = Math.trunc((t - (t + offsetAt(t))) / 60000);
          return r === 0 ? 0 : r;
        },
      }).getTimezoneOffset;
    }

    // ---- Date.prototype: local setters -------------------------------------
    const SETTERS = {
      setDate: 1, setFullYear: 3, setHours: 4, setMilliseconds: 1,
      setMinutes: 3, setMonth: 2, setSeconds: 2,
    };
    Object.keys(SETTERS).forEach((name) => {
      const orig = P[name];
      const utcFn = N['setUTC' + name.slice(3)];
      const lengthOf = SETTERS[name];
      const fn = ({
        [name]() {
          if (!state.active) return apply(orig, this, arguments);
          const t = apply(N.getTime, this, []);
          if (t !== t && name !== 'setFullYear') {
            apply(utcFn, new NativeDate(NaN), arguments);
            return NaN;
          }
          const L = t !== t ? 0 : t + offsetAt(t);
          const sc = new NativeDate(L);
          const r = apply(utcFn, sc, arguments);
          return apply(N.setTime, this, [r !== r ? NaN : localToUTC(r)]);
        },
      })[name];
      defineProperty(fn, 'length', { value: lengthOf, configurable: true });
      fakes[name] = fn;
    });

    if (P.setYear) {
      const orig = P.setYear;
      fakes.setYear = ({
        setYear(year) {
          if (!state.active) return apply(orig, this, arguments);
          const t = apply(N.getTime, this, []);
          const L = t !== t ? 0 : t + offsetAt(t);
          const y = +year;
          if (y !== y) { apply(N.setTime, this, [NaN]); return NaN; }
          const ty = Math.trunc(y);
          const yyyy = ty >= 0 && ty <= 99 ? 1900 + ty : ty;
          const sc = new NativeDate(L);
          const r = apply(N.setUTCFullYear, sc, [yyyy]);
          return apply(N.setTime, this, [r !== r ? NaN : localToUTC(r)]);
        },
      }).setYear;
    }

    // ---- Date.prototype: string conversions --------------------------------
    {
      const o = { toString: P.toString, toDateString: P.toDateString, toTimeString: P.toTimeString };
      fakes.toString = ({
        toString() {
          if (!state.active) return apply(o.toString, this, []);
          return fakeToString(apply(N.getTime, this, []));
        },
      }).toString;
      fakes.toDateString = ({
        toDateString() {
          if (!state.active) return apply(o.toDateString, this, []);
          const t = apply(N.getTime, this, []);
          return t !== t ? 'Invalid Date' : datePart(loadLocal(t));
        },
      }).toDateString;
      fakes.toTimeString = ({
        toTimeString() {
          if (!state.active) return apply(o.toTimeString, this, []);
          const t = apply(N.getTime, this, []);
          if (t !== t) return 'Invalid Date';
          const off = offsetAt(t);
          return timePart(loadLocal(t), t, off);
        },
      }).toTimeString;
    }

    function withTZ(options) {
      if (options === undefined) return { timeZone: state.tz };
      if (options === null || (typeof options !== 'object' && typeof options !== 'function')) return options;
      if (options.timeZone !== undefined) return options;
      const o = Object.create(options);
      o.timeZone = state.tz;
      return o;
    }

    const LOCALE_DEFAULTS = {
      toLocaleString: { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' },
      toLocaleDateString: { year: 'numeric', month: 'numeric', day: 'numeric' },
      toLocaleTimeString: { hour: 'numeric', minute: 'numeric', second: 'numeric' },
    };
    const localeFormatters = new Map();
    const LOCALE_CACHE_LIMIT = 64;

    ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach((name) => {
      const orig = P[name];
      fakes[name] = ({
        [name](locales, options) {
          if (!state.active) return apply(orig, this, arguments);
          if (options === undefined && (locales === undefined || typeof locales === 'string') && NativeDTF) {
            const t = apply(N.getTime, this, []);
            if (t !== t) return 'Invalid Date';
            const key = name + '|' + (locales === undefined ? '\u0000' : locales);
            let f = localeFormatters.get(key);
            if (f === undefined) {
              f = new NativeDTF(locales, Object.assign({ timeZone: state.tz }, LOCALE_DEFAULTS[name]));
              if (localeFormatters.size >= LOCALE_CACHE_LIMIT) localeFormatters.clear();
              localeFormatters.set(key, f);
            }
            return f.format(t);
          }
          return apply(orig, this, [locales, withTZ(options)]);
        },
      })[name];
    });

    // ---- Date constructor & Date.parse -------------------------------------
    const RE_DATE_ONLY = /^(?:\d{4}|[+-]\d{6})(?:-\d{2}(?:-\d{2})?)?$/;
    const RE_ISO_DT = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;
    const RE_ISO_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
    const RE_LEGACY_ZONE = /(?:^|[^a-z])(?:GMT|UTC|UT|Z|[ECMP][SD]T)(?![a-z])|\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[ap]\.?m\.?)?\s*[+-]\d{2}:?\d{2}\b/i;

    function parseString(s) {
      const r = apply(nativeParse, NativeDate, [s]);
      if (r !== r) return NaN;
      const x = s.replace(/\([^)]*\)/g, ' ').trim();
      if (RE_DATE_ONLY.test(x)) return r;
      if (RE_ISO_DT.test(x)) {
        if (RE_ISO_ZONE.test(x)) return r;
        const L = apply(nativeParse, NativeDate, [x + 'Z']);
        return L !== L ? r : localToUTC(L);
      }
      if (RE_LEGACY_ZONE.test(x)) return r;
      const L = apply(nativeParse, NativeDate, [s + ' GMT']);
      return L !== L ? r : localToUTC(L);
    }

    function isObject(v) { return v !== null && (typeof v === 'object' || typeof v === 'function'); }

    function toPrimitiveDefault(v) {
      if (!isObject(v)) return v;
      const ex = v[Symbol.toPrimitive];
      if (ex !== undefined && ex !== null) {
        const r = apply(ex, v, ['default']);
        if (isObject(r)) throw new TypeError('Cannot convert object to primitive value');
        return r;
      }
      const names = ['valueOf', 'toString'];
      for (let i = 0; i < names.length; i++) {
        const f = v[names[i]];
        if (typeof f === 'function') {
          const r = apply(f, v, []);
          if (!isObject(r)) return r;
        }
      }
      throw new TypeError('Cannot convert object to primitive value');
    }

    function FakeDate(...args) {
      if (!new.target) {
        return state.active ? fakeToString(apply(nativeNow, NativeDate, [])) : apply(NativeDate, undefined, []);
      }
      if (!state.active || args.length === 0) return construct(NativeDate, args, new.target);
      let t;
      if (args.length === 1) {
        const v = args[0];
        let tv;
        let isDate = false;
        if (isObject(v)) { try { tv = apply(N.getTime, v, []); isDate = true; } catch (e) { isDate = false; } }
        if (isDate) {
          t = tv;
        } else {
          const prim = toPrimitiveDefault(v);
          t = typeof prim === 'string' ? parseString(prim) : +prim;
        }
      } else {
        t = localToUTC(apply(nativeUTC, undefined, args));
      }
      return construct(NativeDate, [t], new.target);
    }

    const fakeParseFn = ({
      parse(str) {
        if (!state.active) return apply(nativeParse, NativeDate, [str]);
        return parseString(`${str}`);
      },
    }).parse;

    // ---- Intl.DateTimeFormat (Clean replacement, no Proxy wrapper) ---------
    let FakeDTF = null;
    if (NativeDTF) {
      FakeDTF = function DateTimeFormat(locales, options) {
        return construct(NativeDTF, [locales, state.active ? withTZ(options) : options], new.target || FakeDTF);
      };
      defineProperty(FakeDTF, 'name', { value: 'DateTimeFormat', configurable: true });
      defineProperty(FakeDTF, 'length', { value: 0, configurable: true });
      defineProperty(FakeDTF, 'prototype', { value: NativeDTF.prototype, writable: false, enumerable: false, configurable: false });
      defineProperty(FakeDTF, 'supportedLocalesOf', Object.getOwnPropertyDescriptor(NativeDTF, 'supportedLocalesOf'));
      register(FakeDTF, 'DateTimeFormat');
      defineProperty(NativeDTF.prototype, 'constructor', { value: FakeDTF, writable: true, enumerable: false, configurable: true });
      defineProperty(NativeIntl, 'DateTimeFormat', { value: FakeDTF, writable: true, enumerable: false, configurable: true });
    }

    // ---- Temporal (if supported by engine) ----------------------------------
    function patchTemporal() {
      const Now = root.Temporal && root.Temporal.Now;
      if (!Now) return;
      if (typeof Now.timeZoneId === 'function') {
        const orig = Now.timeZoneId;
        const f = ({ timeZoneId() { return state.active ? state.tz : apply(orig, this, []); } }).timeZoneId;
        register(f, 'timeZoneId');
        defineProperty(Now, 'timeZoneId', { value: f, writable: true, configurable: true, enumerable: false });
      }
      ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO'].forEach((name) => {
        const orig = Now[name];
        if (typeof orig !== 'function') return;
        const f = ({
          [name](tz) { return apply(orig, this, [tz === undefined && state.active ? state.tz : tz]); },
        })[name];
        defineProperty(f, 'length', { value: 0, configurable: true });
        register(f, name);
        defineProperty(Now, name, { value: f, writable: true, configurable: true, enumerable: false });
      });
    }

    // ---- Install Date prototype patches and register disguises ------------
    Object.keys(fakes).forEach((name) => {
      const fn = fakes[name];
      if (!Object.prototype.hasOwnProperty.call(SETTERS, name) && name !== 'setYear') {
        const lengths = { toLocaleString: 0, toLocaleDateString: 0, toLocaleTimeString: 0 };
        defineProperty(fn, 'length', { value: lengths[name] || 0, configurable: true });
      }
      if (name === 'setYear') defineProperty(fn, 'length', { value: 1, configurable: true });
      defineProperty(fn, 'name', { value: name, configurable: true });
      register(fn, name);
      defineProperty(P, name, { value: fn, writable: true, configurable: true, enumerable: false });
    });

    defineProperty(FakeDate, 'name', { value: 'Date', configurable: true });
    defineProperty(FakeDate, 'length', { value: 7, configurable: true });
    defineProperty(FakeDate, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
    defineProperty(fakeParseFn, 'name', { value: 'parse', configurable: true });
    defineProperty(fakeParseFn, 'length', { value: 1, configurable: true });
    register(FakeDate, 'Date');
    register(fakeParseFn, 'parse');
    defineProperty(FakeDate, 'now', { value: nativeNow, writable: true, enumerable: false, configurable: true });
    defineProperty(FakeDate, 'parse', { value: fakeParseFn, writable: true, enumerable: false, configurable: true });
    defineProperty(FakeDate, 'UTC', { value: nativeUTC, writable: true, enumerable: false, configurable: true });
    defineProperty(P, 'constructor', { value: FakeDate, writable: true, enumerable: false, configurable: true });
    defineProperty(root, 'Date', { value: FakeDate, writable: true, enumerable: false, configurable: true });

    try { patchTemporal(); } catch (e) { /* Temporal is optional */ }

    // Transparent Function.prototype.toString disguise
    const fakeFnToString = new Proxy(OrigFnToString, {
      apply(target, thisArg, args) {
        const s = registry.get(thisArg);
        return s !== undefined ? s : apply(target, thisArg, args);
      },
    });
    register(fakeFnToString, 'toString');
    defineProperty(FnProto, 'toString', { value: fakeFnToString, writable: true, enumerable: false, configurable: true });

    // ---- Same-Origin dynamic child frames (about:blank, srcdoc) ------------
    let lastCfg = null;
    let appliedTs = 0;
    const children = new Set();
    const outerSetConfig = setConfig;

    const controllerApi = {
      setConfig(cfg) {
        const ts = (cfg && cfg.ts) || 0;
        if (ts < appliedTs) return;
        appliedTs = ts;
        lastCfg = cfg;
        outerSetConfig(cfg);

        // Report status through DOM attribute channel if requested
        if (cfg && cfg.statusChannel && typeof document !== 'undefined') {
          try {
            const rootEl = document.documentElement;
            if (rootEl) {
              rootEl.setAttribute(cfg.statusChannel, cfg.enabled ? 'masked' : 'off');
            }
          } catch (e) { /* ignore */ }
        }

        // Propagate to all adopted child frames
        for (const ref of Array.from(children)) {
          const c = ref.deref();
          if (c) {
            try { c.setConfig(cfg); } catch (e) { /* frame gone */ }
          } else {
            children.delete(ref);
          }
        }
      },
      getConfig() {
        return lastCfg;
      },
    };

    function adopt(win) {
      try {
        if (!win || win === root) return;
        if (typeof win.Date !== 'function') return;

        // Never touch Cloudflare Turnstile or challenge platform verification frames
        try {
          const loc = win.location;
          const href = (loc && loc.href) || '';
          if (href && (href.includes('challenges.cloudflare.com') || href.includes('/cdn-cgi/challenge-platform/'))) {
            return;
          }
        } catch (e) { /* cross-origin check can throw; safe to continue */ }

        const known = win[FRAME_MARK];
        if (known) {
          if (!children.has(known.ref)) {
            known.ref = new WeakRef(known);
            children.add(known.ref);
          }
          if (lastCfg && known.lastApplied !== lastCfg) {
            known.lastApplied = lastCfg;
            known.setConfig(lastCfg);
          }
          return;
        }
        const child = install(win);
        defineProperty(win, FRAME_MARK, { value: child, enumerable: false });
        children.add(new WeakRef(child));
        if (lastCfg) child.setConfig(lastCfg);
      } catch (e) { /* cross-origin or detached */ }
    }

    const IFrame = root.HTMLIFrameElement && root.HTMLIFrameElement.prototype;
    if (IFrame) {
      for (const prop of ['contentWindow', 'contentDocument']) {
        const desc = Object.getOwnPropertyDescriptor(IFrame, prop);
        if (!desc || !desc.get) continue;
        const nativeGet = desc.get;
        const getter = {
          get [prop]() {
            const v = apply(nativeGet, this, []);
            adopt(prop === 'contentWindow' ? v : v && v.defaultView);
            return v;
          },
        };
        const fn = Object.getOwnPropertyDescriptor(getter, prop).get;
        register(fn, 'get ' + prop);
        defineProperty(IFrame, prop, { get: fn, set: undefined, enumerable: desc.enumerable, configurable: true });
      }
    }

    return controllerApi;
  }

  // ---- Node export (for differential / unit testing) -----------------------
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { install };
    return;
  }

  // ---- Browser: Receive configuration from content-script.js (Bridge) ------
  const existing = window[FRAME_MARK];
  const controller = existing || install(window);
  if (!existing) {
    Object.defineProperty(window, FRAME_MARK, { value: controller, enumerable: false });
  }

  window.addEventListener(EVT_CFG, function (e) {
    try {
      const cfg = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail;
      controller.setConfig(cfg);
      window.dispatchEvent(new CustomEvent(EVT_ACK, { detail: { active: !!cfg.enabled } }));
    } catch (err) { /* ignore malformed events */ }
  }, true);

  // Request initial configuration in case Bridge is already running
  try {
    window.dispatchEvent(new CustomEvent(EVT_REQ));
  } catch (e) { /* ignore */ }
})();
