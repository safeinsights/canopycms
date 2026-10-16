/**
 * What `createPreviewPage` hands a view beside `CanopyPreviewProps`. Kept out of that public type,
 * so adopter view code never sees it; `withCanopyPreview` consumes it and passes nothing on.
 */
export interface PreviewRouteProps {
  /** The signed-in asset route, which `usePreviewAssetBaseGate` sets before the view renders. */
  previewAssetBase?: string
  /** The route has a `layout`, so the view tells the editor it can show the site's header and footer. */
  previewSiteChrome?: boolean
}
