# Content lifecycle scenario planning (editorial + development workflows)

Status: planning task (no code). Folded out of the original FIXES.md catch-all
(2026-07-24) when that file was dissolved; this was its last unowned substantive
item.

## Goal

Think through, end to end, the scenarios a real multi-editor production site will
hit — before they hit us. Produce a short written design (decision doc or
ARCHITECTURE.md section) covering:

- **Dev/staging/prod flow**: developers keep coding while editors edit — do code
  changes go through dev/staging/production environments, and how do content
  branches interact with each?
- **Schema changes vs content branches**: content branches through Canopy never
  change the schema, but code changes do. What happens to an in-flight content
  branch when the schema changes underneath it (rebase? migration? validation
  failure surfacing)? The `migrate` CLI + schema markers exist; the workflow
  story does not.
- **Long-lived vs short-lived branches**: **reframed 2026-08-14.** The original
  framing was "assume short-lived, design guardrails that keep branches short."
  Two things changed that. (1) The branch-only publish decision
  ([draft-publish-lifecycle.md](draft-publish-lifecycle.md)) makes a long-lived
  branch the *supported* answer for in-progress content — a half-written article
  is simply an open branch, since there is no per-entry draft state. (2) Per JP:
  assume some branches will be long-lived regardless, **because human reviewers
  forget about them.** So design for staleness *surfacing and recovery* — how a
  forgotten branch becomes visible, how it rebases without accumulating
  conflict debt, how it is retired — rather than for prevention. Auto-archival
  policy still applies, but as a backstop for the forgotten case, not as a way
  to enforce short branches.
- **Synchronization**: upstream merges now fast-forward the base workspace and
  auto-archive merged branches (PR #144); what remains is the conflict story for
  in-flight branches when upstream moves (surfacing, resolution UX).
- **PR-workflow checks**: which automated checks belong on content PRs —
  accessibility, SEO, link integrity? (Image shrinking is moot: the on-demand
  transform layer handles it.)

Also scour old plans/notes for prior thinking on these questions before starting
fresh (the original FIXES.md note suspected this was partially designed before).

## Related

- [post-merge-sync-gaps](resolved/post-merge-sync-gaps.md) (resolved) — solved the mechanical sync half; this
  task owns the workflow/UX half.
- [locked-branch-status-dead](resolved/locked-branch-status-dead.md) (resolved) — post-submit editing semantics, one
  concrete slice of this space; settled as "submitted implies locked" (the
  `'locked'` literal was deleted).
- [dev-settings-per-branch](dev-settings-per-branch.md) — settings-vs-branch isolation, another slice.
