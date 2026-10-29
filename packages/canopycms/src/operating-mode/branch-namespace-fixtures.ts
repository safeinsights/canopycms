/**
 * Shared branch-namespace test fixture.
 *
 * The rules deciding whether a branch-namespace template is usable exist TWICE by necessity: at
 * runtime (`branch-namespace.ts`'s `resolveBranchNamespaceTemplate`) and at synth time
 * (`canopycms-cdk`'s `constructs/cms-service.ts`, which does not import core). A rule tightened
 * at runtime but not at synth synths clean and then crash-loops the gateway at boot, so
 * canopycms-cdk's suite requires the construct's verdict to match core's for every template here.
 * Add a case when you change either copy of the rule.
 *
 * Dependency-free (plain arrays, no vitest import) so the CDK suite can import it across the
 * package boundary. Every template is resolved with the deployment name `prod`.
 */

/** Templates both copies must ACCEPT, each with the namespace it resolves to for `prod`. */
export const VALID_BRANCH_NAMESPACE_TEMPLATES = [
  ['canopycms/{deployment}/', 'canopycms/prod/'],
  ['cms/', 'cms/'],
  ['{deployment}/', 'prod/'],
  ['edits/{deployment}/drafts/', 'edits/prod/drafts/'],
  ['{deployment}-{deployment}/', 'prod-prod/'],
  ['team.a/{deployment}/', 'team.a/prod/'],
  ['Heads2/', 'Heads2/'],
  ['x.locked/', 'x.locked/'],
] as const

/** Templates both copies must REJECT. */
export const INVALID_BRANCH_NAMESPACE_TEMPLATES = [
  ['no trailing slash', 'canopycms/{deployment}'],
  ['the empty string', ''],
  ['an unknown placeholder', 'canopycms/{env}/'],
  ['an unclosed placeholder', 'canopycms/{deployment/'],
  ['a stray close brace', 'canopycms/}/'],
  ['a space', 'canopycms edits/'],
  ['a percent sign', 'canopycms%2f/'],
  ['a double quote', 'canopycms"/'],
  ['dot-dot', 'canopycms/../'],
  ['an empty path component', 'canopycms//{deployment}/'],
  ['a leading slash', '/canopycms/'],
  ['a leading dash', '-canopycms/'],
  ['a leading dot', '.canopycms/'],
  ['a dot-led component', 'canopycms/.hidden/'],
  ['a .lock component', 'canopycms.lock/{deployment}/'],
  ['a reflog selector', 'canopycms@{1}/'],
  ['a tilde', 'canopycms~1/'],
  ['a caret', 'canopycms^/'],
  ['a colon', 'canopycms:/'],
  ['a question mark', 'canopycms?/'],
  ['an asterisk', 'canopycms*/'],
  ['an open bracket', 'canopycms[/'],
  ['a backslash', 'canopycms\\/'],
  ['non-ASCII', 'café/'],
  ['a newline', 'canopycms\n/'],
  ['a leading refs/', 'refs/heads/'],
  ['a leading heads/', 'heads/{deployment}/'],
  ['a leading tags/', 'tags/'],
  ['a leading remotes/ in another case', 'Remotes/'],
  ['a name over the length limit', `${'a'.repeat(250)}/`],
  ['the settings branch prefix', 'canopycms-settings-/'],
  ['the settings branch prefix, after a slash', 'canopycms/settings-/'],
  ['the settings branch prefix, after sanitizing', 'canopycms-settings!/'],
  ['the settings branch prefix, through a placeholder', 'canopycms-settings-{deployment}/'],
] as const
