/* globals popup, siteRules */
'use strict';

/*
 * The Links panel.
 * ================
 *
 * Opening youtube.com loads code from googlevideo.com, ytimg.com, doubleclick
 * and several others. The address bar says one name; the page talks to a dozen.
 * This panel shows the real list for the tab you are on, and lets each one be
 * put on the allowlist or the blocklist without typing it out.
 *
 * Three ways to add, because they answer three different questions:
 *
 *   the host      "this exact server"          i-1.ytimg.com
 *   the domain    "this company, all of it"    *.ytimg.com
 *   everything    "whatever this page uses"    every domain in the list
 *
 * Nothing here writes to storage. Entries land in the same in-memory lists the
 * Sites panel edits, so Save is still the one moment anything is stored - and
 * an accidental click is undone by closing the popup.
 */

popup.connections = {};

/*
 * Suffixes under which the registrable domain is the third label from the end,
 * not the second. Without these, "bbc.co.uk" would be grouped as "co.uk" and
 * offering "*.co.uk" as a one-click blocklist entry would be actively harmful.
 *
 * This is the short list of what actually turns up in page resources, not the
 * Public Suffix List - that is thousands of entries, and shipping a copy of it
 * that silently goes stale is worse than being approximate about a rare case.
 * Being wrong here costs a grouping that reads oddly; it cannot produce an
 * entry broader than what the user clicked, because the per-host button is
 * always exact.
 */
const TWO_LABEL_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
    'co.kr', 'or.kr', 'go.kr', 're.kr',
    'com.br', 'net.br', 'org.br', 'gov.br',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.tw', 'org.tw', 'net.tw', 'gov.tw',
    'com.hk', 'org.hk', 'net.hk',
    'com.sg', 'com.my', 'com.ph', 'com.vn', 'co.in', 'co.id', 'co.th', 'co.za',
    'com.mx', 'com.ar', 'com.tr', 'com.pl', 'com.ua', 'com.ru', 'co.il',
    'com.es', 'com.pt', 'com.gr', 'com.co', 'com.pe', 'com.ec', 'com.uy',
]);

/** The part of a hostname you would sensibly wildcard: "i-1.ytimg.com" -> "ytimg.com". */
function registrableDomain(hostname) {
    const labels = hostname.split('.');

    // An IP address, or a single-label host. Neither has a domain to widen to.
    if (labels.length < 3 || /^\d+$/.test(labels[labels.length - 1])) {
        return hostname;
    }

    const lastTwo = labels.slice(-2).join('.');
    return labels.slice(TWO_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.');
}

/* --------------------------------------------------------------- state --- */

// What the last scan found, so the buttons can re-render after an add without
// asking the tab all over again.
let scanned = { pageHost: '', hosts: [], frameHosts: [], reachable: false };

function targetList() {
    const checked = document.querySelector('input[name="connTarget"]:checked');
    return checked && checked.value === 'listed' ? 'listed' : 'blocked';
}

/* ------------------------------------------------------------ rendering --- */

/** Groups the flat host list by registrable domain, first party first. */
function groupHosts() {
    const pageDomain = scanned.pageHost ? registrableDomain(scanned.pageHost) : '';
    const frameDomains = new Set(scanned.frameHosts.map(registrableDomain));
    const groups = new Map();

    for (const { host, hits } of scanned.hosts) {
        const domain = registrableDomain(host);

        if (!groups.has(domain)) {
            groups.set(domain, {
                domain,
                hits: 0,
                hosts: [],
                isFirstParty: domain === pageDomain,
                isFrame: frameDomains.has(domain),
            });
        }

        const group = groups.get(domain);
        group.hits += hits;
        group.hosts.push({ host, hits });
    }

    return [...groups.values()].sort((a, b) => {
        // The site you are actually on belongs at the top, whatever its share
        // of the requests - everything below it is the part worth reading.
        if (a.isFirstParty !== b.isFirstParty) {
            return a.isFirstParty ? -1 : 1;
        }
        return b.hits - a.hits || a.domain.localeCompare(b.domain);
    });
}

function tag(text, modifier) {
    const element = document.createElement('span');
    element.className = 'conn-tag' + (modifier ? ` conn-tag--${modifier}` : '');
    element.textContent = text;
    return element;
}

/**
 * One "add this" button.
 *
 * Disabled rather than hidden once the list already covers the entry, so the
 * row keeps its shape and the reason is in the tooltip instead of vanishing.
 */
function addButton(label, entry, title, extraClass) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conn-add' + (extraClass ? ` ${extraClass}` : '');
    button.textContent = label;

    const covered = popup.sites.covers(targetList(), entry.replace(/^\*\./, ''));
    button.disabled = covered;
    button.title = covered ? 'Already on this list' : title;

    button.addEventListener('click', () => {
        const added = popup.sites.add(targetList(), [entry]);
        popup.showMessage(
            added
                ? `Added ${entry} — press Save`
                : 'Already on this list',
            !added,
        );
        render();
    });

    return button;
}

function renderSummary() {
    const groups = groupHosts();
    const thirdParty = groups.filter(group => !group.isFirstParty).length;

    popup.el.connectionsBadge.hidden = thirdParty === 0;
    popup.el.connectionsBadge.textContent = String(thirdParty);

    if (!scanned.reachable) {
        popup.el.connectionsSummary.textContent =
            'Nothing to read on this page — reload it, or open a normal web page.';
        return;
    }

    const site = scanned.pageHost || 'this page';
    popup.el.connectionsSummary.textContent = thirdParty === 0
        ? `${site} — no other domains seen yet.`
        : `${site} also talks to ${thirdParty} other ${thirdParty === 1 ? 'domain' : 'domains'}.`;
}

function renderNote() {
    const mode = popup.sites.mode();
    const note = popup.el.connectionsNote;

    if (mode === 'all') {
        note.hidden = false;
        note.textContent = 'Heads up: “Where it applies” is set to All sites, so neither '
            + 'list is in use yet. Entries are still saved for when you switch.';
        return;
    }

    note.hidden = mode === targetList();
    note.textContent = `You are editing the ${targetList() === 'listed' ? 'allowlist' : 'blocklist'}, `
        + `but the ${mode === 'listed' ? 'allowlist' : 'blocklist'} is the one in use.`;
}

function renderList() {
    const groups = groupHosts();
    const list = popup.el.connectionsList;

    if (!groups.length) {
        const empty = document.createElement('p');
        empty.className = 'conn-empty';
        empty.textContent = scanned.reachable
            ? 'No connections recorded. Reload the page and look again.'
            : 'This page cannot be read.';
        list.replaceChildren(empty);
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const group of groups) {
        const element = document.createElement('div');
        element.className = 'conn-group';

        const head = document.createElement('div');
        head.className = 'conn-group__head';

        const domain = document.createElement('span');
        domain.className = 'conn-domain';
        domain.textContent = group.domain;
        domain.title = group.domain;
        head.appendChild(domain);

        if (group.isFirstParty) {
            head.appendChild(tag('this site', 'first'));
        }
        else if (group.isFrame) {
            // An embedded site, not just a file: a whole other page running
            // inside this one, with its own scripts and its own clock to read.
            head.appendChild(tag('embedded', 'first'));
        }

        if (popup.sites.covers(targetList(), group.domain)) {
            head.appendChild(tag('listed', 'listed'));
        }

        head.appendChild(addButton(
            `*.${group.domain}`,
            `*.${group.domain}`,
            `Add ${group.domain} and every subdomain`,
            'conn-add--wild',
        ));

        element.appendChild(head);

        const hosts = document.createElement('ul');
        hosts.className = 'conn-hosts';

        for (const { host, hits } of group.hosts.sort((a, b) => b.hits - a.hits)) {
            const row = document.createElement('li');
            row.className = 'conn-host';

            const name = document.createElement('span');
            name.className = 'conn-host__name';
            name.textContent = `${host} · ${hits}`;
            name.title = `${host} — ${hits} ${hits === 1 ? 'request' : 'requests'}`;
            row.appendChild(name);

            row.appendChild(addButton('Add', host, `Add ${host} exactly`));
            hosts.appendChild(row);
        }

        element.appendChild(hosts);
        fragment.appendChild(element);
    }

    list.replaceChildren(fragment);
}

function render() {
    renderSummary();
    renderNote();
    renderList();

    const groups = groupHosts();
    const target = targetList();
    const remaining = groups.filter(group => !popup.sites.covers(target, group.domain)).length;

    popup.el.connectionsAddAll.disabled = remaining === 0;
    popup.el.connectionsAddAll.textContent = remaining === 0
        ? 'Everything here is already on the list'
        : `Add all ${remaining} ${remaining === 1 ? 'domain' : 'domains'} to the `
            + `${target === 'listed' ? 'allowlist' : 'blocklist'}`;
}

/* --------------------------------------------------------------- wiring --- */

async function scanTab() {
    popup.el.connectionsSummary.textContent = 'Reading this tab…';
    popup.el.connectionsRefresh.disabled = true;

    const result = await popup.ask({ request: 'GetConnections' });

    scanned = {
        pageHost: (result && result.pageHost) || '',
        hosts: (result && Array.isArray(result.hosts) ? result.hosts : [])
            // The background does not filter, so that this panel decides what
            // counts as a hostname using the same rules the lists do.
            .filter(entry => entry && siteRules.normaliseEntry(entry.host)),
        frameHosts: (result && Array.isArray(result.frameHosts) ? result.frameHosts : []),
        reachable: Boolean(result && result.reachable),
    };

    popup.el.connectionsRefresh.disabled = false;
    render();
}

popup.el.connectionsRefresh.addEventListener('click', () => void scanTab());

popup.el.connectionsAddAll.addEventListener('click', () => {
    const target = targetList();
    const added = popup.sites.add(target, groupHosts().map(group => `*.${group.domain}`));

    popup.showMessage(
        added
            ? `Added ${added} ${added === 1 ? 'domain' : 'domains'} — press Save`
            : 'Nothing new to add',
        !added,
    );
    render();
});

for (const radio of document.querySelectorAll('input[name="connTarget"]')) {
    radio.addEventListener('change', render);
}

/**
 * Starts the panel off pointed at whichever list is actually in use, since
 * that is nearly always the one being added to. On "All sites" the blocklist
 * is the better guess: someone looking at this list is usually looking for
 * something to exclude.
 */
popup.connections.load = current => {
    const mode = current.siteMode === 'listed' ? 'listed' : 'blocked';
    const radio = document.querySelector(`input[name="connTarget"][value="${mode}"]`);
    if (radio) {
        radio.checked = true;
    }
};

// Changing where the override applies changes what the note above the list has
// to say, and the Sites panel is where that happens.
for (const radio of document.querySelectorAll('input[name="siteMode"]')) {
    radio.addEventListener('change', render);
}

/*
 * Scanned as the popup opens rather than when the panel is first shown. It
 * costs a message round trip to every frame in the tab, but the count on the
 * Links icon is the whole reason anyone would think to open the panel, so it
 * has to be there before they do.
 */
popup.connections.scan = scanTab;
