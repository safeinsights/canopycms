'use client'

import { Anchor } from '@mantine/core'
import { notifications } from '@mantine/notifications'

/**
 * Says a preview link's page has no entry, so it went to a new tab: once the editor is in view, as
 * the toast's timer runs while hidden. A blocked tab's note stays, linking the page for a new click.
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
