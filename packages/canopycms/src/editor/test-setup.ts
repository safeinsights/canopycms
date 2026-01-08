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
}
