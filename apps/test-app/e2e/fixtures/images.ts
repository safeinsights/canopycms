import { expect, type Locator } from '@playwright/test'
import { LONG_TIMEOUT, STANDARD_TIMEOUT } from './timeouts'

/** Resolves once every image in `images` has loaded real pixels. */
export async function expectAllLoaded(images: Locator, count: number): Promise<void> {
  await expect(images).toHaveCount(count, { timeout: STANDARD_TIMEOUT })
  await expect
    .poll(
      () =>
        images.evaluateAll((els) =>
          els.every(
            (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      { timeout: LONG_TIMEOUT },
    )
    .toBe(true)
}
