// Minimal DOM shims for Mantine in tests
if (typeof window !== 'undefined' && !('matchMedia' in window)) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  window.matchMedia = () => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
  })
}
