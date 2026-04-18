# Next 16.2.x + PostCSS fork-bomb on adopter dev servers

**Status**: observed, not yet root-caused upstream
**Priority**: P1 (blocks adopter upgrades to Next 16.2.x)
**Observed**: 2026-04-17 in `safeinsights/website` (Node 24.12, pnpm 10.12, Mantine 8.3.18, Turbopack)
**Workaround**: pin `next` to `~16.1.6` (16.1.7 works).

## Symptom

`pnpm dev` boots normally (`✓ Ready in ~300ms`), logs `○ Compiling / ...`, and then the Node process tree fork-bombs — hundreds of `node` processes appear within seconds (observed 255 → 907 → climbing). The dev terminal itself stays quiet after `Compiling /`; the spawning is invisible without a `ps` snapshot from another terminal. Fan spins up; eventually the machine saturates.

Process count follows 2ⁿ − 1 (255, 511, 1023 …) — classic self-replicating fork pattern.

## Reproduction (minimal)

1. `next@16.2.4` + Turbopack (`next dev --turbopack`).
2. A PostCSS config that pulls in Mantine plugins: `postcss-preset-mantine` + `postcss-simple-vars` with Mantine breakpoint vars.
3. Any CSS file imported from `app/layout.tsx` — tested with:
   - `@mantine/core/styles.css` alone → fork bomb
   - `./globals.css` (plain 20-line reset) alone → fork bomb
   - No CSS imports at all → fine
4. Visit `/` once. Fork bomb starts during the first compile.

Not reproduced on Next **16.1.7** with the same app tree, same Mantine version, same Turbopack, same PostCSS config.

## Bisection results

- `withCanopy` bypass: no change.
- Mantine components removed from `page.tsx`: no change.
- `next/font/google` imports removed: no change.
- `MantineProvider` + `ColorSchemeScript` removed: no change.
- **All CSS imports removed**: fork bomb stops.
- Any one CSS import restored: fork bomb returns.

Therefore the bomb is in Next 16.2.x's PostCSS handling under Turbopack, triggered by having a `postcss.config.cjs` that resolves plugins.

## Impact

- Every adopter who runs `pnpm add next@latest` after 16.1.x landed on npm will hit this on first `pnpm dev`. CanopyCMS's `init` recommends Mantine or similar styling layers that ship CSS, so PostCSS is on the critical path.

## What to do upstream

- Reproduce in a minimal repo (Next 16.2.4 + `postcss.config.cjs` + any CSS import).
- Track the Next.js issue or file one if none exists. Likely candidates: a Turbopack regression in their PostCSS plugin loader, or a new worker-pool behavior that retries recursively on unresolved plugins.
- Consider pinning `next` in CanopyCMS's own example apps until the regression is fixed, and add a note to the adopter README: "known-good Next versions: 14.2.25, 15.x, 16.1.x. Avoid 16.2.x."
- If the root cause is in Turbopack only, document the workaround `next dev --webpack` (though that breaks `withCanopy` React-alias support for `file:` symlinks per existing caveat).

## What adopters should do meanwhile

- Pin `next` to `~16.1.6` (caret or tilde — both resolve to 16.1.x). Keep the pin until CanopyCMS docs confirm a good 16.2.x or 16.3.x.
- The downgrade is safe for our usage surface — 16.1 and 16.2 are compatible at the API level for App Router + Turbopack dev + static export.
