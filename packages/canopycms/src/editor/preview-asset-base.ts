/**
 * The asset prefix a framing editor hands its live preview, held for `assets/asset-url.ts`. Its
 * only writer outside tests is `usePreviewData`, on a trusted draft message; the read is gated on `window` too,
 * because `assetUrl` also runs in server renders and static builds. Imports nothing.
 */

let previewAssetBase: string | undefined

export function setPreviewAssetBase(base: string | undefined): void {
  previewAssetBase = base
}

/** The stored prefix in a browser; always `undefined` on the server. */
export function getPreviewAssetBase(): string | undefined {
  return typeof window === 'undefined' ? undefined : previewAssetBase
}
