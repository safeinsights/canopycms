# Block registry: ship the types, not a component

## Priority: P3 [BOTH]

From adopter request #13 in `../website/docs/canopycms-requests.md`
("block→component registry"), triaged during the 2026-08-14 go-live backlog
re-baseline. **This epic (`integration-202608-b`, PR #235) is implementing this
now** — don't double-build.

## What's already there

`defineBlockTemplate` ships (`entry-schema.ts:258-267`), and
`TypeFromEntrySchema` already derives the discriminated union from it
(`entry-schema.ts:50-64`). The 21-case `switch` the original request describes
no longer exists in `website`: `PageSections.tsx:52` now uses an exhaustive
mapped type keyed off that union instead.

## The actual gap

That mapped-type pattern is real, works, and is **undocumented and unshipped**
as a package capability — an adopter has to independently rediscover
`TypeFromEntrySchema` + a mapped `Record<Block['_type'], Component>` to arrive
where `website` already did. Meanwhile `apps/example1/app/components/PostView.tsx:54-105`
— our own reference app — still demonstrates the bad if-chain pattern the
request is trying to get away from, which sends the wrong signal to anyone
reading it as a model.

## Decision

Ship the *types* that make the mapped-type pattern easy and exhaustive-checked
(e.g. a small exported helper type alongside `TypeFromEntrySchema`, or a
documented recipe), not a `createBlockRenderer` component. A runtime registry
component would prescribe a rendering shape (React only, one dispatch style)
that the adopter already solved better on their own with plain TypeScript
exhaustiveness. Update `apps/example1/app/components/PostView.tsx` to use the
same mapped-type pattern so the reference app stops demonstrating the
discouraged approach.

## Related

- [reusable field fragments doc gap](field-fragments-docs.md) — same shape of
  problem (a capability that already works via plain TS composition, just
  undocumented).
