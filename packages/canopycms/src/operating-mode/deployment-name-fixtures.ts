/**
 * Shared deployment-name test fixture.
 *
 * The rule that decides whether a `deploymentName` is usable exists TWICE, by
 * necessity: once at runtime (`deployment-name.ts`'s `isValidDeploymentName`)
 * and once at synth time (`canopycms-cdk`'s `constructs/cms-service.ts`).
 * `canopycms-cdk` publishes without a runtime dependency on `canopycms`, so
 * the construct cannot import the real thing.
 *
 * The dangerous drift is asymmetric: a rule TIGHTENED at runtime but not at
 * synth produces a stack that synths clean and then crash-loops the Lambda at
 * boot — precisely what the synth guard exists to prevent. So both packages'
 * suites assert against this one list, and `canopycms-cdk`'s suite additionally
 * asserts that the construct's verdict matches this package's predicate for
 * every name here. Add a case here when you change either copy of the rule.
 *
 * Deliberately dependency-free (plain arrays, no vitest import) so the CDK
 * suite can import it across the package boundary without dragging anything
 * along.
 */

/** Names both copies of the rule must ACCEPT. */
export const VALID_DEPLOYMENT_NAMES = [
  'prod',
  'staging',
  'acme-prod_2.1',
  'a',
  '9lives',
  'team.prod',
  'PROD',
  'x.locked',
] as const

/**
 * Names both copies of the rule must REJECT, each with the reason it exists —
 * every entry is a value git itself would refuse as a ref component, or one
 * that would corrupt the worker's `.env` heredoc.
 */
export const INVALID_DEPLOYMENT_NAMES = [
  ['a slash (would add a ref hierarchy level)', 'team/prod'],
  ['whitespace', 'my prod'],
  ['a leading dash (parses as a git option)', '-prod'],
  ['a git-forbidden character', 'prod:1'],
  ['dot-dot', 'a..b'],
  ['a leading dot', '.prod'],
  ['a trailing dot', 'prod.'],
  ['a .lock suffix', 'prod.lock'],
  ['a tilde', 'prod~1'],
  ['a caret', 'prod^1'],
  ['a question mark', 'prod?'],
  ['an asterisk', 'prod*'],
  ['an open bracket', 'prod['],
  ['a backslash', 'prod\\1'],
  ['the empty string', ''],
  ['a newline (would inject a line into the worker .env)', 'prod\nEVIL=1'],
] as const
