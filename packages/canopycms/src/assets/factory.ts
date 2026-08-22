/**
 * Instantiate the configured AssetStore from a site's `media` config.
 *
 * This is the one place that turns the (currently-unconsumed) `media` config
 * into a real store — see .claude/future-tasks/assets-media-system.md for why
 * this was previously dead configuration.
 */

import type { MediaConfig } from '../config/types'
import { LocalAssetStore } from './store-local'
import { S3AssetStore } from './store-s3'
import type { AssetStore } from './types'

/**
 * @param media - The site's `media` config (`config.media`), or undefined if unset.
 * @param opts.devAssetsDir - Root directory for the implicit local fallback store used
 *   when `media` is undefined, or when `adapter: 'local'` omits `directory`.
 */
export function createAssetStore(
  media: MediaConfig | undefined,
  opts: { devAssetsDir?: string } = {},
): AssetStore | undefined {
  if (!media) {
    return opts.devAssetsDir ? new LocalAssetStore({ root: opts.devAssetsDir }) : undefined
  }

  switch (media.adapter) {
    case 's3':
      return new S3AssetStore({
        bucket: media.bucket,
        region: media.region,
        maxUploadBytes: media.maxUploadBytes,
      })
    case 'local': {
      const root = media.directory ?? opts.devAssetsDir
      return root ? new LocalAssetStore({ root }) : undefined
    }
    case 'lfs':
      // Config literal kept for forward compatibility; no lfs adapter is
      // implemented yet (see BACKLOG.md "Asset adapters").
      return undefined
    default:
      // Defensive: mediaSchema is a closed discriminated union, so this is
      // unreachable via validated config, but guards against an unrecognized
      // adapter string reaching here some other way.
      return undefined
  }
}
