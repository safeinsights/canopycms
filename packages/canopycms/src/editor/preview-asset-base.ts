/**
 * The prefix a live preview puts `/assets/t/` srcs behind, for `assets/asset-url.ts`; imports
 * nothing. A browser stores it from drafts and `usePreviewAssetBaseGate`. A server reads the
 * getter `canopycms-next`'s preview page registers, which is request-scoped, so a render outside a
 * preview request, including every static build, sees `undefined`.
 */

let previewAssetBase: string | undefined
let serverPreviewAssetBase: (() => string | undefined) | undefined

export function setPreviewAssetBase(base: string | undefined): void {
  previewAssetBase = base
}

export function setServerPreviewAssetBaseGetter(
  getter: (() => string | undefined) | undefined,
): void {
  serverPreviewAssetBase = getter
}

export function getPreviewAssetBase(): string | undefined {
  return typeof window === 'undefined' ? serverPreviewAssetBase?.() : previewAssetBase
}
