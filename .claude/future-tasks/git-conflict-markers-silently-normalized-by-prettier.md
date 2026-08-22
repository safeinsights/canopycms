# Unresolved git merge-conflict markers can survive a commit undetected, because prettier reformats them into valid-looking Markdown instead of erroring

**Status:** Open. **Priority: P1.** Found 2026-08-22 while verifying the CI path-filter /
stale-comment items on `epic/adopter-request-intake`. Not previously filed.

## The defect

`AGENTS.md` on `epic/adopter-request-intake` (as of commit `1a0e8747`, before this fix) contained
**two full hunks of unresolved git conflict markers** — `<<<<<<< HEAD` / `=======` / `>>>>>>>
origin/epic/adopter-request-intake` — left in place by a merge (`85ba085e Merge epic into
fix/editor-warnings-and-gate-coverage`) that was never actually resolved before being committed.

The reason nobody caught it: the very next commit, `848ea0d6 style: prettier AGENTS.md after the
merge`, ran `pnpm exec prettier --write` on the file. Markdown gives `>` and `=` lines syntactic
meaning — a line of `>` characters is a blockquote marker, and a line of `=` characters directly
under a text line makes that line a Setext heading. Prettier's Markdown formatter does not know
about git conflict semantics; it happily parsed the conflict markers as ordinary Markdown and
**reformatted them into something that reads as plausible prose**, camouflaging the corruption
instead of erroring on it:

- `>>>>>>> origin/epic/adopter-request-intake` was re-flowed into `> > > > > > > origin/epic/adopter-request-intake` (prettier's own blockquote-nesting normalization — each bare `>` became its own nesting level).
- A `=======` divider immediately after a bullet's text was consumed into that bullet, leaving a stray `- #` artifact where the divider used to be (visible as `- # \`utils/\` - Shared utilities...` in the corrupted file — the `#` is a Setext-heading leftover, not a typo).

The result was a docs file that:

1. Still contained the literal strings `<<<<<<< HEAD` and (mangled) `>>>>>>>`, so a plain
   `grep -rn "<<<<<<<"` over the repo DOES still catch it — but nothing runs that check today.
2. Passed `pnpm exec prettier --write` and `pnpm lint` with no error, because prettier only
   validates Markdown *syntax*, not conflict-marker semantics, and nothing else parses `.md` files
   at all.
3. Was silently read as project context by every subsequent Claude Code session in this repo
   (`AGENTS.md` is `@`-included from `CLAUDE.md`), degrading every session's understanding of the
   `validation/`, `utils/`, and "Top-level files" sections until someone happened to read the raw
   file closely enough to notice the duplicated/garbled bullets.

A second, cleaner instance existed in `.claude/future-tasks/entrypath-read-resolves-by-entry-type-name.md`
(a genuine 3-marker conflict, not mangled by prettier since it wasn't re-formatted) — smaller
blast radius, but the same root cause: nothing in the repo's tooling rejects a commit containing
conflict markers.

Both instances were fixed by hand in the branch that found this (merging the two sides' independent
content additions rather than picking one side and discarding the other's information).

## Why it deserves a task rather than a comment

- **The failure is silent at every layer that should have caught it**: the merge itself (no `git
  diff --check` or equivalent run before commit), `prettier --write` (reformats rather than
  errors), `pnpm lint` (doesn't touch `.md`), and `pnpm lint:tasks` (scoped only to
  `.claude/future-tasks/*.md`, and even there only checks link integrity, not marker syntax).
- **It gets *harder* to spot after prettier runs**, not easier — the project's own "when you
  finish a task" workflow step 1 is `pnpm exec prettier --write`, which is exactly the tool that
  camouflaged this.
- **Any `.md` file is exposed**, not just docs read by humans: `AGENTS.md`/`CLAUDE.md` are loaded
  as LLM context every session, so a corrupted merge silently degrades every future agent's
  understanding of the codebase until a human notices prose that doesn't quite make sense.

## Suggested fix

A pre-commit hook (husky is already wired up — see root `package.json`'s `prepare: husky`) or a CI
step that greps the diff (or the full tree) for `^<<<<<<<[ \t]`, `^=======$`, `^>>>>>>>[ \t]` and
fails loudly. Cheap, fast, and catches the marker in EVERY file type, not just `.md` — a conflict
left in a `.ts` file would have failed typecheck/lint anyway (confirmed: the repo-wide sweep that
found this found conflict markers in exactly two files, both Markdown, for that reason), but a
dedicated check is more direct than relying on that as an incidental backstop, and it fires before
prettier ever gets a chance to launder the markers into something that looks intentional.
