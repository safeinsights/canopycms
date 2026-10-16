---
'canopycms': minor
'canopycms-next': minor
---

### Previews can show the site header and footer, and the preview stays put between entries

<!-- migration
area: Preview
action: Optional
row: createPreviewPage takes a layout for the site header and footer
-->

**What changed.** `createPreviewPage` takes an optional `layout`, a server component that wraps every view and receives `{ children, chrome }`. Given one, the preview toolbar offers a "Site header and footer" toggle, remembered per device, which adds `?chrome=1` to the preview's URL and sets `chrome`. Without the toggle on, `chrome` is `false`. Switching entries keeps the preview pane and its toolbar in place: the last page stays, dimmed, until the next entry's data arrives.

**To adopt.** Pass the component your public pages use for their header and footer:

```tsx
export default createPreviewPage({
  layout: ({ children, chrome }) =>
    chrome ? <SiteChrome>{children}</SiteChrome> : <main>{children}</main>,
  views: { post: PostPreview },
})
```

A preview page built on `useCanopyPreview` alone can pass `siteChrome: true` when it renders the header and footer for `?chrome=1`.
