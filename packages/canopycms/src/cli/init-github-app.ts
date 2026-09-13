/**
 * `canopycms init-github-app <create|verify>` — registers the GitHub App the CMS
 * worker authenticates as, and reads its grant back.
 *
 * WHY THIS EXISTS: THE PERMISSIONS ARE CODE HERE
 *
 * The worker can authenticate as a GitHub App instead of a personal access token
 * (adopter request #45). What did not ship with it was any machine-checkable
 * statement of which permissions that App needs — the answer lived only as prose
 * in `docs/deploying-to-aws.md`, which nothing derives and nothing verifies.
 *
 * A PAT's scope only ever exists as checkboxes somebody ticked, so "is this
 * credential wider than intended?" is unanswerable from the repository. The
 * manifest flow takes the permission set as JSON, so `CANOPY_APP_PERMISSIONS`
 * below is reviewable, diffable, and a desired state a program can check —
 * against the call sites that force each entry (see the constant) and against
 * what an installation actually holds (see `verify`).
 *
 * And guessing too narrow does not fail loudly. `task-runner.ts`'s
 * `convert-to-draft` runs a GraphQL mutation, and a GraphQL failure answers HTTP
 * 200 with a body-level error carrying NO numeric status — so
 * `isPermanentTaskFailure` reads a permission denial as transient, retries to the
 * cap, and wedges the branch in `sync-failed` with nothing naming a permission.
 * `createOrUpdatePullRequest` swallows a failed `markPullRequestReadyForReview`
 * into a warning by design (`github-service.ts`), leaving the PR stuck as a
 * draft. Both surface hours after setup. `verify` moves that discovery to setup
 * time, which is the only cheap place to find it.
 *
 * ONE APP PER SITE. NOT ONE APP PER ORGANISATION.
 *
 * Worth stating at length because the obvious economy is to register one App and
 * install it on every repository that needs it, and for a READ-ONLY App whose key
 * never leaves GitHub that is right. It is wrong here, and the reason is
 * structural rather than a matter of taste:
 *
 * **A GitHub App's private key is App-level. Installation scoping is not a
 * boundary GitHub enforces against whoever holds the key — it is a choice the
 * key-holder makes at mint time.** Anyone with the key can sign a JWT, call
 * `GET /app/installations` to enumerate every installation, and mint an access
 * token for any of them.
 *
 * Our key does not stay in one place: each site's worker reads it at runtime,
 * from that site's own secret store, on that site's own host. So one shared App
 * with `contents: write` would mean that reading the marketing site's secret
 * store hands you write access to the documentation site's repository. One App
 * per site, one installation each, one key each — blast radius contained to the
 * site that leaked.
 *
 * The cost is real and is not pretended away: N sites means N Apps, N keys and N
 * things to rotate. That is affordable only because creating one is cheap, which
 * is most of why this command exists.
 *
 * WHAT THE MANIFEST FLOW BUYS, WHICH IS MORE THAN IT LOOKS
 *
 * `redirect_url` is the point of it. GitHub redirects there with a one-hour code,
 * and `POST /app-manifests/{code}/conversions` exchanges that code for the App's
 * id, client id and **the private key itself**. So `create` runs a one-shot
 * loopback server, captures the key in memory, and hands it straight to a
 * destination the operator named — **the key never touches disk**, and nobody has
 * to find a downloaded `.pem`.
 *
 * MEASURED (2026-09-05, in a sibling project) and it contradicts the
 * documentation: GitHub's REST docs list `redirect_url` as OPTIONAL, and the
 * organisation App-creation form refuses a manifest without it — "Invalid GitHub
 * App configuration ... Error 'redirect_url' wasn't supplied."
 *
 * THIS FILE TALKS TO GITHUB WITH `fetch`, NOT OCTOKIT, DELIBERATELY
 *
 * Two reasons. An App JWT requires `Authorization: Bearer <jwt>`, and a client
 * that sends `token <value>` is answered with `401 A JSON web token could not be
 * decoded` — measured in the sibling project, where it presented as "no
 * installation found" and sent the operator to check a page that was correct.
 * And Octokit here would add `octokit.apps.*` call sites to this package, which
 * the guard in `github-app-permission-drift.test.ts` would then have to carve an
 * exception for — an exception being exactly how a guard goes blind.
 *
 * The JWT is hand-rolled over `node:crypto` for a third reason that is not
 * optional: `.dependency-cruiser.mjs`'s `core-no-github-app-auth` rule scopes to
 * every package's own `src/`, so importing `@octokit/auth-app` here is a lint
 * error, same as anywhere else in this package.
 *
 * THE KEY'S DESTINATION IS NOT THIS TOOL'S BUSINESS
 *
 * `create` takes either a command to pipe the PEM into, or a file to write. It
 * knows nothing about AWS, or any other secret store: an adopter may not deploy
 * to AWS at all, and a setup tool that hardcodes one cloud is a setup tool for
 * one adopter. `docs/deploying-to-aws.md` carries the worked invocation.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createSign, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'

/** Permission levels GitHub uses for App repository permissions, weakest first. */
export const PERMISSION_LEVELS = ['read', 'write', 'admin'] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
export type PermissionSet = Readonly<Record<string, PermissionLevel>>

/**
 * The App's entire security surface, and the derivation behind it.
 *
 * Every entry names the call site that forces it, because a permission whose
 * justification lives only in a commit message cannot be re-checked. Enumerated
 * from the only two modules in this package that issue GitHub calls —
 * `github-service.ts` and `worker/{task-runner,rebase}.ts` — plus every git
 * operation that reaches github.com. `canopycms-cdk` makes no REST calls at all.
 *
 * - `contents: write`
 *     - git over HTTPS: the first-boot bare clone (`worker/cms-worker.ts`), the
 *       per-cycle fetch of all branches (`worker/git-sync.ts`), and the branch
 *       pushes including `--force-with-lease` (`worker/task-runner.ts`).
 *     - `octokit.git.deleteRef` (`github-service.ts`, `worker/task-runner.ts`).
 *       GitHub's permissions reference puts `DELETE /repos/{o}/{r}/git/refs/{ref}`
 *       under Contents/write — NOT `administration`, which is the plausible wrong
 *       guess. It is also dead code today: nothing enqueues `delete-remote-branch`
 *       and `GitHubService.deleteBranch`'s only call site is commented out, so it
 *       forces nothing that pushing does not already force. Declared anyway
 *       because the handler is live the moment a producer appears.
 *
 * - `pull_requests: write`
 *     - `pulls.create` and `pulls.update` (`github-service.ts`,
 *       `worker/task-runner.ts`). GitHub's reference: Create and Update a pull
 *       request are Pull requests/write. `pulls.list` and `pulls.get` are
 *       Pull requests/read, subsumed by this.
 *     - the GraphQL mutations `markPullRequestReadyForReview` and
 *       `convertPullRequestToDraft`. **This is the one entry with no
 *       documentation line behind it** — GitHub's permissions reference
 *       enumerates REST endpoints only — so it is derived by analogy with the
 *       REST PR mutations. A live run is the oracle, and until one has happened
 *       this comment is the honest state of it.
 *
 * - `metadata: read` — implied: GitHub grants it alongside any repository
 *   permission. Declared explicitly so this object states the whole surface
 *   rather than the part that is not automatic.
 *
 * Nothing else. No `issues` (there are no `issues.*` calls — nothing sets labels
 * or assignees, which is the usual reason a PR bot needs it), no `workflows`
 * (nothing writes under `.github/workflows/`), no `administration`, no `actions`,
 * and no organisation permissions.
 */
export const CANOPY_APP_PERMISSIONS: PermissionSet = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
}

/**
 * GitHub's limit on an App's display name.
 *
 * MEASURED 2026-09-06 in a sibling project, by having a 39-character name
 * refused while a 33-character one was accepted; the documentation states no
 * limit at all. So the true bound is somewhere in 33..38 and 34 is the safe
 * direction: a wrongly-refused name costs the operator one `--name` flag, while a
 * wrongly-accepted one costs a browser round trip to find out. Re-measure when a
 * real App is created from this file.
 */
export const APP_NAME_MAX_LENGTH = 34

/**
 * How much of a description the account's App LIST renders before truncating —
 * mid-word, with an ellipsis.
 *
 * MEASURED 2026-09-06 in the same project: a description opening "Read-only,
 * organisation-wide. Lets th…" was cut at 37 characters. The list appears to
 * truncate by CHARACTER rather than by line, so a newline does not rescue a long
 * opening sentence. Hence the shape of `appDescription`: a standalone summary
 * inside this budget, a blank line, then the detail only the App's own page
 * shows.
 */
export const APP_SUMMARY_MAX_LENGTH = 37

/** How long `create` waits for the browser round trip before giving up. */
export const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000

/** How long any single call to api.github.com may take. */
const REQUEST_TIMEOUT_MS = 30_000

/** The repository an App is being registered for. */
export type AppTarget = {
  owner: string
  repo: string
  /** Organisation accounts and user accounts post the manifest to different URLs. */
  isOrganization: boolean
}

/**
 * Where `create` should send the captured private key. Exactly one, chosen by
 * the operator BEFORE the App exists — see `requireDestination`.
 */
export type KeyDestination =
  | { kind: 'command'; argv: string[] }
  | { kind: 'file'; filePath: string }

/**
 * The App's display name, and the slug GitHub derives from it.
 *
 * Named after the REPOSITORY, because the App is per-site (see the file header):
 * an App named after the organisation would suggest it is shared, which is the
 * arrangement this file exists to avoid.
 *
 * GitHub App names are unique across the WHOLE of GitHub, not merely within an
 * account, so a short generic name is plausibly already taken by somebody else.
 * `create` pre-checks what it can and `--name` overrides; see
 * `checkNameAvailable`.
 */
export function appName(repo: string): string {
  return `${repo} CanopyCMS`
}

/**
 * GitHub's slug derivation, as far as this needs it: lowercase, and runs of
 * anything that is not alphanumeric collapse to single hyphens.
 *
 * Pinned by a test. If GitHub ever derives differently the name pre-check goes
 * blind rather than loud, so this is not something to assume.
 */
export function appSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * A short summary that survives the App list's truncation, then the detail.
 *
 * Two audiences, two parts. Deliberately generic in both: this text is stored ON
 * GITHUB rather than here, so anything in it that can go stale goes stale
 * silently, with nothing in this repository able to detect or fix it. It
 * therefore says only what stays true of the App itself — what it does, that it
 * is installed on one repository, and that it is registered per site.
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

/**
 * Where the manifest form posts, which differs by account type.
 *
 * A solo adopter who owns the content repository personally needs the user-level
 * URL; posting an organisation manifest to it (or the reverse) fails at the form.
 */
export function manifestPostUrl(target: AppTarget, state: string): string {
  const base = target.isOrganization
    ? `https://github.com/organizations/${encodeURIComponent(target.owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new'
  // The `state` rides on the ACTION URL, not inside the manifest body: it is a
  // query parameter GitHub echoes back on the redirect, and putting it in the
  // JSON would look implemented while protecting nothing.
  return `${base}?state=${encodeURIComponent(state)}`
}

/**
 * The App as GitHub's manifest flow takes it.
 *
 * `default_permissions` is the entire security surface and lives in
 * `CANOPY_APP_PERMISSIONS`, where each entry carries the call site that forces
 * it. `default_events` is empty and the webhook is inactive: nothing is ever
 * delivered to this App — it is only ever assumed outward by the worker.
 */
export function appManifest(
  target: AppTarget,
  redirectUrl: string,
  name = appName(target.repo),
): Record<string, unknown> {
  return {
    name,
    url: `https://github.com/${target.owner}/${target.repo}`,
    description: appDescription(),
    public: false,
    redirect_url: redirectUrl,
    hook_attributes: { url: 'https://example.invalid/unused', active: false },
    default_events: [],
    default_permissions: { ...CANOPY_APP_PERMISSIONS },
  }
}

/** HTML-escape a value that is about to be interpolated into the creation form. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The auto-submitting form that carries the manifest to GitHub.
 *
 * A manifest can only be delivered as a form POST from a browser, which is why
 * this exists at all. Both interpolations are escaped: the manifest embeds
 * adopter-supplied owner and repository names, and this string is written to a
 * file that a browser then executes.
 */
export function creationForm(target: string, manifest: Record<string, unknown>): string {
  return `<!doctype html><meta charset="utf-8"><title>Create the CanopyCMS App</title>
<body style="font:16px system-ui;padding:3rem" onload="document.forms[0].submit()">
<p>Submitting the App manifest to GitHub…</p>
<form method="post" action="${escapeHtml(target)}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <button type="submit">Create the App</button>
</form>
</body>`
}

/**
 * A short-lived App JWT, signed RS256 with `node:crypto`.
 *
 * `iat` is backdated 60s because GitHub rejects a JWT whose `iat` is in its own
 * future, and a second of clock skew between here and GitHub is entirely
 * ordinary. `exp` leaves headroom rather than sitting on GitHub's stated
 * ten-minute maximum for no benefit.
 */
export function appJwt(
  issuer: string,
  privateKey: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + 420,
    iss: issuer,
  })}`
  const signer = createSign('RSA-SHA256')
  signer.update(body)
  return `${body}.${signer.sign(privateKey).toString('base64url')}`
}

export type GitHubResponse<T> = {
  ok: boolean
  status: number
  body: T | null
  /**
   * On a FAILURE: GitHub's own `message`, or a redacted prefix of the response
   * text. Empty string on success — a success body here is App credentials, and
   * a prefix of one is not worth handing to a caller that might print it.
   */
  message: string
}

/**
 * One call to api.github.com.
 *
 * Returns the status and body rather than collapsing failure to `null`, because
 * the two failures a caller has to tell apart here — "this credential cannot
 * authenticate" and "this App is not installed on that repository" — send an
 * operator to entirely different pages. Collapsing them is measured to have sent
 * a real run's operator to check a page that was correct.
 */
export async function githubRequest<T>(
  apiPath: string,
  init: { method?: string; body?: unknown; token?: string; jwt?: string } = {},
): Promise<GitHubResponse<T>> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'canopycms-init-github-app',
  }
  // Bearer, never `token`. A JWT sent as `token <value>` is answered with
  // "401 A JSON web token could not be decoded".
  if (init.jwt) headers.authorization = `Bearer ${init.jwt}`
  else if (init.token) headers.authorization = `token ${init.token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'

  let response: Response
  let text: string
  try {
    response = await fetch(`https://api.github.com${apiPath}`, {
      method: init.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    // Reading the BODY is inside the try as well, not just the fetch. It is a
    // second chance to reject — a connection reset after the headers, or the
    // timeout above firing mid-read — and a rejection escaping here would
    // propagate out of `create` past the point where the private key is still
    // held. Every failure this function can have is a returned value.
    text = await response.text()
  } catch (err) {
    return { ok: false, status: 0, body: null, message: redactCredentials(getErrorMessage(err)) }
  }

  let body: T | null = null
  try {
    body = text ? (JSON.parse(text) as T) : null
  } catch {
    body = null
  }
  // Computed only for a FAILURE. On success the body is the App's credentials,
  // and a 200-character prefix of it is not something to hand a caller that
  // might print it — `redactCredentials` covers a PEM and a `ghs_` token but
  // would not save a truncated `client_secret`.
  const asRecord = body as { message?: unknown } | null
  const message = response.ok
    ? ''
    : redactCredentials(
        typeof asRecord?.message === 'string' ? asRecord.message : text.slice(0, 200),
      )
  return { ok: response.ok, status: response.status, body, message }
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
 * Compare what an installation actually holds against what this package needs.
 *
 * Pure, so the whole judgement is testable without a live App — which matters,
 * because everything around it can only ever be exercised by hand.
 *
 * Reports in BOTH directions. A credential does not usually fail by being
 * unusable; that gets noticed immediately. It fails by being one permission too
 * wide, which works perfectly and is never noticed. So an extra permission, or
 * an installation scoped to every repository in the account, is an error here
 * and not a shrug.
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

  // `undefined` is NOT treated as `selected`. An absent field means "GitHub did
  // not tell us", and reporting an unknown scope as the narrow one would be the
  // check quietly passing itself.
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
    // An exact match is the only pass. A level GitHub adds later is reported
    // rather than ranked against levels this code happens to know, because
    // guessing where an unknown level sits is exactly how a check quietly
    // starts passing things it was written to catch.
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
    // Stronger than required is still wider than intended, and is reported for
    // the same reason an extra permission is: it works perfectly, so nothing
    // else will ever notice it.
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

export type HandOffResult = { stored: boolean; detail: string }

/** Injectable so `handOffKey` is testable without spawning anything real. */
export type SpawnFn = (command: string, args: string[]) => ChildProcess

/**
 * Send the captured private key to the destination the operator named.
 *
 * For a command: `shell: false`, so the operator's argv is passed through
 * verbatim and there is no shell to inject into. The PEM goes over **stdin**,
 * never argv — an argument is visible in `ps` and lands in shell history. The
 * child's stdout and stderr are INHERITED rather than captured, and that is
 * load-bearing rather than lazy: `aws secretsmanager create-secret` prints the
 * ARN, and CDK's `Secret.fromSecretCompleteArn` needs the full ARN including its
 * six-character suffix. Swallowing the child's output would leave the operator
 * holding a stored secret with no way to learn the one string that wires it up.
 *
 * The `'error'` listener on `child.stdin` is not optional. A child that exits or
 * closes stdin early makes the write fail with EPIPE, and an unhandled error on
 * a stream takes the process down — carrying with it the only copy of a private
 * key for an App that already exists.
 *
 * WHAT `stored: true` DOES AND DOES NOT MEAN. It means the command exited zero
 * and nothing went wrong writing to it. It does NOT mean the command read the
 * key, and it cannot: **a PEM is around 1.7KB and a pipe buffer is 64KB, so the
 * write completes into the kernel buffer whether or not the child ever reads
 * it.** MEASURED against real children — `sh -c 'exec 0<&-; exit 0'` (closes its
 * input and exits) and `sh -c 'head -c 5 >/dev/null; exit 0'` (reads five bytes)
 * both report stored, and no EPIPE is generated in either case because the write
 * never had to block. There is no local signal that distinguishes them from a
 * command that stored the key properly.
 *
 * So the child's EXIT CODE is the contract, and the operator is responsible for
 * naming a command that fails loudly. That is stated here rather than papered
 * over, because the tempting fix — waiting for the stream to flush — measures
 * the kernel buffer rather than the child, and would look like a check while
 * being one.
 */
export async function handOffKey(
  pem: string,
  destination: KeyDestination,
  spawnFn: SpawnFn = (command, args) =>
    spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] }),
): Promise<HandOffResult> {
  if (destination.kind === 'file') {
    try {
      // `wx` so an existing file is never clobbered: the operator may well be
      // pointing at a directory that already holds a key, and overwriting one
      // credential with another is not a recoverable mistake.
      await writeFile(destination.filePath, pem, { mode: 0o600, flag: 'wx' })
      return { stored: true, detail: `written to ${destination.filePath} (mode 0600)` }
    } catch (err) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        return {
          stored: false,
          detail: `${destination.filePath} already exists — refusing to overwrite it`,
        }
      }
      return { stored: false, detail: redactCredentials(getErrorMessage(err)) }
    }
  }

  const [command, ...args] = destination.argv
  return new Promise<HandOffResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnFn(command, args)
    } catch (err) {
      resolve({ stored: false, detail: `could not run \`${command}\`: ${getErrorMessage(err)}` })
      return
    }

    let settled = false
    const settle = (result: HandOffResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    // Recorded rather than settled on, so the child's EXIT CODE stays the
    // authority on whether the key was stored. A child that consumed the key,
    // stored it and exited 0 must not be reported as a failure because its
    // pipe errored on the way down — the operator would generate a new key for
    // nothing. It does veto a zero exit, though: a write that did not complete
    // means the child cannot have received the whole PEM, whatever it claims.
    let writeError: Error | undefined

    child.on('error', (err) => {
      // A spawn failure, where no 'close' need follow — so this one settles.
      settle({ stored: false, detail: `could not run \`${command}\`: ${getErrorMessage(err)}` })
    })
    child.on('close', (code) => {
      // Deferred one turn of the event loop so a stdin error that is already
      // pending is recorded BEFORE the verdict is taken. A broken pipe and the
      // child's exit are two independent events and `close` can win the race,
      // which would report a key as stored on the strength of an exit code
      // while the write that carried it had failed.
      setImmediate(() => {
        if (writeError) {
          settle({
            stored: false,
            detail:
              `\`${command}\` exited ${code ?? 'by signal'}, but the key could not be written ` +
              `to its input (${getErrorMessage(writeError)})`,
          })
          return
        }
        if (code === 0) {
          settle({ stored: true, detail: `\`${command}\` accepted the key and exited 0` })
          return
        }
        settle({ stored: false, detail: `\`${command}\` exited ${code ?? 'by signal'}` })
      })
    })

    const stdin = child.stdin
    if (!stdin) {
      settle({ stored: false, detail: `\`${command}\` has no stdin to write the key to` })
      return
    }
    // This listener is not optional. Without it an EPIPE from an early-closing
    // child is an unhandled stream error, which takes the process down — and
    // with it the only copy of a private key for an App that already exists.
    stdin.on('error', (err) => {
      writeError = err
    })
    stdin.end(pem)
  })
}

export type CallbackServer = {
  port: number
  code: Promise<string>
  close: () => void
}

/**
 * One request, then closed — closed by the handler itself, as soon as it has the
 * code. Bound to loopback only.
 *
 * The standard CLI pattern (`gh auth login` does the same): it exists solely so
 * the private key can arrive over the redirect rather than through a downloads
 * folder.
 *
 * A REJECTED REQUEST IS ANSWERED AND IGNORED, never fatal. The `state` check is
 * the CSRF guard the manifest flow provides, but rejecting the promise on a
 * mismatch ends the run on the first stray loopback request — a browser
 * prefetch, an extension, a retried tab — possibly seconds before GitHub's real
 * redirect arrives, and AFTER the App has been created. Aborting there leaves an
 * App nobody holds a key for, over a request that was never GitHub's.
 */
export function startCallbackServer(
  state: string,
  timeoutMs = CALLBACK_TIMEOUT_MS,
  // Injectable ONLY so the bind-failure path is testable. The host stays
  // hardcoded to 127.0.0.1 below, so this seam cannot be used to bind
  // somewhere reachable.
  createServerFn: typeof createServer = createServer,
): Promise<CallbackServer> {
  let settle: (value: string) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const code = new Promise<string>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // Marks `code` as handled without consuming it: `.catch()` returns a NEW
  // promise and leaves this one rejectable for the real caller. Needed because
  // the bind below can fail before anyone has awaited `code`, and an
  // unhandled rejection there would be reported as a crash in a flow whose
  // actual problem is "the port could not be bound".
  code.catch(() => {})

  const page = (title: string, detail: string) =>
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:16px system-ui;padding:3rem"><h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(detail)}</p></body>`

  // Set once the code has been captured, so `stopListening` is reachable from
  // inside the handler before the caller's `close()` runs.
  let stopListening = () => {}

  const server = createServerFn((req, res) => {
    // EVERY path through this handler is inside the try. A throw in a
    // 'request' listener is an uncaught exception that kills the process, and
    // by the time this server matters the process is the only thing holding a
    // private key for an App that already exists.
    //
    // `new URL` is the specific hazard, and it is not hypothetical: Node's HTTP
    // parser accepts request targets `new URL` rejects, so `GET //[x HTTP/1.1`
    // arrives as `req.url === '//[x'` and throws ERR_INVALID_URL. Verified
    // directly — `//` alone throws too.
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      if (url.searchParams.get('state') !== state) {
        res
          .writeHead(400, { 'content-type': 'text/html' })
          .end(page('Not this flow', 'Ignoring this request; still waiting.'))
        return
      }
      const received = url.searchParams.get('code')
      if (!received) {
        res
          .writeHead(400, { 'content-type': 'text/html' })
          .end(page('No code', 'Ignoring this request; still waiting.'))
        return
      }
      res
        // `connection: close` so the browser's keep-alive socket does not hold
        // the listener open after the one request it exists for.
        .writeHead(200, { 'content-type': 'text/html', connection: 'close' })
        .end(page('App created', 'The private key was captured. Return to the terminal.'))
      settle(received)
      // Closed HERE, not in the caller's `finally`. The caller's window spans
      // the conversion, a human install step of unbounded length and the
      // readback, and for all of that the port would keep accepting
      // connections — loopback is not per-user, so on a shared host another
      // UID can reach it.
      stopListening()
    } catch {
      // A malformed request is not this flow's business. Answer it and keep
      // waiting, exactly as a bad `state` is treated.
      try {
        res.writeHead(400).end()
      } catch {
        // The socket is already gone; nothing to answer.
      }
    }
  })

  return new Promise<CallbackServer>((resolve, reject) => {
    let listening = false
    // Without this the bind failing is an unhandled 'error' event — which takes
    // the process down — and the promise below never settles either way, so
    // `create` hangs instead of saying the port could not be bound. Both were
    // measured: a sandbox that denies listen() produced exactly that.
    server.on('error', (err) => {
      if (listening) {
        fail(err)
        return
      }
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      listening = true
      const timer = setTimeout(
        () => fail(new Error('timed out waiting for the GitHub redirect')),
        timeoutMs,
      )
      timer.unref()
      // Idempotent: the handler calls it on success and the caller calls it
      // again from its `finally`, which must be harmless.
      stopListening = () => {
        clearTimeout(timer)
        server.close()
      }
      resolve({
        port: (server.address() as AddressInfo).port,
        code,
        close: () => stopListening(),
      })
    })
  })
}

type CreatedApp = { id: number; slug: string; clientId: string; pem: string }

/**
 * The exchange. Unauthenticated by design: the one-hour code IS the credential.
 *
 * Only the four fields this tool needs are lifted out. The response also carries
 * `client_secret` and `webhook_secret`, which this App never uses — so the body
 * is never logged, never returned whole, and never reaches an error message.
 * Failures here report the HTTP status and nothing else, for the same reason:
 * the code itself is exchangeable for the private key for a full hour.
 */
export async function convertManifest(code: string): Promise<CreatedApp | null> {
  const response = await githubRequest<{
    id?: number
    slug?: string
    client_id?: string
    pem?: string
  }>(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' })
  if (!response.ok || !response.body) return null
  const { id, slug, client_id: clientId, pem } = response.body
  if (typeof id !== 'number' || !slug || !clientId || !pem) return null
  return { id, slug, clientId, pem }
}

/**
 * Whether the account is an organisation, which decides where the manifest posts.
 *
 * Unauthenticated, so it needs no credential at a point in the flow where we have
 * none. `null` means "could not tell" and the caller says so rather than
 * guessing — guessing wrong sends the operator to a form that refuses the
 * manifest with no useful explanation.
 */
export async function detectAccountType(owner: string): Promise<boolean | null> {
  const response = await githubRequest<{ type?: string }>(`/users/${encodeURIComponent(owner)}`)
  if (!response.ok || !response.body?.type) return null
  return response.body.type === 'Organization'
}

/**
 * Best-effort check that the App name is not already taken.
 *
 * `true` = available as far as we can tell, `false` = definitely taken, `null` =
 * could not check. The three are kept apart deliberately: a PRIVATE App with
 * this slug also answers 404, so a 404 is not proof of availability, and
 * reporting "could not check" as "checked, it is free" is how a guard goes
 * blind. This exists because name collisions can otherwise only be discovered by
 * the creation form — with the CLI already sitting on a loopback server waiting
 * for a redirect that will never arrive.
 */
export async function checkNameAvailable(slug: string): Promise<boolean | null> {
  const response = await githubRequest<unknown>(`/apps/${encodeURIComponent(slug)}`)
  if (response.status === 200) return false
  if (response.status === 404) return true
  return null
}

function pressEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false })
  return new Promise((resolve) => {
    console.log(prompt)
    rl.once('line', () => {
      rl.close()
      resolve()
    })
    rl.once('close', () => resolve())
  })
}

/** Read one line from the operator. `null` when stdin closed instead. */
function askLine(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, terminal: false })
  return new Promise((resolve) => {
    console.log(prompt)
    let answered = false
    rl.once('line', (line) => {
      answered = true
      rl.close()
      resolve(line.trim())
    })
    rl.once('close', () => {
      if (!answered) resolve(null)
    })
  })
}

/**
 * Hand the key over, and keep asking while the operator still has a chance.
 *
 * The pre-flight can only refuse a MISSING destination — it cannot know whether
 * a command exists, whether a path is writable, or whether a secret store will
 * accept the call. Measured: `--key-out` at a directory, `--key-out` under a
 * parent that does not exist, and a command not on PATH all pass the pre-flight
 * and fail here. Exiting at that point destroys the only copy of a private key
 * for an App that already exists, over a typo.
 *
 * So a failure asks for somewhere else instead, while the key is still in
 * memory. `create` already requires a TTY, so there is someone there to answer.
 * A blank line (or a closed stdin) gives up deliberately and says what that
 * costs.
 */
async function handOffWithRetry(pem: string, destination: KeyDestination): Promise<boolean> {
  let attempt = destination
  for (;;) {
    const result = await handOffKey(pem, attempt)
    if (result.stored) {
      console.log(`\n  private key: ${result.detail}`)
      return true
    }

    console.error(
      `\n  THE PRIVATE KEY WAS NOT STORED: ${result.detail}\n\n` +
        '  The App exists and this process holds the only copy of its key, which is gone when\n' +
        '  this command exits. You can send it somewhere else right now.',
    )
    const answer = await askLine(
      '\n  Enter a path to write it to (mode 0600), or a command to pipe it into\n' +
        '  (e.g. `aws secretsmanager create-secret --name canopycms/github-app-key\n' +
        '  --secret-string file:///dev/stdin`). Leave blank to give up:',
    )
    if (!answer) {
      console.error(
        '\n  Giving up on storing the key. The App still exists — generate a fresh private key\n' +
          '  from its "Private keys" section, or delete the App and run `create` again.',
      )
      return false
    }
    // A bare path is a file; anything with arguments is a command. Split on
    // whitespace rather than through a shell: there is no shell here, so
    // nothing to inject into, and an operator who needs shell syntax can run
    // the command themselves against a file destination.
    const words = answer.split(/\s+/).filter(Boolean)
    attempt =
      words.length === 1 && !words[0].includes('=')
        ? { kind: 'file', filePath: words[0] }
        : { kind: 'command', argv: words }
  }
}

function describeDestination(destination: KeyDestination): string {
  return destination.kind === 'file'
    ? `the file ${destination.filePath}`
    : `\`${destination.argv.join(' ')}\``
}

/**
 * How many accounts this App is installed on, or `null` when it cannot be read.
 *
 * The one-App-per-site rule (see the file header) is only worth stating if
 * something checks it, and `repository_selection: 'selected'` does not: it is
 * equally true of an installation scoped to this repository and one scoped to
 * this repository plus nine others. This is the check that actually observes
 * the invariant, and it costs one call with the JWT already in hand.
 *
 * `null` and a number are kept apart: "could not read the installation list" must
 * never be reported as "checked, there is exactly one".
 */
async function installationCount(jwt: string): Promise<number | null> {
  const listed = await githubRequest<{ id: number }[]>('/app/installations?per_page=100', { jwt })
  if (!listed.ok || !Array.isArray(listed.body)) return null
  return listed.body.length
}

/**
 * Mint an installation token narrowed to this repository and the declared
 * permissions, then revoke it.
 *
 * This is NOT a second reading of the grant — `readbackVerdict` already has that
 * from the installation object. It is the end-to-end proof that the key signs,
 * that the App is not suspended, and that a token can actually be issued: the
 * same thing the worker does at boot. It also catches a GitHub behaviour that
 * surfaces nowhere else — **adding a permission to an App does not apply to
 * existing installations until an account owner ACCEPTS the new request**, so an
 * App whose settings page looks correct can hold a stale grant, and the mint
 * fails with a 422 that sounds like the App is misconfigured.
 *
 * The token is revoked immediately. Leaving a live `contents: write` credential
 * valid for an hour after a read-only check exits would be careless for no gain.
 */
async function proveTokenMint(
  jwt: string,
  installationId: number,
  repo: string,
): Promise<{ ok: boolean; detail: string }> {
  const minted = await githubRequest<{ token?: string }>(
    `/app/installations/${installationId}/access_tokens`,
    {
      jwt,
      method: 'POST',
      // Scoped by repository NAME. The access-token endpoint accepts names and
      // applies the same narrowing as ids — and resolving a name to an id would
      // need `GET /repos/{o}/{r}`, which an App JWT cannot reach (measured: it
      // answers a JWT with 401).
      body: { repositories: [repo], permissions: { ...CANOPY_APP_PERMISSIONS } },
    },
  )
  if (!minted.ok || !minted.body?.token) {
    return { ok: false, detail: `HTTP ${minted.status}: ${minted.message}` }
  }
  const revoked = await githubRequest<unknown>('/installation/token', {
    method: 'DELETE',
    token: minted.body.token,
  })
  const note = revoked.status === 204 ? 'revoked' : `NOT revoked (HTTP ${revoked.status})`
  return { ok: true, detail: `minted and ${note}` }
}

/**
 * Read an installation back and report on it. Shared by `create` (right after
 * the operator installs the App) and `verify` (any time afterwards).
 */
async function readBackInstallation(
  appId: string,
  privateKey: string,
  target: AppTarget,
): Promise<{ ok: boolean; installationId: number | null }> {
  let jwt: string
  try {
    jwt = appJwt(appId, privateKey)
  } catch (err) {
    // A PEM that cannot sign fails here, where the key is, rather than later as
    // an opaque 401 from GitHub.
    console.error(
      `\nThe private key could not sign a JWT: ${redactCredentials(getErrorMessage(err))}\n` +
        '  Check that this is the App private key (the downloaded .pem), NOT the "client\n' +
        '  secret" listed a few sections above it on the App\'s settings page — that one is\n' +
        '  for OAuth user flows, is unused by this App, and fails confusingly here.',
    )
    return { ok: false, installationId: null }
  }

  const found = await githubRequest<InstallationSummary>(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/installation`,
    { jwt },
  )
  if (!found.ok || !found.body) {
    // Say WHICH of the two it is. Reporting "not installed" for an auth failure
    // sends the operator to check a page that is correct.
    if (found.status === 401 || found.status === 403) {
      console.error(
        `\nThe App could not AUTHENTICATE (HTTP ${found.status}: ${found.message}).\n` +
          '  This is not about the installation. Either the private key does not belong to this\n' +
          '  App, or the App ID is wrong.',
      )
    } else {
      console.error(
        `\nNo installation of this App found on ${target.owner}/${target.repo} ` +
          `(HTTP ${found.status}).\n` +
          '  The App exists but is not installed on this repository, or was installed on a\n' +
          '  different one.',
      )
    }
    return { ok: false, installationId: null }
  }

  const installation = found.body
  console.log(`\n  installation ${installation.id} on ${target.owner}/${target.repo}`)

  const findings = readbackVerdict(installation)
  if (findings.length === 0) {
    console.log('  grant matches exactly what this package needs:')
    for (const [name, level] of Object.entries(CANOPY_APP_PERMISSIONS)) {
      console.log(`    ✓ ${name}: ${level}`)
    }
  } else {
    for (const finding of findings) {
      console.error(`    ✗ ${finding.message}`)
    }
  }

  // The one-App-per-site invariant, observed rather than asserted. A second
  // installation means this App's key reaches a second account's repositories,
  // which is the arrangement the whole design exists to avoid.
  let extraInstallations = false
  const installations = await installationCount(jwt)
  if (installations === null) {
    console.log('    - could not list this App\'s installations, so "installed once" is unchecked')
  } else if (installations > 1) {
    extraInstallations = true
    console.error(
      `    ✗ this App is installed ${installations} times, and should be installed ONCE.\n` +
        '      Its private key is App-level: whoever holds it can mint a token for any of\n' +
        '      those installations. Register a separate App per site instead, and remove\n' +
        '      the installations that do not belong to this one.',
    )
  } else {
    console.log('    ✓ installed once, so this key reaches no other account')
  }

  const mint = await proveTokenMint(jwt, installation.id, target.repo)
  if (mint.ok) {
    console.log(`    ✓ installation token ${mint.detail}`)
  } else {
    console.error(
      `    ✗ could not mint an installation token — ${mint.detail}\n` +
        '      If that message says the requested permissions are not granted to this\n' +
        '      installation, that is a GitHub behaviour rather than a bug here: adding a\n' +
        '      permission to an App does NOT apply to existing installations until an account\n' +
        "      owner accepts the new request. Approve it under the account's installation\n" +
        '      settings and run `canopycms init-github-app verify` again.',
    )
  }

  return {
    ok: findings.length === 0 && mint.ok && !extraInstallations,
    installationId: installation.id,
  }
}

export type InitGitHubAppOptions = {
  mode: 'create' | 'verify'
  projectDir: string
  owner?: string
  repo?: string
  name?: string
  appId?: string
  destination?: KeyDestination
  /** PEM for `verify`, already read from `--key-file` or stdin by the caller. */
  privateKey?: string
}

async function resolveTarget(options: InitGitHubAppOptions): Promise<AppTarget | null> {
  let owner = options.owner
  let repo = options.repo
  if (!owner || !repo) {
    const { detectGitHubRepo } = await import('./project-detect')
    const detected = await detectGitHubRepo(options.projectDir)
    owner = owner ?? detected?.owner
    repo = repo ?? detected?.repo
  }
  if (!owner || !repo) {
    console.error(
      'Could not work out which GitHub repository this is for.\n\n' +
        '  Detection reads the `origin` remote and only understands github.com URLs, so it\n' +
        '  finds nothing when there is no remote, no git, or a GitHub Enterprise Server host\n' +
        '  (which this command does not support — it talks to api.github.com).\n\n' +
        '  Pass them explicitly:  --owner <account> --repo <repository>',
    )
    return null
  }

  const isOrganization = await detectAccountType(owner)
  if (isOrganization === null) {
    console.error(
      `Could not look up the account "${owner}" on GitHub, so this cannot tell whether the\n` +
        '  App should be created under an organisation or a user account — and those post to\n' +
        '  different URLs. Check the name and your network, then try again.',
    )
    return null
  }
  return { owner, repo, isOrganization }
}

/** The whole creation round trip. */
async function createCommand(options: InitGitHubAppOptions): Promise<number> {
  const destination = options.destination
  if (!destination) {
    console.error(
      'Say where the private key should go. One of:\n\n' +
        '  -- <command> [args…]   pipe the key into a command on its stdin; the key never\n' +
        "                         touches disk. The command's own output is shown, which is\n" +
        '                         how you learn (for example) the ARN of a stored secret.\n' +
        '  --key-out <path>       write the key to a new file, mode 0600\n\n' +
        'This is asked BEFORE anything is created, because once the App exists this tool holds\n' +
        'the only copy of its key and has nowhere to put it.',
    )
    return 1
  }

  // Refuse rather than hang. This flow stops twice for a human, and in CI it
  // would block forever at "press Enter" with a live App already created and the
  // only copy of its key about to die with the job.
  if (!process.stdin.isTTY) {
    console.error(
      '`init-github-app create` needs an interactive terminal: it waits while you create the\n' +
        '  App in a browser and then install it. Run it from a terminal, not from CI.\n\n' +
        '  To check an App that already exists, `init-github-app verify` is non-interactive.',
    )
    return 1
  }

  const target = await resolveTarget(options)
  if (!target) return 1

  const name = options.name ?? appName(target.repo)
  if (name.length > APP_NAME_MAX_LENGTH) {
    console.error(
      `The App's display name is ${name.length} characters, and GitHub refuses anything over ` +
        `${APP_NAME_MAX_LENGTH}:\n\n    ${name}\n\n` +
        '  Pass a shorter one with --name. This is checked here so you are told now rather\n' +
        '  than by the creation form after a browser round trip.',
    )
    return 1
  }

  const slug = appSlug(name)
  const available = await checkNameAvailable(slug)
  if (available === false) {
    console.error(
      `A GitHub App with the slug "${slug}" already exists.\n\n` +
        '  App names are unique across the whole of GitHub, not just within your account, so\n' +
        "  this may well be somebody else's. Pass a different one with --name.\n\n" +
        `  If it is YOURS and already installed on ${target.owner}/${target.repo}, do not create a\n` +
        '  second one — run `canopycms init-github-app verify` instead.',
    )
    return 1
  }
  if (available === null) {
    console.log(
      `! Could not check whether the name "${name}" is already taken, so this is unverified.\n`,
    )
  }

  // PRINTED BEFORE THE BROWSER OPENS, not on failure, because the failure mode is
  // asymmetric: if the redirect never arrives -- browser closed, timeout, state
  // mismatch, code expired -- the App HAS been created and we hold no key.
  // Printing the recovery only when that happens would put it in a terminal that
  // may already be gone.
  console.log(
    'IF THIS GOES WRONG AFTER YOU CLICK CREATE, read this first:\n' +
      '  The App will exist and this command will not have its private key. That is\n' +
      '  recoverable. Either:\n' +
      '    - delete the App in its settings and re-run this command, or\n' +
      '    - open the App, scroll to "Private keys", and click "Generate a private key".\n' +
      '      It downloads a .pem and that is the only chance to save it. This is NOT the\n' +
      '      "client secret" listed a few sections above: that is for OAuth user flows, is\n' +
      '      unused by this App, and fails confusingly when used to sign.\n',
  )

  const state = randomUUID()
  let formDir: string | undefined
  let callback: CallbackServer
  try {
    callback = await startCallbackServer(state)
  } catch (err) {
    // Nothing has been created yet, so this is the cheap failure. Said plainly
    // rather than as a raw errno, because a denied bind is usually a sandbox or
    // a host firewall rather than anything about GitHub.
    console.error(
      `Could not open the local callback server: ${getErrorMessage(err)}\n\n` +
        "  This command needs to listen on 127.0.0.1 to receive GitHub's redirect, which is\n" +
        '  how the private key is captured without ever touching disk. A sandbox or host\n' +
        '  policy that forbids listening will stop it here.\n\n' +
        '  Nothing was created.',
    )
    return 1
  }

  try {
    const redirectUrl = `http://127.0.0.1:${callback.port}/callback`
    const manifest = appManifest(target, redirectUrl, name)
    const postUrl = manifestPostUrl(target, state)
    // A private directory rather than a predictable name in a shared one. On
    // Linux `tmpdir()` is `/tmp` for every user and the slug derives from a
    // public repository name, so `create-<slug>.html` is guessable — and
    // `writeFile`'s default `w` follows an existing symlink and truncates its
    // target, while `mode` only applies when it creates the file. The form is
    // not secret (manifest, state, port), but it is what the operator's browser
    // is about to POST to GitHub.
    formDir = await mkdtemp(path.join(tmpdir(), 'canopycms-app-'))
    const formFile = path.join(formDir, `create-${slug}.html`)
    await writeFile(formFile, creationForm(postUrl, manifest), { mode: 0o600, flag: 'wx' })

    console.log(
      `Registering "${name}" for ${target.owner}/${target.repo}.\n\n` +
        'Its permissions, which is the part that matters:\n\n' +
        `${JSON.stringify(CANOPY_APP_PERMISSIONS, null, 2)}\n\n` +
        `The key will go to ${describeDestination(destination)}.\n\n` +
        '1. Open this file in a browser:\n\n' +
        `     ${formFile}\n\n` +
        '   The browser matters, twice over. It must be LOGGED IN TO GITHUB as an owner of\n' +
        `   ${target.owner}, and it must be running on THIS machine — the redirect comes back to\n` +
        `   127.0.0.1:${callback.port}, which only a local browser can reach. An embedded or\n` +
        '   app-internal browser bounces off the GitHub login wall and simply appears to do\n' +
        '   nothing when you click Create.\n\n' +
        '   The page posts the manifest to GitHub, which shows you the App pre-filled with\n' +
        '   exactly those permissions. Review them and click Create.\n\n' +
        `Waiting for GitHub to redirect back (up to ${CALLBACK_TIMEOUT_MS / 60000} minutes)...`,
    )

    let code: string
    try {
      code = await callback.code
    } catch (err) {
      console.error(
        `\n${getErrorMessage(err)}.\n\n` +
          '  The likeliest cause is that the creation form refused the manifest and you are\n' +
          '  still looking at it — most often because the App name is already taken somewhere\n' +
          '  on GitHub. Re-run with a different --name. If instead you clicked Create and it\n' +
          '  appeared to do nothing, the browser is not signed in to GitHub.\n' +
          '  See the recovery note printed above if the App was in fact created.',
      )
      return 1
    }

    console.log('  got the manifest code; exchanging it for the App credentials')
    const created = await convertManifest(code)
    if (!created) {
      console.error(
        '  the exchange failed. The code is valid for one hour; re-run `create` for a new one.\n' +
          '  See the recovery note above — the App itself may well exist.',
      )
      return 1
    }
    console.log(
      `  created App ${created.slug} (id ${created.id}) — private key held in memory, not written to disk`,
    )

    // THE KEY IS HANDED OFF FIRST, before the install prompt and the readback,
    // and the ordering is the whole point.
    //
    // From here until the hand-off returns, this process holds the ONLY copy of
    // a private key for an App that already exists. Everything between the
    // conversion and the hand-off is therefore a window in which losing the
    // process loses the key: the install step waits on a human for an unbounded
    // time (one Ctrl-C and it is gone), and the readback makes two network
    // calls that can reject rather than return — a stalled response body or the
    // request timeout firing mid-read would unwind straight past the hand-off.
    //
    // Nothing in the hand-off depends on the readback, so there is no reason to
    // carry the key across either. Doing it here reduces the window to the
    // conversion call itself.
    const stored = await handOffWithRetry(created.pem, destination)

    console.log(
      `\n2. Install it on ${target.owner}/${target.repo}:\n\n` +
        `     https://github.com/settings/apps/${created.slug}/installations\n\n` +
        '   That page shows an Install button first — the repository picker only appears after\n' +
        '   you click it. Choose "Only select repositories" and pick that one repository.\n',
    )
    await pressEnter('   Press Enter once it is installed.')

    // Wrapped because a rejection here must not be able to change what was
    // already reported about the key. By this point the key is stored (or
    // deliberately not), and a readback failure is only ever advisory.
    let readback: { ok: boolean; installationId: number | null }
    try {
      readback = await readBackInstallation(String(created.id), created.pem, target)
    } catch (err) {
      console.error(
        `\n  the installation could not be read back: ${redactCredentials(getErrorMessage(err))}\n` +
          '  This says nothing about the App or the key — re-run `canopycms init-github-app verify`.',
      )
      readback = { ok: false, installationId: null }
    }

    console.log(
      '\nSet these on your deployment:\n\n' +
        `  GITHUB_APP_ID=${created.id}\n` +
        `  GITHUB_APP_INSTALLATION_ID=${readback.installationId ?? '<run `verify` to read it>'}\n` +
        '  GITHUB_APP_PRIVATE_KEY_SECRET_ARN=<wherever you just put the key>\n\n' +
        '  Both ids are numeric. The App ID is NOT the "Client ID" (`Iv1.…`) shown beside it,\n' +
        '  and the installation id is NOT the App ID — an App installed twice has one App ID\n' +
        '  and two installation ids.\n\n' +
        'Re-check this any time, without creating anything:\n' +
        `  canopycms init-github-app verify --app-id ${created.id} --key-file <path>`,
    )

    return stored && readback.ok ? 0 : 1
  } finally {
    callback.close()
    if (formDir) {
      // Best effort: the operator's browser has long finished with it, and a
      // failure to clean up must not change the command's outcome.
      await rm(formDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Read an existing App's installation back. Changes nothing. */
async function verifyCommand(options: InitGitHubAppOptions): Promise<number> {
  if (!options.appId) {
    console.error("Pass the App ID with --app-id (the numeric id on the App's settings page).")
    return 1
  }
  if (!options.privateKey) {
    console.error(
      'Pass the App private key, with --key-file <path> or --key-stdin (reads the PEM from\n' +
        '  standard input, so it can come straight out of a secret store without touching disk).',
    )
    return 1
  }

  const target = await resolveTarget(options)
  if (!target) return 1

  console.log(`Checking App ${options.appId} against ${target.owner}/${target.repo}`)
  const readback = await readBackInstallation(options.appId, options.privateKey, target)
  if (!readback.ok) {
    console.error('\nThe App is not ready to publish from this repository. See above.')
    return 1
  }
  console.log(
    '\nAll checks passed. Nothing was changed.\n\n' +
      `  GITHUB_APP_ID=${options.appId}\n` +
      `  GITHUB_APP_INSTALLATION_ID=${readback.installationId}`,
  )
  return 0
}

export async function initGitHubApp(options: InitGitHubAppOptions): Promise<number> {
  return options.mode === 'create' ? createCommand(options) : verifyCommand(options)
}
