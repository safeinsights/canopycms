# Nothing checks `.claude/future-tasks/<name>.md` references outside the backlog tree

**Priority: P2 [NEITHER].**

`pnpm lint:tasks` (`scripts/check-future-tasks.mjs`) validates links **between** files under
`.claude/future-tasks/`. It does not scan the rest of the repository, so a source-code comment or doc
that cites `.claude/future-tasks/<name>.md` has no guard when that file is later resolved and moved
into `resolved/`. Source comments cite task files in many places (`packages/**/src`, `ARCHITECTURE.md`,
`DEVELOPING.md`, `docs/`), and each resolve-and-move can strand them: moving a task file means
re-pointing every outside citation by hand, and nothing says when one was missed.

The path going stale is often a signal that the surrounding prose is stale too, so a fix should read
each site rather than blind-replace.

## Fix

Extend `scripts/check-future-tasks.mjs`, or add a second check, to grep the repository (excluding
`node_modules`, `dist`, `docs/reviews/`) for `.claude/future-tasks/<name>.md` and flag any citation whose target now exists only
as `resolved/<name>.md` or not at all. This class is fully mechanical to check.
