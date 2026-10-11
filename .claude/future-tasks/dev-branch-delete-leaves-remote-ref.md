---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, from the editor UI epic's WS3b UX walk. Deleting a branch in dev mode removes its clone and registry entry but leaves its ref in the dev remote (`.canopy-dev/remote.git`), so a later branch with the same name can collide
---
# Dev-mode branch delete leaves the remote ref

A walk of `apps/example1` created, submitted and then deleted a branch through the Branches
drawer. The clone and the registry entry went, but `apps/example1/.canopy-dev/remote.git` kept
the branch's ref, which had to be removed by hand with `git branch -D`.

Check the dev operating mode's delete path (`operating-mode/`, `api/branch.ts`'s delete
handler) for the remote-ref step that prod's GitHub branch delete covers.
