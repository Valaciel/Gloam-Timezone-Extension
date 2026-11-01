'use strict';

/*
 * Early injection stub.
 * =====================
 *
 * Replaced by declarative static content script injection in manifest.json:
 *   "world": "MAIN", "run_at": "document_start"
 *
 * This runs natively in Chromium 111+ without requiring developer mode
 * or the "Allow user scripts" toggle.
 */

var earlyInjection = {
    isAvailable: () => true,
    refresh: async () => true,
};
