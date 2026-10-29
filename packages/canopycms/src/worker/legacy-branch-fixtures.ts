/**
 * Shared `legacyBranches` test fixture.
 *
 * The rules deciding whether a `legacyBranches` list is usable exist TWICE by necessity: at
 * runtime (`branch-policy.ts`'s `legacyBranchProblem` and the `BranchPolicy` constructor) and at
 * synth time (`canopycms-cdk`'s `constructs/cms-service.ts`, which does not import core). A rule
 * tightened at runtime but not at synth synths clean and then crash-loops the gateway at boot, so
 * both suites require their copy's verdict on every list here. Add a case when you change either
 * copy of the rule.
 *
 * Dependency-free (plain arrays, no vitest import) so the CDK suite can import it across the
 * package boundary. Each case is a resolved namespace and the list checked against it.
 */

const DEFAULT_NAMESPACE = 'canopycms/prod/'

/** Lists both copies must ACCEPT: `[label, namespace, entries]`. */
export const VALID_LEGACY_BRANCH_LISTS: readonly (readonly [string, string, readonly string[]])[] =
  [
    ['no entries', DEFAULT_NAMESPACE, []],
    ['plain names', DEFAULT_NAMESPACE, ['spring', 'feature/x', 'v1.0', 'Release-2']],
    ['a dash where the namespace has a slash', DEFAULT_NAMESPACE, ['canopycms-spring']],
    ['a sibling of the namespace', DEFAULT_NAMESPACE, ['canopycms/prodigy', 'canopycms/staging/x']],
    ['a name that only sanitizes into the namespace', DEFAULT_NAMESPACE, ['canopycms-prod-x']],
    ['another namespace', 'cms/', ['canopycms/prod/x', 'cmsx']],
    ['a sibling inside the parent of a custom namespace', 'cms/a/', ['cms/b']],
    ['1024 entries', DEFAULT_NAMESPACE, Array.from({ length: 1024 }, (_, i) => `r${i}`)],
  ]

/** Lists both copies must REJECT: `[label, namespace, entries]`. */
export const INVALID_LEGACY_BRANCH_LISTS: readonly (readonly [
  string,
  string,
  readonly string[],
])[] = [
  ['an entry in the namespace', DEFAULT_NAMESPACE, ['canopycms/prod/fix']],
  ['an entry in a custom namespace', 'cms/', ['cms/fix']],
  ['an entry named after the namespace', DEFAULT_NAMESPACE, ['canopycms/prod']],
  ['an entry named after part of the namespace', DEFAULT_NAMESPACE, ['canopycms']],
  ['an entry named after part of a custom namespace', 'edits/prod/drafts/', ['edits/prod']],
  ['a wildcard', DEFAULT_NAMESPACE, ['release/*']],
  ['a lone wildcard, which would switch the namespace off', DEFAULT_NAMESPACE, ['*']],
  ['a comma', DEFAULT_NAMESPACE, ['a,b']],
  ['a settings branch', DEFAULT_NAMESPACE, ['canopycms-settings-prod']],
  ['an empty entry', DEFAULT_NAMESPACE, ['']],
  ['a space', DEFAULT_NAMESPACE, ['a b']],
  ['a control character', DEFAULT_NAMESPACE, ['a\tb']],
  ['non-ASCII', DEFAULT_NAMESPACE, ['café']],
  ['a percent sign', DEFAULT_NAMESPACE, ['a%2fb']],
  ['a double quote', DEFAULT_NAMESPACE, ['a"b']],
  ['a brace', DEFAULT_NAMESPACE, ['a{b']],
  ['a leading dash', DEFAULT_NAMESPACE, ['-x']],
  ['a leading refs/', DEFAULT_NAMESPACE, ['refs/heads/main']],
  ['a leading tags/ in another case', DEFAULT_NAMESPACE, ['Tags/x']],
  ['a git-forbidden character', DEFAULT_NAMESPACE, ['release-?']],
  ['a tilde', DEFAULT_NAMESPACE, ['a~1']],
  ['a backslash', DEFAULT_NAMESPACE, ['a\\b']],
  ['dot-dot', DEFAULT_NAMESPACE, ['a..b']],
  ['a reflog selector', DEFAULT_NAMESPACE, ['a@{1}']],
  ['an empty path component', DEFAULT_NAMESPACE, ['a//b']],
  ['a leading slash', DEFAULT_NAMESPACE, ['/a']],
  ['a trailing slash', DEFAULT_NAMESPACE, ['a/']],
  ['a trailing dot', DEFAULT_NAMESPACE, ['a.']],
  ['a dot-led component', DEFAULT_NAMESPACE, ['a/.b']],
  ['a .lock component', DEFAULT_NAMESPACE, ['a.lock/b']],
  ['HEAD', DEFAULT_NAMESPACE, ['HEAD']],
  ['a lone @', DEFAULT_NAMESPACE, ['@']],
  ['a name over 255 characters', DEFAULT_NAMESPACE, ['a'.repeat(256)]],
  ['an entry listed twice', DEFAULT_NAMESPACE, ['spring', 'summer', 'spring']],
  ['1025 entries', DEFAULT_NAMESPACE, Array.from({ length: 1025 }, (_, i) => `r${i}`)],
]
