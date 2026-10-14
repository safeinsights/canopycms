---
priority: P3
adopters: BOTH
summary: >-
  The editor's `<style>` elements carry no nonce: Mantine's CSS-variables tag (CanopyCMSProvider passes no `getStyleNonce`), the provider's `data-canopy-styles` sheet and the component style blocks in MarkdownField, FormHeader and FormRenderer. Under a strict `style-src` CSP the browser drops them all, and the editor loses its theme silently
---

# Editor style tags under a strict CSP

`editor/theme.tsx`'s `CanopyCMSProvider` renders `MantineProvider` without `getStyleNonce`,
plus its own `<style data-canopy-styles>`. `fields/MarkdownField.tsx`, `FormHeader.tsx` and
`FormRenderer.tsx` each render a `<style>` block too. A host page whose Content-Security-Policy
has a `style-src` without `'unsafe-inline'` drops every one of them, with no error the editor
can see.

## To decide

Whether adopters need a strict `style-src`. If they do, take a nonce through the editor's
config or props, pass it to `MantineProvider`'s `getStyleNonce`, and set it on each `<style>`.
That is a new adopter touchpoint, so it needs JP's approval.
