const config = {
  // `mjs`/`cjs` were missing here until 2026-08-22, which is half of why the
  // root scripts/ directory went unlinted: pnpm lint could not reach it and
  // neither could the commit hook.
  '*.{js,jsx,mjs,cjs,ts,tsx,md,html,css,json,yaml,yml}': ['prettier --write', 'eslint --fix'],
  // Client-bundle boundary is a whole-graph property, so this runs once per
  // commit that touches package sources rather than once per file.
  'packages/canopycms{,-next}/src/**/*.{ts,tsx}': () => 'pnpm run lint:bundle',
  // Backlog consistency (dead links, stale open rows, orphans) is likewise a
  // whole-tree property: a link breaks in the file that did NOT change when its
  // target moved, so a per-file check would miss exactly the case that rots.
  '.claude/future-tasks/**/*.md': () => 'pnpm run lint:tasks',
  // Doc factual drift is whole-tree for the same reason: renaming a module
  // breaks the doc that did NOT change. Cheap enough to run on any md, or on
  // any move/rename of a package source file.
  '**/*.md': () => 'pnpm run lint:docs',
  'packages/*/package.json': () => 'pnpm run lint:docs',
}

export default config
