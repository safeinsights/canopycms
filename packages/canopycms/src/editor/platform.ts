/** Platform detection for shortcut labels. */

interface NavigatorWithUserAgentData {
  userAgentData?: { platform?: string }
  platform?: string
}

/** The label for Mantine's `mod` key: ⌘ on Apple platforms, Ctrl elsewhere (and during SSR). */
export function modKeyLabel(): '⌘' | 'Ctrl' {
  if (typeof navigator === 'undefined') return 'Ctrl'
  const nav: NavigatorWithUserAgentData = navigator
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl'
}
