---
'canopycms': minor
---

### Link-only references to json/yaml entries leave out the body — **behaviour change (resolved data and types)**

<!-- migration
area: Refs
action: Adopters reading referenced prose
row: json/yaml isBody field needs includeBody on the reference
-->

**What changed.** A reference field without `includeBody: true` now resolves a json or yaml
target without that target's `isBody` field, as it already resolved an md/mdx target without its
body. A long body is no longer copied into every entry that merely links to it. A field that is
only named `body`, with no `isBody`, is ordinary data and still resolves. The live-preview resolve
endpoint and the AI export's `referenceLink` target follow the same rule, and `referenceLink`
now receives a json/yaml target's `isBody` field as `context.body`. Live preview resolves every
reference link-only, so an `includeBody: true` reference to a json/yaml target now previews
without its body, as one to an md/mdx target already did.

With `resolvedSchema`, the target's `isBody` field is now optional in the resolved type unless
the reference sets `includeBody: true`. This applies to md/mdx targets too, which already
resolved without it.

**To adopt.** Where a reference renders its target's prose, set `includeBody: true` on that
reference field. Code that reads the body from a link-only reference's resolved type now sees
`string | undefined`; either set `includeBody: true` or handle the missing value. See
[Resolving References in a Listing](../README.md#resolving-references-in-a-listing).
