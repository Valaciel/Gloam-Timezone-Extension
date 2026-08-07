'use strict';

/*
 * Theme, applied before the first paint.
 * ======================================
 *
 * Three choices - System, Light (Gold) and Dark (Navy) - written to
 * <html data-theme>, which is what the palettes in popup.css key off.
 *
 * The chosen theme lives in extension storage like every other setting, but
 * chrome.storage is asynchronous: reading it would mean the popup opens in the
 * default theme and flips to the right one a frame later, which on a window
 * this small is very visible. So the choice is MIRRORED into localStorage,
 * which an extension page can read synchronously, and this file runs from
 * <head> before there is anything on screen to flip.
 *
 * Storage stays the source of truth. The mirror is a cache, and a wrong or
 * missing one costs a single frame in the wrong colours, never a lost setting.
 */

var gloamTheme = {};

const THEMES = ['system', 'light', 'dark'];
const MIRROR_KEY = 'gloam-theme';

gloamTheme.isValid = value => THEMES.includes(value);

/** Puts a theme on screen. Does not remember it. */
gloamTheme.apply = value => {
    document.documentElement.dataset.theme = gloamTheme.isValid(value) ? value : 'system';
};

/** Updates the synchronous mirror, so the next open starts in this theme. */
gloamTheme.remember = value => {
    try {
        localStorage.setItem(MIRROR_KEY, gloamTheme.isValid(value) ? value : 'system');
    }
    catch (e) {
        // Storage disabled for extension pages. Costs the head start, no more.
    }
};

/** What the last open left behind, if anything. */
gloamTheme.mirrored = () => {
    try {
        return localStorage.getItem(MIRROR_KEY);
    }
    catch (e) {
        return null;
    }
};

gloamTheme.apply(gloamTheme.mirrored());
