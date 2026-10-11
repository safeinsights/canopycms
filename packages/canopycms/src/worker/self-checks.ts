import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import { getErrorMessage, isNodeError } from '../utils/error'

/**
 * The boot self-checks of the worker process split (.claude/future-tasks/
 * worker-shared-repo-git-process-split.md §5): each proves a sandbox layer the split rests on took
 * effect, because systemd applies some directives silently or not at all (`IPAddressDeny` without
 * cgroup-BPF). Every check fails closed: what it cannot read counts against it. They only report;
 * the entrypoint that runs them decides to stop (D3: they are fatal).
 *
 * Every path is read under `root` (`/` on an instance), so a test can stand in a fake tree.
 */

/** One check's outcome. `detail` names what was seen, never a secret's value. */
export interface SelfCheckResult {
  check: SelfCheckName
  ok: boolean
  detail: string
}

export type SelfCheckName =
  | 'imds'
  | 'network-namespace'
  | 'proc'
  | 'home'
  | 'secrets-in-env'
  | 'efs-unreadable'
  | 'core-pattern'
  | 'core-limit'

/**
 * How a TCP connect ended: it connected, it failed with an errno code, or it timed out.
 * @internal Exported for tests.
 */
export type ConnectOutcome = 'connected' | 'timeout' | { code: string }

export interface SelfCheckEnvironment {
  /** Where `/proc`, `/home` and `/mnt/efs` are read from. Default `/`. */
  root?: string
  /** The process environment the secret check reads. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  /** The uid every visible process must have. Default this process's. */
  uid?: number
  /** Test seam: the TCP connect the IMDS check makes. */
  connect?: (host: string, port: number, timeoutMs: number) => Promise<ConnectOutcome>
}

/** The instance metadata service's IPv4 address; the launch template sets no IPv6 endpoint. */
const IMDS_HOST = '169.254.169.254'

/** How long the IMDS connect may take before it counts as unreachable. */
const IMDS_CONNECT_TIMEOUT_MS = 1_000

/** Connect failures that prove no route: no network, or no IPv4 sockets at all. */
const NO_ROUTE_CODES = new Set(['ENETUNREACH', 'EAFNOSUPPORT'])

/** The variables that hold a secret, or name one (ARNs, JSON fields), and belong to the gateway. */
const SECRET_ENV_PATTERN = /^(?:CANOPYCMS_GITHUB_TOKEN|CANOPYCMS_GITHUB_APP_|CLERK_SECRET_KEY)/

/** The worker unit's checks, in the plan's order. */
export async function workerSelfChecks(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult[]> {
  return [
    await imdsUnreachable(environment),
    await onlyLoopback(environment),
    await procShowsOnlyOwnProcesses(environment),
    await homeIsEmpty(environment),
    noSecretsInEnv(environment),
  ]
}

/** The gateway unit's checks. */
export async function gatewaySelfChecks(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult[]> {
  return [
    await efsUnreadable(environment),
    await corePatternNotPiped(environment),
    await coreLimitZero(environment),
  ]
}

/** Throw one error naming every failed check, or return. */
export function assertSelfChecks(results: readonly SelfCheckResult[]): void {
  const failed = results.filter((result) => !result.ok)
  if (failed.length === 0) return
  throw new Error(
    `Refusing to start: ${failed.map((result) => `${result.check}: ${result.detail}`).join('; ')}`,
  )
}

/**
 * A TCP connect to IMDS fails with no route (`ENETUNREACH`, or `EAFNOSUPPORT` under
 * `RestrictAddressFamilies=AF_UNIX`) or times out. Any other outcome, a refusal included, means a
 * route exists.
 * @internal Exported for tests.
 */
export async function imdsUnreachable(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult> {
  const connect = environment.connect ?? tcpConnect
  const outcome = await connect(IMDS_HOST, 80, IMDS_CONNECT_TIMEOUT_MS)
  if (outcome === 'timeout' || (outcome !== 'connected' && NO_ROUTE_CODES.has(outcome.code))) {
    return {
      check: 'imds',
      ok: true,
      detail: outcome === 'timeout' ? 'timed out' : outcome.code,
    }
  }
  return {
    check: 'imds',
    ok: false,
    detail:
      `the worker unit can reach the instance metadata service (${outcome === 'connected' ? 'connected' : outcome.code}), ` +
      'so the process split protects nothing',
  }
}

/**
 * `/proc/self/net/dev` lists only `lo`: `PrivateNetwork=` took effect. Not `/sys/class/net`, which
 * `PrivateNetwork=` does not remount, so it shows the host's interfaces even inside the cut.
 * @internal Exported for tests.
 */
export async function onlyLoopback(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult> {
  const file = path.join(rootOf(environment), 'proc', 'self', 'net', 'dev')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    return {
      check: 'network-namespace',
      ok: false,
      detail: `cannot read ${file}: ${getErrorMessage(err)}`,
    }
  }
  const interfaces = text
    .split('\n')
    .slice(2)
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter((name) => name !== '')
  const ok = interfaces.length === 1 && interfaces[0] === 'lo'
  return {
    check: 'network-namespace',
    ok,
    detail: ok
      ? 'only lo'
      : `the worker unit sees network interfaces besides lo (${interfaces.join(', ')}): it is not in a private network namespace`,
  }
}

/**
 * Every process `/proc` lists is this uid's: `ProtectProc=invisible` took effect.
 * @internal Exported for tests.
 */
export async function procShowsOnlyOwnProcesses(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult> {
  const proc = path.join(rootOf(environment), 'proc')
  const uid = environment.uid ?? process.getuid?.()
  if (uid === undefined) {
    return { check: 'proc', ok: false, detail: 'this platform has no process uid to compare' }
  }
  let entries: string[]
  try {
    entries = await fs.readdir(proc)
  } catch (err) {
    return { check: 'proc', ok: false, detail: `cannot list ${proc}: ${getErrorMessage(err)}` }
  }
  const others: string[] = []
  for (const entry of entries.filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = await fs.stat(path.join(proc, entry))
      if (stat.uid !== uid) others.push(`${entry} (uid ${stat.uid})`)
    } catch (err) {
      // A process that exited between the listing and the stat.
      if (!(isNodeError(err) && err.code === 'ENOENT')) {
        others.push(`${entry} (${getErrorMessage(err)})`)
      }
    }
  }
  const ok = others.length === 0
  return {
    check: 'proc',
    ok,
    detail: ok
      ? `only uid ${uid}`
      : `the worker unit sees other users' processes: ${others.slice(0, 5).join(', ')}`,
  }
}

/**
 * `/home` is empty: `ProtectHome=tmpfs`'s always-observable effect. `/run/user`, which it also
 * hides, is empty anyway whenever nobody is logged in.
 * @internal Exported for tests.
 */
export async function homeIsEmpty(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult> {
  const home = path.join(rootOf(environment), 'home')
  try {
    const entries = await fs.readdir(home)
    return {
      check: 'home',
      ok: entries.length === 0,
      detail:
        entries.length === 0
          ? 'empty'
          : `the worker unit sees ${home}'s entries: ProtectHome=tmpfs did not apply`,
    }
  } catch (err) {
    return { check: 'home', ok: false, detail: `cannot list ${home}: ${getErrorMessage(err)}` }
  }
}

/**
 * No GitHub or Clerk secret, nor the ARN or JSON field naming one, is in the worker's environment:
 * they belong to the gateway's env file. Names only are reported.
 * @internal Exported for tests.
 */
export function noSecretsInEnv(environment: SelfCheckEnvironment = {}): SelfCheckResult {
  const env = environment.env ?? process.env
  const found = Object.keys(env)
    .filter((key) => env[key] !== undefined && SECRET_ENV_PATTERN.test(key))
    .sort()
  const ok = found.length === 0
  return {
    check: 'secrets-in-env',
    ok,
    detail: ok
      ? 'none'
      : `the worker unit's environment holds ${found.join(', ')}, which belong to the GitHub gateway only`,
  }
}

/**
 * The gateway cannot list `/mnt/efs`: `InaccessiblePaths=/mnt/efs` took effect.
 * @internal Exported for tests.
 */
export async function efsUnreadable(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult> {
  const efs = path.join(rootOf(environment), 'mnt', 'efs')
  try {
    await fs.readdir(efs)
  } catch (err) {
    // Denied is the directive at work. Absent (a unit without `RequiresMountsFor=`, started before
    // the mount) or any other failure proves nothing: a mount made later could still reach it.
    const code = isNodeError(err) ? err.code : undefined
    const denied = code === 'EACCES' || code === 'EPERM'
    return {
      check: 'efs-unreadable',
      ok: denied,
      detail: denied
        ? (code ?? '')
        : `cannot tell that ${efs} is inaccessible: ${getErrorMessage(err)}`,
    }
  }
  return {
    check: 'efs-unreadable',
    ok: false,
    detail: `the GitHub gateway can read ${efs}, where the CMS Lambda writes`,
  }
}

/**
 * `kernel.core_pattern` does not begin with `|`: a piped pattern would hand a crashing gateway
 * git's memory (the credential file's contents) to a helper.
 * @internal Exported for tests.
 */
export async function corePatternNotPiped(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult> {
  const file = path.join(rootOf(environment), 'proc', 'sys', 'kernel', 'core_pattern')
  try {
    const pattern = (await fs.readFile(file, 'utf8')).trim()
    const ok = !pattern.startsWith('|')
    return {
      check: 'core-pattern',
      ok,
      detail: ok ? pattern : `kernel.core_pattern pipes core dumps to a program (${pattern})`,
    }
  } catch (err) {
    return {
      check: 'core-pattern',
      ok: false,
      detail: `cannot read ${file}: ${getErrorMessage(err)}`,
    }
  }
}

/**
 * `/proc/self/limits` shows a zero core limit, soft and hard: `LimitCORE=0` took effect.
 * @internal Exported for tests.
 */
export async function coreLimitZero(
  environment: SelfCheckEnvironment = {},
): Promise<SelfCheckResult> {
  const file = path.join(rootOf(environment), 'proc', 'self', 'limits')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    return {
      check: 'core-limit',
      ok: false,
      detail: `cannot read ${file}: ${getErrorMessage(err)}`,
    }
  }
  const line = text.split('\n').find((row) => row.startsWith('Max core file size'))
  const [soft, hard] = line?.slice('Max core file size'.length).trim().split(/\s+/) ?? []
  const ok = soft === '0' && hard === '0'
  return {
    check: 'core-limit',
    ok,
    detail: ok
      ? 'zero'
      : `the core file size limit is ${soft ?? '?'} (soft) and ${hard ?? '?'} (hard), not zero`,
  }
}

function rootOf(environment: SelfCheckEnvironment): string {
  return environment.root ?? '/'
}

/**
 * One TCP connect, as the IMDS check makes it.
 * @internal Exported for tests.
 */
export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<ConnectOutcome> {
  return new Promise<ConnectOutcome>((resolve) => {
    let socket: net.Socket
    try {
      socket = net.connect({ host, port })
    } catch (err) {
      resolve({ code: isNodeError(err) && err.code !== undefined ? err.code : 'ERROR' })
      return
    }
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('timeout')
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      resolve({ code: isNodeError(err) && err.code !== undefined ? err.code : 'ERROR' })
    })
  })
}
