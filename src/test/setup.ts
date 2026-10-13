import "@testing-library/jest-dom/vitest";

// jsdom lacks ResizeObserver, which the virtualizer and CodeMirror use.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver ??= ResizeObserverStub;

// Clipboard writes are fire-and-forget in the app.
if (!navigator.clipboard) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => undefined }, configurable: true });
}

// jsdom has no layout. Give scrollable data grids a viewport so the virtualizer renders rows.
const realRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (this.classList.contains("grid")) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 700, width: 1200, height: 700, toJSON: () => ({}) } as DOMRect;
  }
  return realRect.call(this);
};
for (const [prop, value] of [
  ["offsetWidth", 1200],
  ["offsetHeight", 700],
] as const) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("grid") ? value : (original?.get?.call(this) ?? 0);
    },
  });
}
