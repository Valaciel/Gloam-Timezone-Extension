'use strict';

/*
 * Service worker entry point.
 *
 * Order matters: each file below uses the ones above it.
 */

importScripts('/data/offsets.js');        // the raw timezone table
importScripts('/js/timezone-info.js');    // looking zones up
importScripts('/js/site-rules.js');       // which sites we apply to
importScripts('/data/timezone-hook.js');  // the hook, read as source for early injection
importScripts('/js/settings.js');         // reading and writing storage
importScripts('/js/early-injection.js');  // registering the early script
importScripts('/js/tab-status.js');       // the coloured dot on the toolbar icon
importScripts('/js/tab-connections.js');  // asking a tab's frames who they talk to
importScripts('/js/background.js');       // message handling and lifecycle
