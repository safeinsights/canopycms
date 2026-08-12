/**
 * Vitest setup file for editor tests running in jsdom environment.
 * This runs BEFORE test modules are loaded, providing browser APIs
 * that Mantine requires at module initialization time.
 */

if (typeof window !== 'undefined') {
  // Mantine uses matchMedia for color scheme detection at module load time
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })

  // ResizeObserver is used by various Mantine components
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver
  }

  // jsdom implements no layout, so it ships no scrollIntoView. Mantine's
  // Combobox (Select, Autocomplete, ...) calls it from a timer when the
  // dropdown's active option changes, which lands AFTER the test that opened
  // the dropdown has finished - surfacing as an unhandled exception attributed
  // to whatever ran next, rather than a failure in the test that caused it.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
}
