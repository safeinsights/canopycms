---
name: program-orchestrator
description: Drive a multi-workstream program (like the production-readiness program) across sessions — read the hub doc and log, pick the next workstream, run it via epic-workflow or hand it off, then record what was learned and update status
---

Run the layer above `epic-workflow`. That skill executes one epic well; this one
decides which epic runs next, keeps the durable record current, and makes the
orchestrator role re-creatable by any future session.

The program is defined by three kinds of file under `.claude/future-tasks/`:

- a **hub doc** (e.g. `production-readiness-program.md`) — workstreams, sequencing,
  status, decisions taken, open decisions, and any standing safety rules
- an **append-only log** (e.g. `program-log.md`) — findings, disproven
  assumptions, measurements, decisions and their reasoning
- **per-workstream files** (e.g. `program-b-*.md`) — each executable cold

## Phase 1 — Orient (always, before anything else)

1. Read the hub doc and the **entire** log. The log exists so you inherit
   findings instead of rediscovering them; skimming it defeats the point.
2. Read the file for any workstream marked in progress.
3. **Verify the recorded state against reality** before acting on it. Status rows
   are point-in-time. Check the actual branch/PR state (`git log`, `gh pr list`),
   and re-check any claim the log makes about live infrastructure — the log
   records what was true when written.
4. Report the real current state to the user, including drift between what the
   hub doc says and what you found.

## Phase 2 — Pick the next move

- Respect the sequencing graph and the blocked-by relationships in the hub doc.
- Prefer finishing an in-progress workstream over starting a new one.
- Workstreams marked parallel-safe can run alongside a blocked one.
- If the next move depends on an **open decision**, resolve it with the user
  before starting work, and record the decision in the hub doc's decisions table
  with its date and rationale.

## Phase 3 — Run it

Two shapes, chosen by size:

- **Run here** — for a workstream this session can carry: invoke `epic-workflow`
  and follow it. Small (S) workstreams may just be done directly in the main loop.
- **Hand off** — for a workstream deserving its own context budget: author a
  spawn-task chip whose prompt is self-contained. The prompt must name the
  workstream file, the base branch, the gates, the definition of done, and any
  standing safety rules from the hub doc. Assume the receiving session has read
  nothing.

Never run two heavy workstreams concurrently.

## Phase 4 — Record (the part that is easy to skip and most costly to skip)

When a workstream — or a meaningful chunk of one — completes:

1. **Append to the log.** Date, workstream tag, and what was actually learned:
   surprises, assumptions that turned out wrong, deploy-proven facts, dead ends
   worth not re-walking, decisions and why. Not progress narration; not anything
   already captured in a PR description or the workstream file.
2. **Update the hub doc**: status column, decisions table, open decisions that
   closed.
3. **Resolve the workstream file** into `resolved/` with an implementation
   summary, and move its index row to the Resolved section — per the project's
   standing rule.
4. **Capture new out-of-scope findings** as their own future-task files with
   index rows, linked from the log entry.

## Phase 5 — Propose the next move

End every session by telling the user what you would do next and why, based on
the updated hub doc. The user decides whether to continue here or spawn it.

## Ground rules

- **Committed docs describe the work, its state, and its decisions** — not session
  history, not how the work came to be organized, not who did what.
- The durable record is the git-tracked files, never the conversation. Anything
  worth carrying forward gets written down before the session ends.
- Standing safety rules in the hub doc (for this program: the rules protecting the
  teams' live docs site) are hard constraints. Check each step against them and
  say so explicitly when reporting.
- Don't let the program doc drift into a duplicate of the workstream files. The
  hub carries status, sequencing, and decisions; details live in the workstream
  files.
