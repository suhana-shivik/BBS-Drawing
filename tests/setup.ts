import '@testing-library/jest-dom/vitest';

// jsdom implements no layout, so it ships no `scrollIntoView`. The Ask thread
// scrolls itself to the newest message on every render; without this the call
// throws inside React's commit phase, which unmounts the panel and shows up as
// "unable to find the message box" — a missing environment method wearing the
// costume of a broken component. Polyfilled here rather than guarded in the
// component, because the component is right and the environment is short.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no layout in jsdom — nothing to scroll */
  };
}
