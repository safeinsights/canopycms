# [P2] Surface dev content divergence in-app, not only in the dev-server log

Raised by JP, 2026-08-22, while looking at a real `pnpm dev` log where the
"working-tree content has diverged" warning was repeating and scrolling away. The
**terminal** half is now fixed (see below); the **in-app** half is not, and the open
question about *where* it belongs is the reason this is a task rather than a follow-on
commit.

## What already shipped

`packages/canopycms/src/dev-content-watcher.ts`, on `epic/infra-review-2026-08`:

- The watcher registry moved from module scope to `globalThis`, so Next's per-route-bundle
  re-evaluation of the server graph stops arming a second watcher and re-printing the
  startup warning.
- `reportOnce` suppresses a verbatim repeat of the last message (divergence block,
  retraction, and both error paths).
- The block is now a colored, gutter-framed notice with blank lines around it and a
  per-category file cap of 5, so it is findable in a scrolling request log.
- Resolving the divergence emits a one-line retraction, so an announced condition gets an
  announced end.

## What is still wrong

Divergence is a **condition**, not an event: it stays true until someone runs
`canopycms sync push`. A scrolling append-only log is structurally the wrong home for a
condition — the notice is now printed once and printed loudly, but a developer who starts
the server, walks away, and comes back to 200 lines of request log still has no way to
see the current state without restarting. The terminal fix bought legibility, not
persistence.

The in-app surface is the one that can be persistent, actionable, and dismissible: it can
say "still diverged" at the moment the developer is looking at the stale page, which is
exactly when it matters.

## Open question — which surface(s)?

**This is the decision that blocks the work, and it is JP's call.**

1. **Editor UI only.** Lowest risk, uses touchpoints that already exist (the catch-all API
   route plus a Mantine banner in the editor chrome). But the developer seeing stale
   content is often looking at the *site*, not the editor, so it may not be where the
   problem is noticed.
2. **Non-editor (host app) view too.** Catches the case above, but a dev-only badge on the
   host app is a **new touchpoint between CanopyCMS and the adopter app** — which
   `AGENTS.md` requires approval for — and it drags editor concerns into host-app styling,
   which the project keeps deliberately separate. Would need to be strictly dev-mode,
   zero-footprint in any production build, and opt-in.
3. **Both, gated differently:** always in the editor, opt-in via `dev.contentSync` in the
   host app.

Note that (2)/(3) also raise a bundling question: anything mounted in the host app has to
come from `canopycms/client` and must not pull server-only deps (`pnpm lint:bundle`
enforces this).

## Fix direction, once the surface is chosen

- A dev-only read endpoint under the existing catch-all route returning the current
  `ContentTreeDiff` (`sync-core.ts`'s `diffContentTrees` already produces it; the watcher
  would publish its last result rather than the endpoint re-diffing per poll).
- A banner component reading it, showing the counts and the `sync push` command, with the
  file lists behind a disclosure rather than inline.
- Keep `dev.contentSync: 'off'` as the single silence switch for terminal and UI alike.

## Related

- `packages/canopycms/src/dev-content-watcher.ts` — the terminal half, and the module doc
  comment that points here.
- [dev-mode-build-reads-branch-clone-not-working-tree.md](dev-mode-build-reads-branch-clone-not-working-tree.md)
  — the adjacent working-tree-vs-branch-clone confusion, same root cause in the mental
  model.
