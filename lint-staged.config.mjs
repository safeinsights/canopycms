const config = {
  '*.{js,jsx,ts,tsx,md,html,css,json,yaml,yml}': ['prettier --write', 'eslint --fix'],
  // Client-bundle boundary is a whole-graph property, so this runs once per
  // commit that touches package sources rather than once per file.
  'packages/canopycms{,-next}/src/**/*.{ts,tsx}': () => 'pnpm run lint:bundle',
}

export default config
