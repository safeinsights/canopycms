# init should respect adopter conventions (style, package manager)

**Status**: proposed
**Priority**: P2 (enhancement)
**Origin**: surfaced while scaffolding `safeinsights/website` on 2026-04-17 — init emitted double-quoted, semicolon-terminated TypeScript into a repo whose Prettier config demanded single quotes and ASI, and the final "Next steps" block suggested `npm install` even though the repo uses pnpm. Both forced hand-cleanup.

## Motivation

`npx canopycms init` is an adopter's first substantive contact with CanopyCMS. The generated files become the baseline for everything they build. Today, those files:

1. Use a hard-coded style (double quotes, semicolons) that may conflict with the adopter's Prettier / ESLint config, causing lint errors and noisy diffs on the very first commit.
2. Print `npm install ...` in the next-steps summary regardless of which package manager the repo uses.

A principled fix: detect what the target repo already uses and match it. Fall back to current defaults when nothing is declared.

## Proposed behavior

### Style detection

Before emitting any file, look for (in order):

1. **`.prettierrc` / `.prettierrc.{json,js,mjs,cjs,yml,yaml}` / `prettier` key in `package.json`** — read `semi`, `singleQuote`, `tabWidth`, `trailingComma`, `printWidth`. Use these when formatting emitted source.
2. **`.editorconfig`** (`[*]` or `[*.ts]` section) — read `indent_style`, `indent_size`, `end_of_line`, `insert_final_newline`, `max_line_length`.
3. **Fallback** — current defaults (double quotes, semicolons, 2-space).

The emitter should delegate to Prettier itself when it's installed in the target tree: run generated strings through `prettier.format(..., resolvedConfig)` before writing. That sidesteps the need to re-implement style decisions.

### Package manager detection

Look for a lockfile at the target's `sourceRoot` (and walk up if monorepo):

- `pnpm-lock.yaml` → pnpm
- `package-lock.json` → npm
- `yarn.lock` → yarn
- `bun.lockb` / `bun.lock` → bun
- none → default to npm (current behavior)

Also honor `packageManager` in `package.json` if set (takes precedence).

Use the detected manager in:

- The "Next steps" console block (`pnpm install canopycms …`, `pnpm run dev`).
- Any generated scripts that shell out (currently none, but future scaffolds should be aware).

### README / non-interactive signal

- Add `--package-manager <npm|pnpm|yarn|bun>` flag to force a choice in CI.
- Surface the detected style + package manager in the init header so adopters can see what was picked.

## Why Prettier delegation is the right core move

Implementing our own style knobs duplicates Prettier's job and will drift. Running generated code through Prettier before writing means:

- Single source of truth lives in the adopter's repo.
- Our templates can remain in one canonical style; the formatter reconciles.
- If Prettier isn't installed in the target, we fall back to our current defaults and warn once.

Tradeoff: init picks up a runtime dependency on Prettier being resolvable from the target (acceptable — we already assume Node + npm-like package managers).

## Out of scope

- Full ESLint-rule detection (beyond what Prettier covers). Adopters can run their own lint afterward.
- Rewriting existing scaffolded files on config change (one-shot only).

## Implementation sketch

1. `src/cli/init.ts` — add `detectStyle(cwd)` and `detectPackageManager(cwd)`.
2. `src/cli/init.ts` — if Prettier resolves from `cwd`, lazy-import and format each emitted string.
3. Next-steps printer — take detected `pm` and template the suggested commands.
4. Test coverage:
   - Snapshot a fresh init into an empty dir (current behavior).
   - Snapshot into a dir with `.prettierrc` demanding `{ semi: false, singleQuote: true }` — assert output respects it.
   - Snapshot into a dir with `pnpm-lock.yaml` — assert next-steps mentions `pnpm`.

## Acceptance

- Running `npx canopycms init` in a repo whose `.prettierrc` bans semicolons and mandates single quotes produces files that pass that repo's `prettier --check` with zero modifications.
- The next-steps block mentions the correct package manager for the repo.
- No regression in repos with neither Prettier nor a lockfile.
