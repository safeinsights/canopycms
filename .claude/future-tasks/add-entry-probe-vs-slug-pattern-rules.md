---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 548's review. The entries listing's `canAddEntry` probes `<collection>/*`, so a hand-written slug-pattern rule (`content/posts/u1-*`) never decides it: a user that rule lets create entries loses "Add entry…", and one it refuses is still offered it. The Permission Manager writes only folder and exact-entry rules, so only hand-edited `permissions.json` meets this
---

# "Add entry" and slug-pattern path rules

`listEntriesHandler` (`api/entries.ts`) sets `collectionAccess[].canAddEntry` from
`checkAccess("<collection>/*", 'edit')`. minimatch reads the probe as literal text, so folder rules
(`<collection>/**`) and ancestor rules decide it, and an exact-entry rule (`<collection>/<slug>`)
never does, which is the intent.

A rule with a slug pattern sits between: `content/posts/u1-*` matches some new slugs and not
others, and the probe matches none of them. With `defaultPathAccess: 'deny'` and that rule
allowing `u1`, "Add entry…" is hidden from `u1` although creating `content/posts/u1-new` succeeds.

## Fix, if wanted

Report three states: when a rule that is neither collection-wide nor an exact entry could match a
slug in the collection, say unknown and offer the action (the server still checks the create).
