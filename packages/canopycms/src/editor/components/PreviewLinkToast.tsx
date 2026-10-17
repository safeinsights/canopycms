'use client'

import { Anchor } from '@mantine/core'
import { notifications } from '@mantine/notifications'

/**
 * Says that a page clicked in the preview has no entry, so it went to a new tab. The new tab takes
 * the window a moment after it opens and a toast's timer runs while the editor is hidden, so the
 * note waits until the editor is in view. A blocked tab stays until dismissed, with a link that
 * opens the page, since a click on it is a fresh gesture the browser lets through.
 */
export const showPreviewLinkOutcome = (href: string, path: string, opened: boolean) => {
  if (!opened) {
    notifications.show({
      color: 'yellow',
      autoClose: false,
      message: (
        <>
          {path} has no entry here, and your browser blocked the new tab.{' '}
          <Anchor href={href} target="_blank" rel="noopener noreferrer">
            Open {path}
          </Anchor>
        </>
      ),
    })
    return
  }
  const show = () =>
    notifications.show({
      color: 'blue',
      message: `${path} has no entry here, so it opened in a new tab.`,
    })
  setTimeout(() => {
    if (document.visibilityState === 'visible') return show()
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', onVisible)
      show()
    }
    document.addEventListener('visibilitychange', onVisible)
  }, 300)
}
