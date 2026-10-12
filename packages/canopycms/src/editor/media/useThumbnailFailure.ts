'use client'

import { useState } from 'react'

/**
 * Whether the thumbnail at `src` failed to load. A new `src` clears the failure, so a thumbnail
 * that failed once gets another chance. Adjusting state during render, not in an effect, avoids
 * an extra pass: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 */
export function useThumbnailFailure(src: string): [boolean, () => void] {
  const [failed, setFailed] = useState(false)
  const [prevSrc, setPrevSrc] = useState(src)
  if (src !== prevSrc) {
    setPrevSrc(src)
    setFailed(false)
  }
  return [failed, () => setFailed(true)]
}
