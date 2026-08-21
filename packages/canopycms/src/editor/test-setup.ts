/**
 * Vitest setup file for editor tests running in jsdom environment.
 * This runs BEFORE test modules are loaded, providing browser APIs
 * that Mantine requires at module initialization time, and unmounting
 * rendered components between tests.
 */
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// React Testing Library only self-registers its automatic cleanup when a
// GLOBAL `afterEach` exists -- see the `typeof afterEach === 'function'` check
// at the top of @testing-library/react's entry point. This project runs vitest
// with `globals: false`, so that global never existed and the registration
// silently no-opped: every tree a test rendered stayed mounted for the rest of
// the file.
//
// Leaving components mounted strands their timers. Mantine's `useTransition`
// cancels its pending `setTimeout(setState)` from an unmount effect
// (`clearAllTimeouts`), so with no unmount that timer can outlive the jsdom
// environment and fire into a torn-down world -- `ReferenceError: window is
// not defined`, raised from React's `dispatchSetState`. Vitest reports that as
// an unhandled error, which fails the run (exit 1) while every test still
// passes, and blames whichever file happened to be running at the time.
//
// Importing `afterEach` explicitly is what makes the registration real here.
afterEach(() => {
  cleanup()
})

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
