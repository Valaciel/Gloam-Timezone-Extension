/* globals popup */
'use strict';

/*
 * The side nav.
 * =============
 *
 * Four sections, one visible at a time. The point of splitting them up is that
 * the popup is a fixed size: nothing the user opens can make the window taller,
 * which is what "Advanced" used to do when it was an expanding <details>.
 *
 * Everything still lives inside the one <form>, so Save keeps submitting all of
 * it however the user has been navigating - a setting changed on a panel you
 * have since navigated away from is still saved.
 */

popup.nav = {};

const buttons = [...document.querySelectorAll('.nav__item')];

popup.nav.show = panelId => {
    for (const button of buttons) {
        const isCurrent = button.dataset.panel === panelId;
        button.classList.toggle('is-current', isCurrent);
        button.setAttribute('aria-selected', String(isCurrent));
        document.getElementById(button.dataset.panel).hidden = !isCurrent;
    }
};

for (const button of buttons) {
    button.addEventListener('click', () => popup.nav.show(button.dataset.panel));
}

// Arrow keys move between sections, which is what a vertical tablist is
// expected to do and costs almost nothing to support.
document.querySelector('.nav').addEventListener('keydown', event => {
    const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (!step) {
        return;
    }

    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = buttons[(Math.max(index, 0) + step + buttons.length) % buttons.length];
    next.focus();
    popup.nav.show(next.dataset.panel);
});
