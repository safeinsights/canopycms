const config = {
  // `mjs`/`cjs` were missing here until 2026-08-22, which is half of why the
  // root scripts/ directory went unlinted: pnpm lint could not reach it and
  // neither could the commit hook.
  '*.{js,jsx,mjs,cjs,ts,tsx,md,html,css,json,yaml,yml}': ['prettier --write', 'eslint --fix'],
  // Client-bundle boundary is a whole-graph property, so this runs once per
  // commit that touches package sources rather than once per file.
  'packages/canopycms{,-next}/src/**/*.{ts,tsx}': () => [
    'pnpm run lint:bundle',
    // Import cycles are a whole-graph property too, and the edge that closes
    // a cycle is usually in the file that did NOT change.
    'pnpm run lint:cycles',
  ],
  // Comment budget is a whole-tree property too: a run cap or ratio is scoped
  // to one directory, so the check recomputes every directory's actuals and
  // compares them with the committed baseline in one pass (it never writes
  // the baseline), once per commit rather than once per file.
  '{packages/*/**/*.{ts,tsx,mts,cts,js,mjs,cjs},scripts/**/*.{mjs,js,ts},scripts/comment-budget.json}':
    () => 'pnpm run lint:comments',
  // Backlog consistency (dead links, stale open rows, orphans) is likewise a
  // whole-tree property: a link breaks in the file that did NOT change when its
  // target moved, so a per-file check would miss exactly the case that rots.
  '.claude/future-tasks/**/*.md': () => 'pnpm run lint:tasks',
  // Both editor UX ratchets compare whole-tree counts with a committed
  // baseline, which a fix below the baseline must also update.
  '{packages/canopycms/src/editor/**/*.{ts,tsx},scripts/check-ux-copy.mjs,scripts/ux-copy-baseline.json,package.json}':
    () => 'pnpm run lint:ux-copy',
  '{packages/canopycms/src/editor/**/*.tsx,eslint.config.mjs,eslint.a11y.config.mjs,scripts/a11y-suppressions.json,package.json}':
    () => 'pnpm run lint:a11y',
  // Doc factual drift is whole-tree for the same reason: renaming a module
  // breaks the doc that did NOT change. Cheap enough to run on any md, or on
  // any move/rename of a package source file.
  '**/*.md': () => 'pnpm run lint:docs',
  'packages/*/package.json': () => 'pnpm run lint:docs',
  'scripts/docs-budgets.json': () => 'pnpm run lint:docs',
  // An account id can land in any file type, and the scan of every tracked
  // file takes well under a second, so any staged file triggers it.
  '**/*': () => 'pnpm run lint:account-ids',
}

export default config
