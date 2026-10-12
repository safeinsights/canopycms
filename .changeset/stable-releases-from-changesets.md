---
'canopycms': patch
---

### Stable releases follow the changes they carry, and ship their changelog

<!-- migration
area: Ops
action: None
row: Stable versions follow changesets; CHANGELOG.md ships
-->

**What changed.** A stable version is now chosen by what it carries: a minor when an entry asks
adopters to act, a patch otherwise. The first one is `0.1.0`. Each stable build ships this
changelog as `node_modules/canopycms/CHANGELOG.md`, with its links pinned to the release commit,
as int builds already do.

**To adopt.** Nothing. With `0.1.0` and later, a `^0.1.0` range takes patches without action.
