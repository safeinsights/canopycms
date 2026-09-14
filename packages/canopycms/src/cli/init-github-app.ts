/**
 * `canopycms init-github-app <create|verify>` — registers the GitHub App the
 * CMS worker authenticates as, and reads its grant back. A PAT's scope is
 * unauditable — checkboxes somebody ticked, nowhere recorded.
 * `CANOPY_APP_PERMISSIONS` in github-app-manifest.ts is the machine-checkable statement of what
 * this App needs instead, checked against the call sites that force each
 * entry (see the constant) and what an installation holds (see `verify`). A
 * missing permission fails silently — a GraphQL denial answers HTTP 200 with
 * no numeric status — so `verify` exists to catch that at setup time.
 * One App per site, never shared across an organisation: a GitHub App's
 * private key is App-level — GitHub does not enforce per-installation
 * scoping against the key-holder — so anyone holding it can mint a token for
 * every installation. Each site's worker reads its own key from its own
 * secret store, so sharing one App would let one leaked store reach every
 * other site's repository.
 * `create` runs a one-shot loopback server, exchanges GitHub's redirect code
 * for the App's credentials including the private key, then hands it to the
 * destination the operator named — over a command's stdin so it never
 * touches disk, or to a file with `--key-out`. That destination is not this
 * tool's business: it knows nothing about AWS or any other secret store.
 * This file talks to GitHub with `fetch`, not Octokit: an App JWT needs
 * `Authorization: Bearer <jwt>` (sent as `token <value>` it gets a misleading
 * 401), and `.dependency-cruiser.mjs` forbids importing `@octokit/auth-app`
 * from this package's `src/` anyway.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createSign, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { normalizeGitHubAppPrivateKey } from '../worker/github-auth'
import {
  APP_NAME_MAX_LENGTH,
  CANOPY_APP_PERMISSIONS,
  appDescription,
  appName,
  appSlug,
  readbackVerdict,
  type InstallationSummary,
} from './github-app-manifest'
import { askLine, pressEnter } from './prompt'

/** How long `create` waits for the browser round trip before giving up. */
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000

/** How long any single call to api.github.com may take. */
const REQUEST_TIMEOUT_MS = 30_000

/** The repository an App is being registered for. */
export type AppTarget = {
  owner: string
  repo: string
  /** Organisation accounts and user accounts post the manifest to different URLs. */
  isOrganization: boolean
}

/** Where `create` should send the captured private key, chosen by the operator BEFORE the App exists. */
export type KeyDestination =
  | { kind: 'command'; argv: string[] }
  | { kind: 'file'; filePath: string }

/**
 * Where the manifest form posts: user-owned and organisation repositories use
 * different URLs, and posting the wrong one fails at the form.
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
 * The App as GitHub's manifest flow takes it. `default_permissions` is the
 * entire security surface, defined in `CANOPY_APP_PERMISSIONS`. The webhook is
 * declared but inactive: nothing is ever delivered to this App.
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
 * The auto-submitting form that carries the manifest to GitHub — a manifest
 * can only be delivered as a browser form POST. Both interpolations are
 * escaped: this embeds adopter-supplied names into a file a browser executes.
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
 * A short-lived App JWT, signed RS256 with `node:crypto`. `iat` is backdated
 * 60s because GitHub rejects a JWT whose `iat` is in its own future, and a
 * second of clock skew is ordinary; `exp` leaves headroom rather than sitting
 * on GitHub's stated ten-minute maximum for no benefit.
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
   * On a FAILURE: GitHub's `message`, a redacted response prefix, or (status
   * 0: the request/body read never completed) the redacted client error.
   * Empty on success — a success body here is App credentials, not for print.
   */
  message: string
}

/**
 * One call to api.github.com. Returns the status and body rather than
 * collapsing failure to `null`: "cannot authenticate" and "not installed"
 * send an operator to different pages, and collapsing them has sent an
 * operator to check a page that was correct.
 */
async function githubRequest<T>(
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
    // Reading the BODY is inside the try too, not just the fetch: a connection
    // reset or the timeout above can still reject here, and letting that escape
    // would propagate past the point in `create` where the key is still held.
    // Every failure this function can have is a returned value, not a throw.
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
  // Computed only for a FAILURE: on success the body is App credentials, not
  // something to hand a caller that might print it. `redactCredentials` covers
  // a PEM and a `ghs_` token but would not save a truncated `client_secret`.
  const asRecord = body as { message?: unknown } | null
  const message = response.ok
    ? ''
    : redactCredentials(
        typeof asRecord?.message === 'string' ? asRecord.message : text.slice(0, 200),
      )
  return { ok: response.ok, status: response.status, body, message }
}

export type HandOffResult = { stored: boolean; detail: string }

/**
 * Injectable so `handOffKey` is testable without spawning anything real. Everywhere but Windows
 * the child carries the bridge's status channel at `stdio[3]`, without which nothing is stored.
 */
export type SpawnFn = (command: string, args: string[]) => ChildProcess

/** Whether a destination command is fed through `KEY_INPUT_BRIDGE`: everywhere but Windows. */
const BRIDGE_KEY_INPUT = process.platform !== 'win32'

/**
 * The script `/bin/sh` runs to give a destination command the key on a REAL
 * pipe. Node's `stdio: 'pipe'` is a SOCKET pair on Unix, not a real pipe:
 * `cat` reads it like anything else and writes into a real one. On Linux a
 * socket can't even be opened as `/dev/stdin`, which would break
 * `--secret-string file:///dev/stdin`. No shell parses the operator's argv:
 * `sh -c SCRIPT sh <argv…>` makes argv the positional parameters, and `"$@"`
 * hands them on quoted with no word-splitting or globbing. It is
 * `exec env -- "$@"` rather than a bare `"$@"` so the first word is always
 * looked up on PATH, not interpreted as a shell built-in.
 *
 * A pipeline's exit status is its LAST command's, so `cat | cmd` alone would
 * hide `cat` dying of SIGPIPE if `cmd` closed its input early, and `set -o
 * pipefail` isn't available in every `/bin/sh` (`/bin/dash`, `/bin/sh` on
 * Debian/Ubuntu, rejects it). So the left side writes `cat`'s own status to
 * fd 3, a channel `handOffKey` requires to read `0`; `3>&-` closes fd 3 in
 * the destination so nothing it leaves running can hold that channel open.
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
 * The detail for a destination command that exited non-zero. Through the
 * bridge, `env` reports "not found" as 127 and "not executable" as 126 — but
 * a command may exit either code on its own, so this states how it's reported.
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
 * Send the captured private key to the destination the operator named. For a
 * command, the PEM goes over **stdin**, never argv — an argument is visible
 * in `ps` and lands in shell history (see `KEY_INPUT_BRIDGE` for how `sh`
 * runs it without parsing that argv itself). Stdout/stderr are INHERITED,
 * not captured: `aws secretsmanager create-secret` prints the ARN the
 * operator needs, which this function must not swallow. The `'error'`
 * listener on `child.stdin` is not optional: a child that exits or closes
 * stdin early can fail the write with EPIPE, an unhandled stream error that
 * would take the process — and the key — down with it.
 * Everywhere but Windows, `stored: true` means the command exited 0, `cat`
 * exited 0, and nothing went wrong writing — every byte reached the pipe. It
 * does NOT prove the command read them: a write lands in the kernel buffer,
 * and a key this size fits in one write, so a command that exits without
 * reading races `cat`'s write and can win or lose silently. What IS caught is
 * a command leaving more unread than the buffer holds, which fails loudly as
 * `cat` exiting on SIGPIPE — so the exit code is still the contract, and
 * naming a command that fails loudly is the operator's job.
 */
export async function handOffKey(
  pem: string,
  destination: KeyDestination,
  spawnFn: SpawnFn = spawnKeyDestination,
): Promise<HandOffResult> {
  if (destination.kind === 'file') {
    try {
      // `wx` so an existing file is never clobbered: overwriting one credential
      // with another, at a path that may already hold a key, is not recoverable.
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
  // Refused before spawning: `env` reads a leading word containing `=` as a
  // variable assignment, not a command, so `-- FOO=bar` (or a mis-quoted whole
  // command) would print the environment, exit 0, and report the key stored.
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
    // authority: a child that stored the key and exited 0 must not be reported
    // failed because its pipe errored on the way down. It does veto a zero
    // exit, though — an incomplete write means the child cannot have received
    // the whole PEM, whatever it claims.
    let writeError: Error | undefined

    // `cat`'s exit status as the bridge reports it on fd 3 (see
    // `KEY_INPUT_BRIDGE`), read for the verdict on 'close' — by then this
    // channel has closed too, since 'close' waits for every stdio stream after
    // stdin. Left empty (counted as no `0`) if the channel is missing.
    let catStatus = ''
    if (BRIDGE_KEY_INPUT) {
      const channel = child.stdio?.[3]
      if (channel instanceof Readable) {
        channel.setEncoding('utf8')
        channel.on('data', (chunk: string) => {
          catStatus += chunk
        })
        // Not optional, same reason as the stdin listener below: an error
        // cannot fake a status, at worst leaving this short of a `0`.
        channel.on('error', () => {})
      }
    }

    child.on('error', (err) => {
      // A spawn failure, where no 'close' need follow — so this one settles.
      settle({ stored: false, detail: `could not run \`${command}\`: ${getErrorMessage(err)}` })
    })
    child.on('close', (code) => {
      // Deferred one turn of the event loop so a pending stdin error is
      // recorded BEFORE the verdict: a broken pipe and the child's exit are
      // independent events, and `close` can win that race and report success
      // on an exit code whose write actually failed.
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
    // Not optional: without it an EPIPE from an early-closing child is an
    // unhandled stream error that takes the process down, and the key with it.
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
 * One request, then closed by the handler itself, bound to loopback only —
 * the standard CLI pattern (`gh auth login` does the same) so the key
 * arrives over the redirect, not a downloads folder. A rejected request is
 * answered and ignored, never fatal: the `state` check
 * is the CSRF guard the manifest flow provides, but rejecting the promise on
 * a mismatch would end the run on a stray loopback request, possibly before
 * GitHub's real redirect, leaving an App nobody holds a key for.
 */
export function startCallbackServer(
  state: string,
  timeoutMs = CALLBACK_TIMEOUT_MS,
  // Injectable ONLY so the bind-failure path is testable. The host stays
  // hardcoded to 127.0.0.1 below, so this seam cannot bind somewhere reachable.
  createServerFn: typeof createServer = createServer,
): Promise<CallbackServer> {
  let settle: (value: string) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const code = new Promise<string>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // Marks `code` as handled without consuming it: `.catch()` returns a NEW
  // promise, leaving this one rejectable for the real caller. Needed because
  // the bind below can fail before anyone has awaited `code`, which would
  // otherwise report as an unhandled rejection instead of a bind failure.
  code.catch(() => {})

  const page = (title: string, detail: string) =>
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:16px system-ui;padding:3rem"><h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(detail)}</p></body>`

  // Assigned once listening, and CALLED by the handler once it has the code, so
  // the listener closes itself rather than waiting on the caller's `finally`.
  let stopListening = () => {}

  const server = createServerFn((req, res) => {
    // EVERY path through this handler is inside the try, since a throw in a
    // 'request' listener would kill the process while it holds the App's
    // private key — including `new URL`, which rejects some request targets
    // Node's HTTP parser accepts (e.g. `GET //[x HTTP/1.1`).
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
      // Closed HERE, not in the caller's `finally`: that window spans a human
      // install step of unbounded length, during which loopback — not
      // per-user — would keep accepting connections another UID could reach.
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
    // Without this, a bind failure is an unhandled 'error' event that crashes
    // the process, and the promise below never settles — `create` would hang
    // instead of reporting that the port could not be bound.
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
 * The exchange. Unauthenticated by design: the one-hour code IS the
 * credential. Only the four fields this tool needs are lifted out — the
 * response also carries `client_secret`/`webhook_secret`, never logged or
 * surfaced. Failures collapse to `null` for the same reason: the code itself
 * is exchangeable for the private key for a full hour.
 */
async function convertManifest(code: string): Promise<CreatedApp | null> {
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
 * Whether the account is an organisation, which decides where the manifest
 * posts. Unauthenticated, since nothing has a credential yet. `null` means
 * "could not tell", and the caller says so rather than guessing — a wrong
 * guess sends the operator to a form that refuses the manifest silently.
 */
async function detectAccountType(owner: string): Promise<boolean | null> {
  const response = await githubRequest<{ type?: string }>(`/users/${encodeURIComponent(owner)}`)
  if (!response.ok || !response.body?.type) return null
  return response.body.type === 'Organization'
}

/**
 * Best-effort check that the App name is not already taken. `true`/`false`/
 * `null` (could not check) are kept apart: a PRIVATE App with this slug also
 * answers 404, so 404 isn't proof of availability, and reporting "could not
 * check" as "free" is how a guard goes blind. Exists because a name collision
 * would otherwise surface only at the creation form, with the CLI already on
 * a loopback server waiting for a redirect that will never arrive.
 */
async function checkNameAvailable(slug: string): Promise<boolean | null> {
  const response = await githubRequest<unknown>(`/apps/${encodeURIComponent(slug)}`)
  if (response.status === 200) return false
  if (response.status === 404) return true
  return null
}

/**
 * What to do with one answer to the retry prompt: write to a file, ask again,
 * or stop. No command here — see `parseKeyRetryAnswer`. `reprompt` carries
 * WHY, so `handOffWithRetry` can tell the operator what was wrong instead of
 * silently asking again.
 */
export type KeyRetryChoice =
  | { kind: 'give-up' }
  | { kind: 'reprompt'; reason: string }
  | { kind: 'file'; filePath: string }

/**
 * Route one line of operator input at the retry prompt, accepting a FILE
 * PATH and nothing else (exported and pure, so every rule is table-tested
 * directly). The first destination can be a command because the operator's
 * shell parses `-- <command…>` into argv; a typed line has no such parser,
 * and splitting on whitespace sends the key somewhere unintended (a stray
 * `|`, `>`, `;`, `&&` or quote becomes a literal argv word). Accepting only a
 * path closes that class — a command means write, run, then delete. Rules,
 * in order:
 * - `null` (stdin has already ended — see prompt.ts) gives up.
 * - A blank or whitespace-only line MUST NOT give up — a stray Enter pressed
 *   earlier sits buffered and is read back before the operator has seen this
 *   prompt — but the words "give up", case-insensitively and
 *   whitespace-normalised, deliberately do once stdin is live.
 * - Whitespace inside the answer, or a leading `|`, is re-prompted: nothing
 *   tells a command apart from a path containing spaces, so such paths
 *   aren't accepted either.
 * - A leading `~` is re-prompted (unexpanded, `~/key.pem` would name a
 *   directory literally called `~`), as is a single token with no `/` or `\`
 *   (`pbcopy`, any PATH script): as a bare word it would write the key into
 *   the current directory while the operator believes it reached the command.
 * - Anything else is a path: `handOffKey` creates it with mode 0600 and
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
 * The pre-flight can only refuse a MISSING destination — a bad path or a
 * command not on PATH fails only here, and exiting on that would destroy the
 * only copy of a private key for an App that already exists, over a typo. So
 * a failure asks for a file path instead, while the key is still in memory —
 * a path only, never a command, per `parseKeyRetryAnswer`'s rules. Only a
 * closed stdin or "give up" ends the loop without a destination.
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
 * How many accounts this App is installed on, or `null` when it cannot be
 * read — the one-App-per-site rule (see the file header) is only worth
 * stating if something checks it, and `repository_selection: 'selected'`
 * doesn't (equally true scoped here plus nine others). `null` and a number
 * are kept apart: "could not read" must never report as "exactly one".
 */
async function installationCount(jwt: string): Promise<number | null> {
  const listed = await githubRequest<{ id: number }[]>('/app/installations?per_page=100', { jwt })
  if (!listed.ok || !Array.isArray(listed.body)) return null
  return listed.body.length
}

/**
 * Mint an installation token narrowed to this repository and the declared
 * permissions, then revoke it — proof the key signs, the App isn't
 * suspended, and a token issues. Also catches a GitHub quirk found nowhere
 * else: a new permission doesn't apply to existing installations until an
 * owner ACCEPTS it, so a correct-looking App can still fail with a
 * misleading 422. Revoked at once — no reason to leave `contents: write`
 * live for an hour after a read-only check.
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
      // Scoped by repository NAME: the endpoint applies the same narrowing as
      // ids, and resolving a name to an id would need `GET /repos/{o}/{r}`,
      // which an App JWT cannot reach (401).
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

/** Read an installation back and report on it. Shared by `create` (after install) and `verify`. */
async function readBackInstallation(
  appId: string,
  privateKey: string,
  target: AppTarget,
): Promise<{ ok: boolean; installationId: number | null }> {
  // Normalised the same way the worker normalises its own key
  // (`normalizeGitHubAppPrivateKey`, `worker/github-auth.ts`) before it signs:
  // trims it, unescapes a literal `\n`, unwraps a base64-wrapped PEM, and
  // re-exports PKCS#8. `docs/deploying-to-aws.md` has operators pipe that
  // exact secret, however it left Secrets Manager, into `verify --key-stdin`,
  // which would otherwise fail to sign on a key the worker boots on fine.
  // Called here too so `create` re-exports GitHub's PKCS#1 PEM as PKCS#8.
  let normalizedKey: string
  try {
    normalizedKey = normalizeGitHubAppPrivateKey(privateKey)
  } catch (err) {
    // Distinct from the "could not sign a JWT" failure below: this key does not
    // even parse as a PEM once the common manglings are undone. `getErrorMessage`
    // here names a PEM format problem, never key material, but is redacted
    // anyway for consistency with every other error surfaced in this file.
    console.error(
      `\nThe private key could not be normalised: ${redactCredentials(getErrorMessage(err))}\n` +
        '  If you supplied this key, check that it is the App private key (the downloaded\n' +
        '  .pem), NOT the "client secret" listed a few sections above it on the App\'s\n' +
        '  settings page — that one is for OAuth user flows, is unused by this App, and fails\n' +
        '  confusingly here.',
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
        '  If you supplied this key, check that it is the App private key (the downloaded\n' +
        '  .pem), NOT the "client secret" listed a few sections above it on the App\'s\n' +
        '  settings page — that one is for OAuth user flows, is unused by this App, and fails\n' +
        '  confusingly here.',
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
      // THREE cases, not two: `githubRequest` reports a transport failure as
      // status 0 with the cause in `message`, which the else below would
      // otherwise misreport as a confident "not installed".
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

  // The one-App-per-site invariant, observed not asserted: EXACTLY one
  // installation is the pass and everything else fails, including "could not
  // check", matching how `repository_selection` treats `undefined`.
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
        '  Detection reads the `origin` remote and looks for github.com in its URL (and can\n' +
        '  misread one with a port), so it\n' +
        '  finds nothing when there is no remote, no git, or a GitHub Enterprise Server host\n' +
        '  (which this command does not support — it talks to api.github.com).\n\n' +
        '  Pass them explicitly:  --owner <account> --repo <repository>',
    )
    return null
  }

  // Only `create` needs the account type, to pick the manifest form's URL.
  // Making `verify` depend on this unauthenticated (60/hour per IP) lookup
  // would give the read-only, non-interactive command a failure unrelated to
  // the App — it validates the owner far better anyway, via the installation.
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

  // Refuse rather than hang: in CI this would block forever at "press Enter"
  // with a live App already created and its only key about to die with the job.
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

  // PRINTED BEFORE THE BROWSER OPENS, not on failure: if the redirect never
  // arrives, the App HAS still been created with no key held, and printing
  // the recovery only then could target a terminal that is already gone.
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
    // Nothing has been created yet, so this is the cheap failure — said plainly
    // rather than as a raw errno, since a denied bind is usually a sandbox or
    // host firewall, not GitHub.
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
    // A private directory, not a predictable name in a shared one: on Linux
    // `tmpdir()` is `/tmp` for every user and the slug derives from a public
    // repo name, so `create-<slug>.html` is guessable, and `writeFile`'s
    // default `w` follows an existing symlink and truncates its target.
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
    // because until it returns this process holds the ONLY copy of the key
    // while the install step waits on a human indefinitely and the readback
    // makes network calls that can reject instead of return.
    const stored = await handOffWithRetry(created.pem, destination)

    if (!stored) {
      // No point installing an App whose key was just discarded. Say what IS
      // still actionable — the App id, the handle for a replacement key.
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

    // Wrapped so a rejection here cannot change what was already reported about
    // the key: by this point it is stored (or deliberately not), and a
    // readback failure is only ever advisory.
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
        '  standard input, so it can come straight out of a secret store without touching disk).\n' +
        '  An empty path, file or stdin counts as no key.',
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
