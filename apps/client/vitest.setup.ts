import "@testing-library/jest-dom/vitest";

// jsdom has never implemented matchMedia; vitest 3's jsdom environment supplied
// a stub, and vitest 4 no longer does. chat-list.tsx calls it (guarded with ?.)
// to read prefers-reduced-motion, and its tests spy on it, which needs a real
// function to spy on. Nothing matches: a test that cares sets its own return.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
