# Two `replace(/…$/g)` trim regexes are ReDoS-shaped but currently safe by construction

**Priority:** P3 — verified NOT exploitable today; defensive hardening only
**Found:** 2026-08-15, PR #235 human-review fix session (fix/human-review-235), from the
repo-wide grep for sibling `replace(/.../)` quantifier patterns that finding 3's review asked for

## Problem

`packages/canopycms/src/cli/migrate.ts`'s `slugifyName` and
`packages/canopycms/src/assets/keys.ts`'s slug-generation both end with a trailing-run-trim step
using the same shape as the `/\/+$/` pattern fixed elsewhere this session
(`^-+|-+$` and `-+$` respectively — a quantifier immediately before an end anchor, no `/g`-global
protection against the underlying construct being reused unsafely elsewhere).

Measured directly: the ISOLATED regex fragment (`-+$` alone, fed a raw string with a long run of
hyphens not ending in a hyphen) reproduces the same polynomial blowup as the fixed `siteUrl` bug —
about 25.8s on a 128KB adversarial hyphen run, matching `/\/+$/`'s profile almost exactly.

**Both call sites are safe TODAY** because each is preceded by a step that already collapses every
run of non-alphanumeric/hyphen characters (including any pre-existing hyphens) down to a single
hyphen, so by the time the trailing-trim regex runs, no more than one hyphen can ever appear
anywhere in the string — the quantifier never has more than 1 character to (not) backtrack over.
Verified empirically: the real `slugifyName`, fed the same 128KB adversarial input directly (not
pre-collapsed), completes in under 1ms.

## Suggested fix

Not urgent, but fragile: the safety property depends entirely on step ordering that isn't enforced
by types or a test, so a future refactor (reordering the pipeline, extracting one step, or reusing
just the trim regex elsewhere) could silently reintroduce the same defect class this session fixed
twice. Either:
- Replace both trims with a linear character-scan helper (the same technique `stripTrailingSlashes`
  in `static/seo.ts` now uses, possibly factored into a small shared `trimTrailingChar` utility), or
- Add a regression test pinning that each function stays fast on a raw adversarial input fed
  directly to the whole function (not pre-collapsed), so a future reordering fails loudly instead
  of silently reopening the hole.
