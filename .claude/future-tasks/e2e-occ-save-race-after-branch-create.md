# Intermittent OCC 409 when saving immediately after branch create/switch (e2e flake)

**Priority:** P1 (last remaining e2e instability; likely a real editor-facing race)

## Symptom

In full `pnpm test:e2e` runs, a test that creates a branch and then immediately
edits + saves the Home entry intermittently fails in `saveAndVerify` — the PUT
returns **409** and the editor shows the toast "Content was modified by another
editor. Reload to see the latest changes." Which test hits it varies by run:
`branch-workflow.spec.ts:33` / `:112` / `:215`, `conflict-management.spec.ts:41`
("edit Home Page on branch" step). All pass when their spec file runs in
isolation. Observed both before and after the 2026-07-24 e2e fix batch, so it is
a pre-existing race, not a regression from those fixes.

## Mechanism (established)

- Content OCC is **mtime-based**: `ContentStore` captures `version =
  stat.mtimeMs` on read and rejects writes when `expectedVersion` doesn't match
  the file's current mtime (`content-store.ts`, `ContentConflictError`;
  `api/content.ts` maps it to 409).
- The failing flow re-reads the entry on the new branch (`selectEntry`), so the
  409 means **something bumps the branch clone's content-file mtime between the
  editor's read and the save**, shortly after branch provisioning.

## Ruled out

- `dev-content-watcher.ts` — only logs divergence warnings; writes nothing into
  clones.
- Reference/schema validation — the 409 is the OCC path, not 422 validation.

## Suspects to investigate

- Branch provisioning finalization steps that run after the create API
  responds (git config/checkout touching working-tree files, base-snapshot
  commit, content-index generation side effects).
- Any git operation in the request path that re-checks-out or touches files in
  the clone (e.g. `ensureAuthor`, `ensureRemote` paths in `git-manager.ts`).
- Whether the editor can fire a save while the post-branch-switch entry reload
  is still in flight (stale version token window in `useDraftManager`).

## Repro

Run the full suite from any checkout (`pnpm test:e2e`); fails ~1-2 tests per
full run, never in isolation. To instrument: log `stat.mtimeMs` at read and at
the OCC rejection in `ContentStore.write`, plus timestamps of branch-provision
steps, and diff the timeline.

## Possible fixes (once the toucher is identified)

- Make branch-create not report ready until all mtime-touching finalization is
  done.
- Or switch the OCC token from mtime to a content hash (mtime is also fragile
  on EFS/NFS — see docs/concurrency.md before changing).
- Or have the editor disable save until the entry re-read after branch switch
  completes.
