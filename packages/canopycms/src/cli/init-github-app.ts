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
 * destination the operator named. Sent to a command's stdin — the recommended
 * route — **the key never touches disk**, and nobody has to find a downloaded
 * `.pem`. `--key-out` deliberately does write it to a file, for an operator with
 * no such command; that is the trade, not an oversight.
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
 * `create` takes either a command to pipe the PEM into (`-- <cmd>`) or a file to
 * write (`--key-out`), and asks for a file path if that first one fails. It
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
import { Readable } from 'node:stream'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { normalizeGitHubAppPrivateKey } from '../worker/github-auth'

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
   * On a FAILURE: GitHub's own `message`, a redacted prefix of the response text,
   * or — when `status` is 0, meaning the request or the body read never completed
   * — the redacted client-side error, since there is no response to quote. Empty
   * string on success: a success body here is App credentials, and a prefix of one
   * is not worth handing to a caller that might print it.
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

/**
 * Injectable so `handOffKey` is testable without spawning anything real.
 *
 * Everywhere but Windows the child must carry the bridge's status channel at
 * `stdio[3]`, as `spawnKeyDestination` does: `handOffKey` reads `cat`'s exit
 * status from it, and without a `0` there nothing is reported as stored.
 */
export type SpawnFn = (command: string, args: string[]) => ChildProcess

/** Whether a destination command is fed through `KEY_INPUT_BRIDGE`: everywhere but Windows. */
const BRIDGE_KEY_INPUT = process.platform !== 'win32'

/**
 * The script `/bin/sh` runs to give a destination command the key on a REAL pipe.
 *
 * WHY A BRIDGE AT ALL. Node's `stdio: 'pipe'` is not a pipe on Unix: libuv
 * gives the child one end of a SOCKET pair. MEASURED on macOS through the
 * previous direct spawn: `sh -c '[ -S /dev/stdin ] && echo SOCKET; [ -p
 * /dev/stdin ] && echo PIPE'` printed SOCKET, and `cp /dev/stdin <out>` printed
 * "/dev/stdin is a socket (not copied)", exited 0, and was reported stored with
 * no file written. On Linux, opening `/dev/stdin` on a socket fails with ENXIO —
 * reasoned, not run — which breaks `--secret-string file:///dev/stdin`. `cat`
 * reads a socket like anything else, and what it writes into is a real pipe.
 *
 * NO SHELL PARSES THE OPERATOR'S ARGV. `sh -c SCRIPT sh <argv…>` makes argv the
 * positional parameters, and `"$@"` hands them on quoted: no word splitting, no
 * globbing. The script itself is this constant. The key travels only on stdin, so
 * nothing `sh`, `env` or `cat` prints about a failure can contain it. It is
 * `exec env -- "$@"` rather than a bare `"$@"` so the first word is always a
 * program looked up on PATH, as the direct spawn did. MEASURED in macOS
 * `/bin/sh` (bash 3.2) and `/bin/dash`: with a bare `exec "$@"`, bash took a
 * first word of `-c` as `exec`'s own option, ran nothing and exited 0; without
 * `exec`, a first word of `eval` would run the rest as shell code. Through
 * `env --`, both shells report `-c`, `eval` and `set` as "No such file or
 * directory", exit 127. `--` goes to `env` because dash's `exec` rejects it
 * ("exec: --: not found").
 *
 * WHY `cat`'S STATUS COMES BACK ON fd 3. A pipeline's exit status is its LAST
 * command's, so `cat | cmd` alone reports only `cmd` — and hides `cat` dying of
 * SIGPIPE because `cmd` closed its input before the whole key was written. The
 * direct spawn could see that case only as a write error on the child's stdin;
 * through the bridge, `sh` itself holds that socket open until it exits, so
 * `cat` is the witness left. `set -o pipefail` would expose it but is not something every
 * `/bin/sh` has: macOS `/bin/dash` rejects it ("set: Illegal option -o
 * pipefail"), and dash is `/bin/sh` on Debian and Ubuntu. So the left side
 * writes `cat`'s own status to fd 3, a channel back to Node, and the verdict in
 * `handOffKey` requires it to read `0`. A status that never arrives is not a
 * `0`. `3>&-` closes fd 3 in the destination — MEASURED closed there in both
 * shells — so nothing it leaves running can hold that channel open, or write a
 * status into it.
 */
const KEY_INPUT_BRIDGE = '{ cat; echo "$?" >&3; } | exec env -- "$@" 3>&-'

function spawnKeyDestination(command: string, args: string[]): ChildProcess {
  // Windows has no /bin/sh to bridge through, so the command is spawned directly there.
  if (!BRIDGE_KEY_INPUT) return spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] })
  return spawn('/bin/sh', ['-c', KEY_INPUT_BRIDGE, 'sh', command, ...args], {
    stdio: ['pipe', 'inherit', 'inherit', 'pipe'],
  })
}

/**
 * The detail for a destination command that exited non-zero. Through the bridge,
 * `env` reports a program it cannot find as 127 and one it cannot execute as 126,
 * where the direct spawn raised ENOENT or EACCES. A command may also exit with
 * either code on its own account, so these say how the code is reported rather
 * than asserting which happened.
 */
function destinationExitDetail(command: string, code: number | null): string {
  if (BRIDGE_KEY_INPUT && code === 127) {
    return (
      `\`${command}\` exited 127, which is how a command that could not be found is ` +
      'reported — check the name, and that it is on PATH'
    )
  }
  if (BRIDGE_KEY_INPUT && code === 126) {
    return (
      `\`${command}\` exited 126, which is how a command that could not be executed is ` +
      'reported — check that it is an executable program'
    )
  }
  return `\`${command}\` exited ${code ?? 'by signal'}`
}

/**
 * Send the captured private key to the destination the operator named.
 *
 * For a command: no shell parses the operator's argv (see `KEY_INPUT_BRIDGE`
 * for how `sh` is used without doing so). The PEM goes over **stdin**, never
 * argv — an argument is visible in `ps` and lands in shell history. The
 * child's stdout and stderr are INHERITED rather than captured, and that is
 * load-bearing rather than lazy: `aws secretsmanager create-secret` prints the
 * ARN, and CDK's `Secret.fromSecretCompleteArn` needs the full ARN including its
 * six-character suffix. Swallowing the child's output would leave the operator
 * holding a stored secret with no way to learn the one string that wires it up.
 *
 * The `'error'` listener on `child.stdin` is not optional. A child that exits or
 * closes stdin early can make the write fail with EPIPE, and an unhandled error
 * on a stream takes the process down — carrying with it the only copy of a
 * private key for an App that already exists.
 *
 * WHAT `stored: true` DOES AND DOES NOT MEAN. Everywhere but Windows it means
 * three things: the command exited 0, the `cat` feeding it exited 0, and nothing
 * went wrong writing to it. `cat` exiting 0 means every byte of the key went into
 * the pipe. It still does NOT prove the command READ them, and cannot: a pipe
 * write lands in the kernel's buffer, and a key this size fits in one write, so a
 * command that exits without reading races `cat`'s write and can lose or win.
 * MEASURED on macOS with a real 1.7KB key, 100 runs each through this function,
 * with the same result before the bridge and after it: `true`, `head -c 10`,
 * `sh -c 'exec 0<&-; exit 0'` and `sh -c 'head -c 5 >/dev/null; exit 0'` were
 * each reported stored 100 times of 100. What IS caught, whatever the timing,
 * is a command that leaves more unread than a pipe buffer holds: ~100KB into
 * `true` was reported not stored 20 times of 20, by `cat` exiting 141 — the
 * same case the direct spawn caught as a write EPIPE.
 *
 * So the command's EXIT CODE is still the contract, and the operator is still
 * responsible for naming a command that fails loudly. That is stated here rather
 * than papered over, because the tempting fix — waiting for the stream to flush
 * — measures the kernel buffer rather than the command, and would look like a
 * check while being one.
 */
export async function handOffKey(
  pem: string,
  destination: KeyDestination,
  spawnFn: SpawnFn = spawnKeyDestination,
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
          detail:
            `${destination.filePath} already exists (as a file or a directory) — refusing ` +
            'to overwrite it',
        }
      }
      return { stored: false, detail: redactCredentials(getErrorMessage(err)) }
    }
  }

  // Refused before anything runs: an empty argv would reach the bridge as a bare
  // `env --`, which prints the environment and exits 0.
  if (destination.argv.length === 0) {
    return { stored: false, detail: 'no command was given to send the key to' }
  }
  // Refused before spawning, for parity with the direct spawn this replaced:
  // `env` reads a leading word containing `=` as a variable assignment, not a
  // command, so `-- FOO=bar` (or a whole command mis-quoted into one word) made
  // it print the environment and exit 0 -- the key reported stored, and gone.
  // A direct spawn of such a word always failed with ENOENT instead.
  if (destination.argv[0].includes('=')) {
    return {
      stored: false,
      detail:
        `\`${destination.argv[0]}\` is not a command: a first word containing \`=\` would be read ` +
        'as an environment variable assignment and nothing would run. To set a variable for the ' +
        'command, set it in your shell before `canopycms` (e.g. `AWS_PROFILE=prod canopycms ' +
        'init-github-app create -- aws …`).',
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

    // `cat`'s exit status as the bridge reports it on fd 3 (see
    // `KEY_INPUT_BRIDGE`). Recorded, like `writeError`, for the verdict on
    // 'close' — by which time this channel has closed too, because a child's
    // 'close' waits for every stdio stream after stdin. Left empty if the
    // channel is missing, which the verdict counts as no `0`.
    let catStatus = ''
    if (BRIDGE_KEY_INPUT) {
      const channel = child.stdio?.[3]
      if (channel instanceof Readable) {
        channel.setEncoding('utf8')
        channel.on('data', (chunk: string) => {
          catStatus += chunk
        })
        // Not optional, for the same reason as the listener on stdin below. An
        // error cannot fake a status: at worst it leaves this short of a `0`.
        channel.on('error', () => {})
      }
    }

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
        if (code !== 0) {
          settle({ stored: false, detail: destinationExitDetail(command, code) })
          return
        }
        const status = catStatus.trim()
        if (BRIDGE_KEY_INPUT && status !== '0') {
          settle({
            stored: false,
            detail:
              status === ''
                ? `\`${command}\` exited 0, but the pipe feeding it the key reported no status, ` +
                  'so nothing shows the key reached it'
                : `\`${command}\` exited 0, but the key did not reach it in full: the \`cat\` ` +
                  `writing it into its input exited ${status}` +
                  (status === '141' ? ' (SIGPIPE — its input was closed first)' : ''),
          })
          return
        }
        settle({ stored: true, detail: `\`${command}\` accepted the key and exited 0` })
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

  // Assigned once the socket is listening, and CALLED by the request handler as
  // soon as it has the code — so the listener closes itself rather than waiting
  // for the caller's `finally`. Declared out here only so both can reach it.
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

/**
 * Whether stdin has already delivered end-of-input to an earlier prompt.
 *
 * `process.stdin` can only end ONCE, and a `readline` interface created after it
 * has ended never emits `'line'` or `'close'` — the stream is already
 * `endEmitted` and the constructor's `resume()` cannot re-deliver it. So a
 * per-prompt interface is a footgun the moment a command has two prompts: the
 * second one waits forever.
 *
 * Measured, on a real pty as well as a pipe: with `--key-out` pointing at a bad
 * path, an operator who answers the retry prompt with Ctrl-D (the other reflex
 * to "leave blank to give up") ended stdin in `askLine`, and the later
 * `pressEnter` never resolved. `createCommand` never returned, so
 * `process.exitCode` was never assigned and node exited **0** — on the one
 * outcome where the App exists and its only key was just discarded — while the
 * `finally` that removes the temp directory never ran and the block printing the
 * App id, the operator's only handle for generating a replacement key, was never
 * reached.
 *
 * A SECOND, subtler way to reach the same hole: EOF landing on a line that DID
 * get answered. Node's readline flushes a pending partial line as a final
 * `'line'` event BEFORE `'close'` when the input ends, so "text then EOF" (a
 * pipe like `printf 'abc'` with no trailing newline, or a TTY operator typing
 * text and pressing Ctrl-D twice) answers the prompt normally — `answered` is
 * true when `'close'` fires. The stream having also ended in that same moment
 * used to go unrecorded, because the `'close'` handler only ever set this flag
 * on the `!answered` branch. The next prompt then created a readline interface
 * on an already-ended stream that never emits, and — with nothing else keeping
 * it alive — the event loop emptied and node exited 0 silently: no "Giving up",
 * no "Stopping here … GITHUB_APP_ID" block, no readback, no `finally`.
 * MEASURED with a scratch driver: `printf 'abc' | node --import tsx <driver>`
 * resolved the first prompt to `"abc"` and left the second prompt printed but
 * never resolved, node exiting 0 with nothing after it.
 *
 * So the flag must be set from whether the STREAM ended, not from whether THIS
 * prompt got an answer — the two are independent. `readableEnded` is checked
 * unconditionally in the `'close'` handler below, before the `answered` branch,
 * so it applies whether or not a line came back. This still tells apart the
 * ordinary case from this one: our OWN `rl.close()` call after a line, by
 * itself, fires `'close'` while stdin usually remains open and `readableEnded`
 * stays false — only an input stream that has actually finished sets it.
 *
 * Every prompt below consults this first. Nothing else may create a readline
 * interface on `process.stdin` in this file.
 */
let stdinEnded = false

function readLineOnce(prompt: string): Promise<string | null> {
  if (stdinEnded) {
    // Already at EOF: answer immediately rather than waiting for input that can
    // never arrive.
    console.log(prompt)
    return Promise.resolve(null)
  }
  const rl = createInterface({ input: process.stdin, terminal: false })
  return new Promise((resolve) => {
    console.log(prompt)
    let answered = false
    rl.once('line', (line) => {
      answered = true
      rl.close()
      resolve(line)
    })
    rl.once('close', () => {
      // Checked FIRST and unconditionally: `'close'` fires both when WE call
      // `rl.close()` after a line (stdin can still be open) and when the
      // stream itself ends — including the case where a final partial line was
      // just flushed as `'line'`, so `answered` is true but the stream is
      // ALSO finished. `readableEnded` is the one signal that distinguishes
      // "we closed the interface" from "the stream is actually done", and by
      // the time readline's own `'close'` fires, the input stream has already
      // finished emitting `'end'` (readline listens for it internally before
      // closing itself), so the flag is reliable here.
      if (process.stdin.readableEnded) {
        stdinEnded = true
      }
      if (answered) return
      stdinEnded = true
      resolve(null)
    })
  })
}

/** Wait for the operator to continue. Returns at once if stdin has ended. */
export async function pressEnter(prompt: string): Promise<void> {
  await readLineOnce(prompt)
}

/** Read one line from the operator. `null` when stdin ended instead. */
export async function askLine(prompt: string): Promise<string | null> {
  const line = await readLineOnce(prompt)
  return line === null ? null : line.trim()
}

/** Reset between tests. Not used by the command itself. */
export function resetStdinStateForTesting(): void {
  stdinEnded = false
}

/**
 * What to do with one answer to the retry prompt: write the key to a file, ask
 * again, or stop asking. There is deliberately no command here — see
 * `parseKeyRetryAnswer`.
 *
 * `reprompt` carries WHY, so `handOffWithRetry` can tell the operator what was
 * wrong with what they typed instead of silently asking again.
 */
export type KeyRetryChoice =
  | { kind: 'give-up' }
  | { kind: 'reprompt'; reason: string }
  | { kind: 'file'; filePath: string }

/**
 * Route one line of operator input at the retry prompt, which accepts a FILE
 * PATH and nothing else. Exported and pure so every rule below is a table test
 * rather than something only reachable by driving a live prompt end to end.
 *
 * WHY NO COMMANDS. The first destination can be a command because the
 * operator's own shell parsed `-- <command…>` into argv. A typed line here has
 * no such parser, and three consecutive review rounds each found splitting it on
 * whitespace sending the key somewhere unintended: a one-word answer written as
 * a file in the working directory; a `|` inside the argv becoming a file name;
 * then `>`, `;`, `&&` and quotes each becoming literal argv words, so
 * `tee key.pem > /dev/null` wrote 0644 copies of the key into the repository
 * root and reported it stored. Each fix closed one spelling. Accepting a path
 * only closes the class: an operator who wants a command writes the file, runs
 * the command against it, and deletes the file.
 *
 * The rules, in order:
 *
 * - `null` (stdin has already ended — see `stdinEnded` above) gives up: there
 *   is nobody left who could answer.
 * - A blank or whitespace-only line MUST NOT give up. Nothing reads stdin
 *   until a readline interface exists, so an Enter pressed during the long
 *   wait for GitHub's redirect — or while the FIRST destination's command was
 *   running — sits in the terminal's line buffer. When that first hand-off
 *   then fails, `askLine` reads the buffered blank line immediately, before
 *   the operator has even seen this prompt. Treating that as "give up"
 *   discarded the only copy of the key without anyone actually answering.
 *   Re-prompting instead costs nothing when the blank line really was
 *   intentional, because the very next prompt still offers "give up" as
 *   something the operator has to type.
 * - The words "give up", case-insensitively and with whitespace normalised, is
 *   the one deliberate way to give up once stdin is live.
 * - Any whitespace inside the answer, or a leading `|`, is re-prompted with
 *   "commands are not accepted here" and the write-run-delete route. Every
 *   command-shaped answer above was spelled with whitespace, and nothing about
 *   a typed line tells a command apart from a path that contains spaces — so
 *   the cost, stated in the reason, is that such a path cannot be entered here.
 * - A leading `~` is re-prompted: nothing here expands it, so `~/key.pem`
 *   would name a directory literally called `~` under the working directory.
 * - A single token with NO `/` or `\` — `pbcopy`, `wl-copy`, any script on
 *   PATH — is re-prompted, suggesting `./<token>`. A "one word is a path" rule
 *   once let `writeFile('pbcopy', pem, { flag: 'wx' })` succeed in
 *   `process.cwd()` — normally the git repository root — leaving a
 *   `contents: write` private key sitting untracked on disk, while the
 *   operator read "written to pbcopy (mode 0600)" and believed it had gone
 *   into the command they meant.
 * - Anything else is a path, which `handOffKey` creates with mode 0600 and
 *   refuses to write if something already exists there.
 */
export function parseKeyRetryAnswer(answer: string | null): KeyRetryChoice {
  if (answer === null) return { kind: 'give-up' }

  const trimmed = answer.trim()
  if (trimmed === '') return { kind: 'reprompt', reason: 'nothing was entered' }

  if (trimmed.toLowerCase().replace(/\s+/g, ' ') === 'give up') {
    return { kind: 'give-up' }
  }

  if (/\s/.test(trimmed) || trimmed.startsWith('|')) {
    return {
      kind: 'reprompt',
      reason:
        'commands are not accepted at this prompt — only a file path. To send the key to a ' +
        'command, write it to a file here, run your own command against that file, then ' +
        'delete the file. (A path containing spaces is not supported here either.)',
    }
  }

  if (trimmed.startsWith('~')) {
    return {
      kind: 'reprompt',
      reason: '`~` is not expanded here. Enter an absolute path, or one starting with ./',
    }
  }

  if (!trimmed.includes('/') && !trimmed.includes('\\')) {
    return {
      kind: 'reprompt',
      reason:
        `"${trimmed}" is not a path, and commands are not accepted here. Enter ./${trimmed} ` +
        'to write the key to a file of that name in the current directory.',
    }
  }

  return { kind: 'file', filePath: trimmed }
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
 * So a failure asks for a file path instead, while the key is still in memory —
 * a path only, never a command, for the reasons on `parseKeyRetryAnswer`.
 * `create` already requires a TTY, so there is someone there to answer. Only a
 * closed stdin (nobody left to answer) or the operator typing "give up" ends the
 * loop without a destination — a blank line re-prompts instead, since that is
 * exactly what a stray Enter pressed before this prompt existed leaves buffered.
 * See `parseKeyRetryAnswer` for the exact rules.
 */
export async function handOffWithRetry(pem: string, destination: KeyDestination): Promise<boolean> {
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

    for (;;) {
      const answer = await askLine(
        '\n  Enter a path to write it to, e.g. `./canopycms-app-key.pem`. The file is created\n' +
          '  with mode 0600, and refused if something already exists there. Type "give up" to\n' +
          '  discard the key.',
      )
      const choice = parseKeyRetryAnswer(answer)
      if (choice.kind === 'reprompt') {
        console.error(`\n  ${choice.reason}`)
        continue
      }
      if (choice.kind === 'give-up') {
        console.error(
          '\n  Giving up on storing the key. The App still exists — generate a fresh private key\n' +
            '  from its "Private keys" section, or delete the App and run `create` again.',
        )
        return false
      }
      attempt = choice
      break
    }
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
  // Normalised the same way the worker normalises its own key
  // (`normalizeGitHubAppPrivateKey`, `worker/github-auth.ts`) BEFORE it is ever
  // used to sign — trims it, unescapes a literal `\n`, unwraps a base64-wrapped
  // PEM, and re-exports PKCS#8. `cli.ts` reads `--key-file`/`--key-stdin`
  // verbatim, and `docs/deploying-to-aws.md` tells operators to pipe that exact
  // secret — `\n`-escaped or base64-wrapped, however it left Secrets Manager —
  // into `verify --key-stdin`. Without this, `verify` failed with "could not
  // sign a JWT" on a key the worker boots on fine. Called here rather than in
  // `cli.ts` so `create` goes through it too: GitHub's own freshly-minted PEM is
  // already normal, so this is a no-op for it.
  let normalizedKey: string
  try {
    normalizedKey = normalizeGitHubAppPrivateKey(privateKey)
  } catch (err) {
    // Distinct from the "could not sign a JWT" failure below: this key does not
    // even parse as a PEM once the common manglings are undone, so signing was
    // never reached. `getErrorMessage` here is `createPrivateKey`'s own parse
    // error, which names a PEM format problem, never key material — redacted
    // anyway, on the same belt-and-braces basis as every other error surfaced
    // in this file.
    console.error(
      `\nThe private key could not be normalised: ${redactCredentials(getErrorMessage(err))}\n` +
        '  Check that this is the App private key (the downloaded .pem), NOT the "client\n' +
        '  secret" listed a few sections above it on the App\'s settings page — that one is\n' +
        '  for OAuth user flows, is unused by this App, and fails confusingly here.',
    )
    return { ok: false, installationId: null }
  }

  let jwt: string
  try {
    jwt = appJwt(appId, normalizedKey)
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
    if (found.status === 0) {
      // THREE cases, not two. `githubRequest` reports a transport failure as
      // status 0 with the real cause in `message`, and folding that into the
      // else below produced a confident "not installed on this repository" for
      // a DNS failure, a proxy refusal or a timeout — with the actual error
      // discarded. Reading the body inside the try made this strictly more
      // reachable, since a reset mid-body now lands here instead of throwing.
      console.error(
        `\nCould not reach api.github.com: ${found.message}\n` +
          '  This says nothing about the App or its installation. Check network access and\n' +
          '  run `canopycms init-github-app verify` again.',
      )
    } else if (found.status === 401 || found.status === 403) {
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
  // EXACTLY one is the pass, and everything else fails — including "could not
  // check". The looser first version printed a ✓ for a count of 0 (a state that
  // should not occur, but a tick for an unobserved fact is the failure these
  // comments exist to prevent) and let `null` leave the overall verdict at
  // "All checks passed", which is a check that did not run reported as one that
  // did. `repository_selection` is strict about `undefined` for the same
  // reason, and these two now agree.
  let installationsOk = false
  const installations = await installationCount(jwt)
  if (installations === null) {
    console.error(
      '    ✗ could not list this App\'s installations, so "installed once" is UNCHECKED.\n' +
        '      Reported as a failure rather than passed over: this is the check that observes\n' +
        '      the one-App-per-site rule, and an unread check is not a satisfied one.',
    )
  } else if (installations === 1) {
    installationsOk = true
    console.log('    ✓ installed once, so this key reaches no other account')
  } else if (installations > 1) {
    console.error(
      `    ✗ this App is installed ${installations} times, and should be installed ONCE.\n` +
        '      Its private key is App-level: whoever holds it can mint a token for any of\n' +
        '      those installations. Register a separate App per site instead, and remove\n' +
        '      the installations that do not belong to this one.',
    )
  } else {
    console.error(
      `    ✗ GitHub reports ${installations} installations of this App, yet one was just read\n` +
        '      back for this repository. Something is inconsistent; re-run before trusting it.',
    )
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
    ok: findings.length === 0 && mint.ok && installationsOk,
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

  // Only `create` needs the account type, and only to choose which URL the
  // manifest form posts to. `verify` never reaches `manifestPostUrl`, so making
  // it depend on an unauthenticated lookup gave the read-only, non-interactive,
  // CI-safe command a way to hard-fail that had nothing to do with the App —
  // unauthenticated requests are rate-limited at 60/hour per IP, which a shared
  // egress address reaches without anyone doing anything wrong. `verify`
  // validates the owner far better anyway, by looking the installation up.
  if (options.mode !== 'create') {
    return { owner, repo, isOrganization: false }
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
        `The key will go to ${describeDestination(destination)} — and if that fails you will\n` +
        `be asked for somewhere else before it is discarded.\n\n` +
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
        '  the exchange failed, so this command never received the private key.\n\n' +
          '  Do NOT simply re-run `create`: it submits a fresh manifest and would register a\n' +
          '  SECOND App. The App you just created almost certainly exists — open it, generate\n' +
          '  a key from its "Private keys" section (see the recovery note above), and then run\n' +
          '  `canopycms init-github-app verify`. Delete the App instead if you would rather\n' +
          '  start over.',
      )
      return 1
    }
    console.log(
      `  created App ${created.slug} (id ${created.id}) — private key captured; sending it to` +
        ` ${describeDestination(destination)}`,
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

    if (!stored) {
      // No point asking anyone to install an App whose key was just discarded:
      // the installation could not be used. Say what IS still actionable — the
      // App id, which is the handle for generating a replacement key — and stop.
      console.error(
        `\nStopping here: the App exists but its key was not stored, so installing it now\n` +
          '  would achieve nothing. To recover, open the App and generate a private key from\n' +
          '  its "Private keys" section, then run `verify`; or delete the App and start again.\n\n' +
          `  GITHUB_APP_ID=${created.id}\n` +
          `  App settings: https://github.com/settings/apps/${created.slug}`,
      )
      return 1
    }

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
