/**
 * What the GitHub App is called and what it may do: naming, the permission
 * set, and the read-back check `verify` runs against an installation. Pure,
 * so init-github-app.test.ts covers it without a live App.
 */

/** Permission levels GitHub uses for App repository permissions, weakest first. */
const PERMISSION_LEVELS = ['read', 'write', 'admin'] as const
type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
export type PermissionSet = Readonly<Record<string, PermissionLevel>>

/**
 * The App's entire security surface. Every entry names the call site that
 * forces it — a permission justified only in a commit message can't be
 * re-checked. Enumerated from `github-service.ts`,
 * `worker/{task-runner,rebase}.ts`, and every git call reaching github.com;
 * `canopycms-cdk` makes no REST calls at all.
 * - `contents: write` — git over HTTPS (first-boot clone, per-cycle branch
 *   fetch, pushes) and `octokit.git.deleteRef`. GitHub's reference puts ref
 *   deletion under Contents/write, not `administration` (the plausible wrong
 *   guess). Declared even though its only call site is currently commented
 *   out, since the handler goes live the moment a producer appears.
 * - `pull_requests: write` — `pulls.create`/`pulls.update`, and the GraphQL
 *   mutations `markPullRequestReadyForReview`/`convertPullRequestToDraft`,
 *   derived by analogy since GitHub's reference has no line for them.
 * - `metadata: read` — implied by any repository permission; declared so
 *   this object states the whole surface, not just the non-automatic part.
 * Nothing else: no `issues`, `administration`, `actions`, or organisation
 * permissions. No `workflows` either, though GitHub may refuse to push
 * rebased history touching `.github/workflows/` — see
 * .claude/future-tasks/worker-push-refused-when-base-changes-workflows.md.
 */
export const CANOPY_APP_PERMISSIONS: PermissionSet = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
}

/**
 * GitHub's limit on an App's display name: documented as unlimited, but a
 * 39-character name was refused while 33 was accepted, so the true bound is
 * 33..38, and 34 is the safe direction — a wrongly-refused name costs one
 * `--name` flag, a wrongly-accepted one a browser round trip to find out.
 */
export const APP_NAME_MAX_LENGTH = 34

/**
 * How much of a description the account's App LIST renders before
 * truncating, mid-word with an ellipsis: an opening "Read-only,
 * organisation-wide. Lets th…" was cut at 37 characters, by CHARACTER not
 * line — hence `appDescription`'s shape: a summary inside this budget, then
 * the detail only the App's own page shows.
 * @internal Exported for tests.
 */
export const APP_SUMMARY_MAX_LENGTH = 37

/**
 * The App's display name, named after the REPOSITORY (per-site — see
 * init-github-app.ts's header). Names are unique across all of GitHub, not just the account, so
 * `create` pre-checks with `checkNameAvailable` and `--name` overrides.
 */
export function appName(repo: string): string {
  return `${repo} CanopyCMS`
}

/**
 * GitHub's slug derivation, as far as this needs it: lowercase, runs of
 * non-alphanumeric characters collapse to single hyphens. Pinned by a test —
 * if GitHub ever derives differently, the name pre-check goes blind, not loud.
 */
export function appSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * A short summary that survives the App list's truncation, then the detail —
 * deliberately generic, since this text lives ON GITHUB and goes stale
 * silently with no way to detect it here.
 */
export function appDescription(): string {
  return [
    'Commits content edits, opens PRs',
    '',
    'Lets CanopyCMS publish edits made in its editor: it pushes content branches to this ' +
      'repository and opens or updates the pull request that carries them. Installed on one ' +
      'repository, and registered per site — so this key cannot reach another site’s repository.',
  ].join('\n')
}

/** The parts of GitHub's installation object this tool reads back. */
export type InstallationSummary = {
  id: number
  permissions?: Record<string, string>
  repository_selection?: string
  suspended_at?: string | null
  app_slug?: string
}

export type ReadbackFinding = {
  severity: 'error' | 'warn'
  message: string
}

function isPermissionLevel(value: string): value is PermissionLevel {
  return (PERMISSION_LEVELS as readonly string[]).includes(value)
}

function rank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level)
}

/**
 * Compare what an installation holds against what this package needs. Pure,
 * so testable without a live App — reports in BOTH directions, since an
 * extra or over-wide permission works perfectly and goes unnoticed.
 */
export function readbackVerdict(
  installation: InstallationSummary,
  desired: PermissionSet = CANOPY_APP_PERMISSIONS,
): ReadbackFinding[] {
  const findings: ReadbackFinding[] = []
  const held = installation.permissions ?? {}

  if (installation.suspended_at) {
    findings.push({
      severity: 'error',
      message:
        `the installation is SUSPENDED (since ${installation.suspended_at}). ` +
        'A suspended installation authenticates and then refuses everything, so this ' +
        'presents as a permission problem that no permission change fixes.',
    })
  }

  // `undefined` is NOT `selected`: an absent field means GitHub didn't say, and
  // treating that as the narrow case would be the check quietly passing itself.
  if (installation.repository_selection !== 'selected') {
    findings.push({
      severity: 'error',
      message:
        `repository_selection is ${JSON.stringify(installation.repository_selection ?? null)}, ` +
        'expected "selected". This App is registered per site: an installation covering every ' +
        'repository in the account means its key reaches repositories it was never meant to.',
    })
  }

  for (const [name, level] of Object.entries(desired)) {
    const actual = held[name]
    if (actual === undefined) {
      findings.push({
        severity: 'error',
        message: `missing permission ${name}: ${level} — the installation holds no ${name} grant at all.`,
      })
      continue
    }
    if (actual === level) continue
    // Exact match is the only pass: an unknown level is reported, not ranked,
    // since guessing where it sits is how a check goes blind.
    if (!isPermissionLevel(actual)) {
      findings.push({
        severity: 'error',
        message:
          `permission ${name} is "${actual}", which is not a level this check knows ` +
          `(${PERMISSION_LEVELS.join('/')}). Compare it against "${level}" by hand.`,
      })
      continue
    }
    if (rank(actual) < rank(level)) {
      findings.push({
        severity: 'error',
        message: `permission ${name} is "${actual}", which is weaker than the required "${level}".`,
      })
      continue
    }
    // Stronger than required is still wider than intended: it works perfectly,
    // so nothing else will ever notice it.
    findings.push({
      severity: 'error',
      message:
        `permission ${name} is "${actual}", which is STRONGER than the required "${level}". ` +
        'Wider than intended is the failure that works perfectly and is never noticed.',
    })
  }

  for (const [name, level] of Object.entries(held)) {
    if (desired[name] === undefined) {
      findings.push({
        severity: 'error',
        message:
          `permission ${name}: ${level} is held but NOT needed. Wider than intended is the ` +
          'failure that works perfectly and is never noticed — remove it from the App.',
      })
    }
  }

  return findings
}
