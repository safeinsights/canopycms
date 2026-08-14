# Optional-property inference for schema fields (`subheading?: string`)

## RESOLVED (2026-08-14, epic `integration-202608-b`, commit `8da62672`)

Shipped as proposed: `InferContentShape`/`RequiredValue` now mark a field
optional in the inferred type iff the schema field has an explicit
`required: false` (`entry-schema.ts`'s mapped-type split, ~134-144); README's
two previously-contradicting sections now agree (`README.md:1006,1224`); the
inference is covered by `entry-schema.test.ts` (incl. the three-way
`required: true` / `required: false` / omitted distinction).

## Priority: P1 [BOTH]

From adopter request #14 in a private adopter site's feature-request tracker, triaged
during the 2026-08-14 go-live backlog re-baseline.

## Problem

`entry-schema.ts:33`'s `RequiredValue` and `InferContentShape`
(`entry-schema.ts:119-121`) emit **every** field key as required, regardless of
whether the field is actually optional in the schema. The docs already promise
the opposite: `README.md:1006` and the `defineBlockTemplate` JSDoc
(`entry-schema.ts:255`) both advertise `subheading?: string` for an optional
field, while `README.md:1220` says the inferred type makes it required. The
package's own documentation currently contradicts itself, and the type system
doesn't match either claim consistently.

This is unbuilt, not just undocumented, and it's a **breaking** change once
built: any adopter code currently written against "every field is required"
(destructuring, `!`-assertions, etc.) could stop compiling once optional
fields correctly infer as optional.

## Blast radius

Small in-repo: two lines, `entry-schema.test.ts:89,97`. Neither adopter
(`docs-site-proto`, `website`) sets `exactOptionalPropertyTypes`, so the
narrower breaking surface (optional key present vs. `| undefined`) doesn't
apply to either today.

## Acceptance

- `InferContentShape`/`RequiredValue` correctly mark a field optional in the
  inferred type when the schema field itself is optional (no `required: true`
  / no default, depending on how "optional" is defined for fields).
- README's two contradicting sections (`:1006` and `:1220`) reconciled to say
  the same thing.
- `entry-schema.test.ts:89,97` updated for the new inference.
- Note in the changelog/README that this is a type-level breaking change for
  adopters relying on the old (incorrect) all-required inference.
