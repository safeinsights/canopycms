---
summary: >-
  RESOLVED 2026-10-05, branch `feat/cdk-attach-preview-prefix`. `CanopyCmsService.attachTo` takes `previewPrefix` and routes `<prefix>` and `<prefix>/*` to the Lambda with the editor-route options, validated like `editorAssetPrefix` and covered by the synth shadow check
---
# `attachTo` does not route the static-export preview route

## Priority: P2 [BOTH]

**RESOLVED 2026-10-05**, branch `feat/cdk-attach-preview-prefix`: `attachTo`'s `previewPrefix`
option, with the suggested shape below.

## The gap

`CanopyCmsService.attachTo` (`packages/canopycms-cdk/src/constructs/editor-routing.ts`) routes
`/edit`, `/edit/*`, `/api/canopycms/*` and an optional `editorAssetPrefix` to the CMS Lambda on a
distribution the site owns. A static-export site previews a branch through a CMS-only route at
`editor.previewPrefix` (`'/preview'` in the README's example, served by `createPreviewPage`), and on
that shared distribution nothing sends `/preview/*` to the Lambda: the editor's preview pane gets
the site's own response instead. `docs/deploying-to-aws.md` tells adopters to add the behavior by
hand, which loses the OAC origin, the read timeout, the `x-forwarded-host` function and the headers
policy unless they copy them.

## Suggested shape

A `previewPrefix` option on `attachTo` that adds `<prefix>` and `<prefix>/*` with the same options
as the editor routes (`lambdaBehaviorOptions` plus `behaviorOverrides`), validated like
`editorAssetPrefix` (leading `/`, no trailing `/` or wildcards, no overlap with the reserved routes or
the asset prefix) and covered by the synth shadow check. Only path prefixes: an absolute
`https://` `previewPrefix` is another origin and needs no behavior here. The headers policy already
sends `frame-ancestors 'self'`, which is what the preview route needs. Then replace the hand-wiring
sentence in the deploy doc with the option.
