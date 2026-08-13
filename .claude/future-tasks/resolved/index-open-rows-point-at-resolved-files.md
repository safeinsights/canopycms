# `index.md` open tables still list five tasks that live in `resolved/`

Found 2026-08-12 while resolving an `index.md` merge conflict on PR #186.
Pre-existing on `integration-202607-a` (verified against tip `f8a912e6`), not
introduced by that PR.

## The drift

Five rows sit in the OPEN priority tables while their target file is in
`resolved/`, so the link is also broken — it points at
`.claude/future-tasks/<name>.md`, which no longer exists:

- `dual-build-ci.md` (P1)
- `editor-async-patterns.md` (P1)
- `swr.md` (P1)
- `program-a-release-path.md` (Active program)
- `program-b-canopy-hardening.md` (Active program)

Note `swr.md` and `editor-async-patterns.md` already appear correctly in the
Resolved table as a combined row, so those two are duplicated rather than
merely misplaced. Same for `program-a-release-path.md`.

## Why it matters

The file states "The tables above list OPEN work only," and program sequencing
reads those tables. Five closed items presented as open overstates remaining
work, and the dead links cost a lookup each time someone follows one.

## How to catch it

This check finds them, and would make a cheap CI guard or pre-commit hook over
`.claude/future-tasks/`:

```sh
awk '/^## Resolved/{exit} /^\| \[/{print}' .claude/future-tasks/index.md \
  | grep -oE '\]\([a-z0-9-]+\.md\)' | tr -d ']()' | sort -u \
  | while read -r f; do
      [ -f ".claude/future-tasks/resolved/$f" ] && echo "STALE OPEN ROW: $f"
    done
```

A companion check worth adding at the same time: every open row's link target
should exist at `.claude/future-tasks/<name>.md` at all (catches a moved file
whose row was never updated, which is the same bug seen from the other side).

## Why it wasn't fixed on the spot

PR #186 was one of six concurrent branches all editing `index.md`; editing rows
it didn't own would have widened an already-conflicting file for the others.
The rows are also a curation call for whoever owns the program document.

## Related

- [[production-readiness-program]] — the hub whose sequencing reads these tables.
