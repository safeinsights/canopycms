import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { getErrorMessage } from '../utils/error'

/**
 * git with its stdin or stdout as a stream, which simple-git cannot do: a bundle's way into
 * `bundle unbundle -` and `fetch`, out of `bundle create -`, and `update-ref --stdin`'s
 * transactions. The caller supplies the whole environment, config and working directory, so the
 * pins of the repository it runs in apply here exactly as they do through simple-git
 * (worker/shared-repo-git.ts, worker/github-mirror.ts).
 *
 * Bounded three ways: killed after {@link GitProcessOptions.inactivityTimeoutMs} with no output
 * and no input consumed, killed when `signal` aborts, and holding at most
 * {@link STDERR_CAP_BYTES} of stderr and `maxStdoutBytes` of captured stdout, so a process fed
 * hostile bytes cannot make this one buffer without limit.
 */

export interface GitProcessOptions {
  /** The process's working directory, absolute. */
  cwd: string
  /** The process's entire environment. */
  env: Record<string, string>
  /** `-c` settings, given ahead of the subcommand. */
  config?: readonly string[]
  /** What git reads on stdin; without it stdin is closed at once. */
  stdin?: Readable | string
  /** Killed when nothing is written to stdout or stderr, and nothing consumed from stdin, for this long. */
  inactivityTimeoutMs: number
  signal?: AbortSignal
}

/** git exited non-zero, by a signal, or was killed here; `message` is its stderr when it wrote any. */
export class GitProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitProcessError'
  }
}

/** The most stderr kept, from the start: git's diagnosis comes first. */
export const STDERR_CAP_BYTES = 64 * 1024

/** How long a process asked to stop has before it is killed outright. */
const KILL_GRACE_MS = 2_000

/** A git process with its stdout as a stream; see {@link spawnGit}. */
export interface GitProcess {
  readonly stdout: Readable
  /** Settles when git has exited: rejects unless it exited 0 on its own. */
  readonly exited: Promise<void>
  /** Stop git now; `exited` then rejects. */
  kill(reason: string): void
}

/**
 * Start `git <config> <args>` with stdout as a stream the caller must read or {@link GitProcess.kill}:
 * git blocks on a full pipe, and a reader that stops counts as inactivity.
 */
export function spawnGit(args: readonly string[], options: GitProcessOptions): GitProcess {
  const child = spawn('git', [...(options.config ?? []).flatMap((c) => ['-c', c]), ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const { stdout } = child
  if (stdout === null) throw new Error('git was spawned without a stdout pipe')
  const command = args.find((arg) => !arg.startsWith('-')) ?? 'git'

  let stderr = ''
  let stderrBytes = 0
  let killedFor: string | null = null
  let inactivity: NodeJS.Timeout | undefined
  const touch = () => {
    clearTimeout(inactivity)
    inactivity = setTimeout(
      () => stop(`git ${command} wrote nothing for ${options.inactivityTimeoutMs}ms`),
      options.inactivityTimeoutMs,
    )
  }
  const stop = (reason: string) => {
    if (killedFor !== null || child.exitCode !== null || child.signalCode !== null) return
    killedFor = reason
    terminate(child)
    // Unread output would otherwise hold the pipe open, and 'close' would never come.
    stdout.destroy()
  }

  child.stderr?.on('data', (chunk: Buffer) => {
    touch()
    if (stderrBytes < STDERR_CAP_BYTES) {
      stderr += chunk.subarray(0, STDERR_CAP_BYTES - stderrBytes).toString('utf8')
    }
    stderrBytes += chunk.length
  })
  stdout.on('data', touch)

  const onAbort = () => stop(`git ${command} was aborted`)
  if (options.signal?.aborted) onAbort()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  const input = feedStdin(child, options.stdin, touch, (err) =>
    stop(`git ${command}'s input failed: ${getErrorMessage(err)}`),
  )
  // Read only when git exits 0; a kill reports the failure itself.
  input.catch(() => undefined)
  touch()

  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => {
      // Never started (git missing, a bad cwd): no 'close' is coming.
      if (child.pid === undefined) {
        clearTimeout(inactivity)
        options.signal?.removeEventListener('abort', onAbort)
        reject(new GitProcessError(`git ${command} could not run: ${err.message}`, null, ''))
      }
    })
    child.on('close', (code, signal) => {
      clearTimeout(inactivity)
      options.signal?.removeEventListener('abort', onAbort)
      const written = stderrBytes > STDERR_CAP_BYTES ? `${stderr}\n[stderr truncated]` : stderr
      if (killedFor === null && code === 0) {
        // A failed source stream is a failure even when git made do with what it got.
        input.then(resolve, (err: unknown) =>
          reject(
            new GitProcessError(
              `git ${command}'s input failed: ${getErrorMessage(err)}`,
              0,
              written,
            ),
          ),
        )
        return
      }
      const why =
        killedFor ??
        (written.trim() ||
          (code === null
            ? `git ${command} was killed by ${signal ?? 'a signal'}`
            : `git ${command} exited with code ${code}`))
      reject(new GitProcessError(why, code, written))
    })
  })
  // The caller may never await it after a kill it chose.
  exited.catch(() => undefined)

  return { stdout, exited, kill: stop }
}

/**
 * Run `git <config> <args>` to completion and resolve with its stdout, refusing more than
 * `maxStdoutBytes` of it (default 64 MiB).
 */
export async function runGit(
  args: readonly string[],
  options: GitProcessOptions & { maxStdoutBytes?: number },
): Promise<string> {
  const max = options.maxStdoutBytes ?? 64 * 1024 * 1024
  const proc = spawnGit(args, options)
  const chunks: Buffer[] = []
  let total = 0
  const collect = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > max) {
        proc.kill(`git printed more than ${max} bytes`)
        callback()
        return
      }
      chunks.push(chunk)
      callback()
    },
  })
  await Promise.all([pipeline(proc.stdout, collect).catch(() => undefined), proc.exited])
  return Buffer.concat(chunks).toString('utf8')
}

/** Ask git to stop, then kill it if it has not within {@link KILL_GRACE_MS}. */
function terminate(child: ChildProcess): void {
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, KILL_GRACE_MS)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}

/**
 * Write `source` to git's stdin, resolving when it is all written or git has closed its stdin,
 * and rejecting if the SOURCE fails. git closing its stdin early (it exited, or needs no more) is
 * not this stream's failure: git's own exit reports it, and the source is then released unread.
 */
function feedStdin(
  child: ChildProcess,
  source: Readable | string | undefined,
  touch: () => void,
  onSourceError: (err: unknown) => void,
): Promise<void> {
  const sink = child.stdin
  if (sink === null) return Promise.resolve()
  // EPIPE when git exits before reading everything.
  sink.on('error', () => undefined)
  if (source === undefined) {
    sink.end()
    return Promise.resolve()
  }
  const readable = typeof source === 'string' ? Readable.from([Buffer.from(source)]) : source
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      touch()
      callback(null, chunk)
    },
  })
  return new Promise<void>((resolve, reject) => {
    readable.once('error', (err) => {
      // A source that failed part way must not leave git waiting for the rest of it.
      onSourceError(err)
      reject(err)
    })
    sink.once('close', () => {
      if (!readable.readableEnded) readable.destroy()
      resolve()
    })
    // Not stream.pipeline, which would destroy the source with git's EPIPE and report it as the
    // source's own failure.
    readable.pipe(counted).pipe(sink)
  })
}
