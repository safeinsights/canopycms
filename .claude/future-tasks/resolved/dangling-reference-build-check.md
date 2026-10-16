---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/dangling-reference-integrity` — adopter request #93. A production build fails on a reference naming no entry, listing entry, field path (object, list and block positions) and id; `danglingReferences: 'warn'` downgrades it. The resolver logs each dangling reference once per process. `findDanglingReferences` is on `canopycms/server`
---
# A reference to a missing entry ships silently

A reference whose id named no entry resolved to `null` with no log line, so a page lost its byline
(and its structured-data author) from a build that exited 0. The editor refused to save a new
dangling id, but a deleted target, a merge, a hand edit or a `sync pull` still produced one. The
adopter wrote its own integrity test for each reference field; duplicate `urlPath`s, by contrast,
already failed the build.

Shipped as `static/`'s fifth build guard and the `MissingReference` shape, together with
[dangling-reference-null-overwrites-id.md](dangling-reference-null-overwrites-id.md).

## Related

- [validate-cli.md](../validate-cli.md) — running the build guards without a build.
