import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { gitChildEnv } from '../git-manager'
import { GitProcessError, STDERR_CAP_BYTES, runGit, spawnGit } from './git-process'

let cwd: string

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'git-process-'))
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

/** Options running `alias.<name>`, a shell command, as git. */
function alias(name: string, command: string, timeoutMs = 10_000) {
  return {
    cwd,
    env: gitChildEnv({}),
    config: [`alias.${name}=!${command}`],
    inactivityTimeoutMs: timeoutMs,
  }
}

async function failure(promise: Promise<unknown>): Promise<GitProcessError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(GitProcessError)
  return err as GitProcessError
}

describe('runGit', () => {
  it("resolves with git's stdout, fed its stdin", async () => {
    const out = await runGit(['hash-object', '--stdin'], {
      cwd,
      env: gitChildEnv({}),
      stdin: 'hello\n',
      inactivityTimeoutMs: 10_000,
    })
    expect(out.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('rejects with stderr as the message when git fails', async () => {
    const err = await failure(runGit(['rev-parse', '--verify', 'no-such-ref'], alias('x', 'true')))
    expect(err.exitCode).not.toBe(0)
    expect(err.message).toMatch(/Needed a single revision|fatal/)
  })

  it('kills git that writes nothing for the inactivity bound', async () => {
    const started = Date.now()
    const err = await failure(runGit(['nap'], alias('nap', 'sleep 5', 200)))
    expect(err.message).toBe('git nap wrote nothing for 200ms')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('kills git that runs past its deadline, though it keeps writing', async () => {
    const started = Date.now()
    const err = await failure(
      runGit(['chatty'], {
        ...alias('chatty', 'while :; do echo x >&2; sleep 0.05; done', 10_000),
        deadlineMs: 300,
      }),
    )
    expect(err.message).toBe('git chatty ran longer than 300ms')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('kills git when the signal aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)
    const err = await failure(
      runGit(['nap'], { ...alias('nap', 'sleep 5'), signal: controller.signal }),
    )
    expect(err.message).toBe('git nap was aborted')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('kills git at once when the signal has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const err = await failure(
      runGit(['nap'], { ...alias('nap', 'sleep 5'), signal: controller.signal }),
    )
    expect(err.message).toBe('git nap was aborted')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('keeps only the first STDERR_CAP_BYTES of stderr', async () => {
    const err = await failure(
      runGit(['loud'], alias('loud', 'yes x | head -c 1000000 >&2; exit 3')),
    )
    expect(err.exitCode).toBe(3)
    expect(err.stderr.length).toBeLessThanOrEqual(STDERR_CAP_BYTES + '\n[stderr truncated]'.length)
    expect(err.stderr.endsWith('[stderr truncated]')).toBe(true)
  })

  it('refuses more stdout than maxStdoutBytes', async () => {
    const err = await failure(
      runGit(['big'], { ...alias('big', 'yes y | head -c 100000'), maxStdoutBytes: 1000 }),
    )
    expect(err.message).toBe('git printed more than 1000 bytes')
  })

  it('reads stdin only as fast as git does', async () => {
    let produced = 0
    const endless = new Readable({
      read() {
        produced += 65536
        this.push(Buffer.alloc(65536, 0x61))
      },
    })
    // git never reads its stdin; the shell exits after a second.
    await runGit(['nap'], { ...alias('nap', 'sleep 1'), stdin: endless })
    expect(produced).toBeGreaterThan(0)
    expect(produced).toBeLessThan(4 * 1024 * 1024)
  })

  it('fails when its input stream fails, and stops git', async () => {
    const broken = new Readable({
      read() {
        this.destroy(new Error('the source broke'))
      },
    })
    const err = await failure(
      runGit(['cat'], { ...alias('cat', 'cat >/dev/null; sleep 5'), stdin: broken }),
    )
    expect(err.message).toBe("git cat's input failed: the source broke")
  })
})

describe('spawnGit', () => {
  it('streams stdout to its reader', async () => {
    const proc = spawnGit(['hash-object', '--stdin'], {
      cwd,
      env: gitChildEnv({}),
      stdin: 'hello\n',
      inactivityTimeoutMs: 10_000,
    })
    let out = ''
    for await (const chunk of proc.stdout) out += String(chunk)
    await proc.exited
    expect(out.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('settles `exited` after a kill while its output sits unread', async () => {
    const proc = spawnGit(['big'], alias('big', 'yes y | head -c 1000000; sleep 5'))
    // Start reading, then stop, so output waits in the pipe and the stream's buffer.
    const chunks = proc.stdout[Symbol.asyncIterator]()
    await chunks.next()
    proc.kill('no longer wanted')
    const err = await failure(proc.exited)
    expect(err.message).toBe('no longer wanted')
  })

  it('settles `exited` after a kill that comes once git has exited, its output unread', async () => {
    // More than one read, but small enough to fit the pipe and the stream's buffer, so git exits
    // with the rest unread.
    const proc = spawnGit(['small'], alias('small', 'yes y | head -c 100000'))
    const chunks = proc.stdout[Symbol.asyncIterator]()
    await chunks.next()
    await new Promise((resolve) => setTimeout(resolve, 500))
    proc.kill('no longer wanted')
    const settled = await Promise.race([
      proc.exited.then(
        () => 'resolved',
        (err: unknown) => (err as Error).message,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 3_000)),
    ])
    expect(settled).toBe('no longer wanted')
  })

  it('lets a slow reader take what git wrote before it exited 0, past the inactivity bound', async () => {
    const proc = spawnGit(['small'], alias('small', 'yes y | head -c 100000', 300))
    const chunks = proc.stdout[Symbol.asyncIterator]()
    let bytes = 0
    // A pause past the bound after each read; git exits before the first pause ends.
    for (;;) {
      const next = await chunks.next()
      if (next.done) break
      bytes += (next.value as Buffer).length
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    await proc.exited
    expect(bytes).toBe(100_000)
  })

  it('waits for a reader that holds back, past the inactivity bound, while git has more to write', async () => {
    // More than the pipe and the stream's buffer hold, so git blocks writing while the reader
    // waits: a push's bundle while the gateway has not yet taken it in.
    const proc = spawnGit(['big'], alias('big', 'yes y | head -c 2000000', 300))
    const chunks = proc.stdout[Symbol.asyncIterator]()
    let bytes = 0
    const first = await chunks.next()
    bytes += (first.value as Buffer).length
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    for (;;) {
      const next = await chunks.next()
      if (next.done) break
      bytes += (next.value as Buffer).length
    }
    await proc.exited
    expect(bytes).toBe(2_000_000)
  })

  it('kills a git gone quiet once its reader has taken everything it wrote', async () => {
    const proc = spawnGit(['quiet'], alias('quiet', 'printf x; sleep 5', 300))
    let out = ''
    // The kill ends the stream early, which is this reader's failure, not the test's.
    const reading = (async () => {
      for await (const chunk of proc.stdout) out += String(chunk)
    })().catch(() => undefined)
    const err = await failure(proc.exited)
    await reading
    expect(out).toBe('x')
    expect(err.message).toBe('git quiet wrote nothing for 300ms')
  })

  it("reports git's own failure, not a stop that came after it", async () => {
    const proc = spawnGit(
      ['fail'],
      alias('fail', 'yes y | head -c 100000; echo it-broke >&2; exit 3'),
    )
    const chunks = proc.stdout[Symbol.asyncIterator]()
    await chunks.next()
    await new Promise((resolve) => setTimeout(resolve, 500))
    proc.kill('no longer wanted')
    const err = await failure(proc.exited)
    expect(err.exitCode).toBe(3)
    expect(err.message).toBe('it-broke')
  })

  it('stops what git spawned too, so nothing it left holds the pipes open', async () => {
    // The shell backgrounds a process git knows nothing of, which keeps stderr open.
    const proc = spawnGit(['nap'], alias('nap', 'sleep 6 & sleep 6'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const started = Date.now()
    proc.kill('no longer wanted')
    const err = await failure(proc.exited)
    expect(err.message).toBe('no longer wanted')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('stops what git spawned even after git itself has exited', async () => {
    const proc = spawnGit(['quit'], alias('quit', 'sleep 6 & exit 3'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const started = Date.now()
    proc.kill('no longer wanted')
    const err = await failure(proc.exited)
    expect(err.exitCode).toBe(3)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('kills what git spawned when it ignores the request to stop', async () => {
    // An ignored SIGTERM is inherited, so the backgrounded sleep ignores it too.
    const proc = spawnGit(['quit'], alias('quit', "trap '' TERM; sleep 8 & exit 3"))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const started = Date.now()
    proc.kill('no longer wanted')
    await failure(proc.exited)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('rejects `exited` after the caller kills it', async () => {
    const proc = spawnGit(['nap'], alias('nap', 'sleep 5'))
    proc.kill('not needed')
    const err = await failure(proc.exited)
    expect(err.message).toBe('not needed')
  })
})
