/** The signed-in asset prefix, React-free so `createPreviewPage` can build it on a server. */

import { joinUrlPrefix, toSameOriginPath } from '../utils/url-prefix'

/** The raw asset route (`api/assets.ts`'s `assetRawRoute`) under the default API base. */
const RAW_ASSET_ROUTE = '/api/canopycms/assets/raw'

/** The raw route under `basePath`: unlike `/assets`, it computes derivatives no build made. */
export function authenticatedAssetBase(basePath?: string): string {
  return joinUrlPrefix(basePath, RAW_ASSET_ROUTE)
}

/** `value` if it is a same-origin path: nothing else may steer a preview's `<img>`s. */
export function readAssetBase(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && toSameOriginPath(value) === value
    ? value
    : undefined
}
