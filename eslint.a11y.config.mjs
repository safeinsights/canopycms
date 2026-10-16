// `pnpm lint:a11y`: the editor's jsx-a11y rules as errors, ratcheted by ESLint's
// bulk suppressions in scripts/a11y-suppressions.json. An existing violation is
// suppressed by its per-file, per-rule count; a new one fails, and so does a
// suppression a linted file no longer needs (ESLint ignores entries for files
// it did not lint, such as a deleted one). After fixing one, run
// `pnpm lint:a11y --prune-suppressions`.
//
// A separate config because a suppressions file is keyed by paths relative to
// ESLint's cwd: `pnpm lint` runs from packages/canopycms and lint-staged from
// the repo root, so one file cannot serve both. eslint.config.mjs runs the same
// rules as warnings, so a disable directive naming one resolves in both.
import baseConfig, { editorA11yConfig } from './eslint.config.mjs'

/** @type {import('eslint').Linter.Config[]} */
const a11yConfig = [...baseConfig, editorA11yConfig]

export default a11yConfig
