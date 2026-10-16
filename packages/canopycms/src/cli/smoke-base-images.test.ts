/**
 * `scripts/smoke/base-images.mjs` decides which images CI puts in the local store before the
 * standalone-image smoke builds Dockerfile.cms, and which pull failures it retries. A base it
 * misses is pulled by the build from public.ecr.aws, the request this exists to avoid; a failure
 * it retries wrongly delays a real error.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { beforeAll, describe, expect, it, vi } from 'vitest'

interface PullResult {
  status: number | null
  output: string
}

interface BaseImagesModule {
  PULL_RETRY_DELAYS_S: number[]
  baseImageRefs(dockerfile: string): string[]
  pullWithRetry(
    ref: string,
    deps: {
      pull: (ref: string) => PullResult
      sleep: (ms: number) => void
      log: (message: string) => void
      delays?: number[]
    },
  ): number
}

// This file sits at packages/canopycms/src/cli/, so the workspace root is four up.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const REFUSED =
  'Error response from daemon: unexpected status code https://public.ecr.aws/v2/docker/library/node/manifests/sha256:c3de: 429 Too Many Requests - Server message: toomanyrequests: Data limit exceeded'

let mod: BaseImagesModule

beforeAll(async () => {
  mod = await import(pathToFileURL(path.join(ROOT, 'scripts/smoke/base-images.mjs')).href)
})

describe('baseImageRefs', () => {
  it('finds both registry images in the Dockerfile.cms template, and no stage', () => {
    const template = fs.readFileSync(
      path.join(ROOT, 'packages/canopycms/src/cli/template-files/Dockerfile.cms.template'),
      'utf8',
    )
    expect(mod.baseImageRefs(template)).toEqual([
      'public.ecr.aws/docker/library/node:22-slim',
      'public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1',
    ])
  })

  it('skips stages, scratch and flags, and lists each image once', () => {
    const dockerfile = [
      'FROM --platform=linux/arm64 registry.example/base:1 AS Builder',
      'FROM scratch AS empty',
      'FROM builder AS second',
      'COPY --from=BUILDER /a /a',
      'COPY --chown=1000 --from=registry.example/tool:2 /t /t',
      'ADD --from=empty /b /b',
      'from registry.example/base:1',
    ].join('\n')
    expect(mod.baseImageRefs(dockerfile)).toEqual([
      'registry.example/base:1',
      'registry.example/tool:2',
    ])
  })

  it('refuses an image named by a build argument', () => {
    expect(() => mod.baseImageRefs('ARG BASE=node\nFROM ${BASE}:22\n')).toThrow(/variable/)
  })
})

describe('pullWithRetry', () => {
  const deps = (results: PullResult[]) => {
    const pull = vi.fn((_ref: string): PullResult => results.shift() ?? { status: 0, output: '' })
    const sleep = vi.fn((_ms: number) => {})
    return { pull, sleep, log: () => {} }
  }

  it('retries a toomanyrequests refusal after the first delay, then succeeds', () => {
    const d = deps([{ status: 1, output: REFUSED }])
    expect(mod.pullWithRetry('img', d)).toBe(2)
    expect(d.pull).toHaveBeenCalledTimes(2)
    expect(d.sleep.mock.calls).toEqual([[mod.PULL_RETRY_DELAYS_S[0] * 1000]])
  })

  it('fails at once on any other failure, without waiting', () => {
    const d = deps([
      { status: 1, output: 'manifest unknown: 404 Not Found' },
      { status: 0, output: '' },
    ])
    expect(() => mod.pullWithRetry('img', d)).toThrow(/docker pull img/)
    expect(d.pull).toHaveBeenCalledTimes(1)
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it('gives up after one more attempt than there are delays', () => {
    const delays = [1, 2, 3]
    const d = deps(Array.from({ length: 10 }, () => ({ status: 1, output: REFUSED })))
    expect(() => mod.pullWithRetry('img', { ...d, delays })).toThrow(/exited with status 1/)
    expect(d.pull).toHaveBeenCalledTimes(delays.length + 1)
    expect(d.sleep.mock.calls).toEqual(delays.map((s) => [s * 1000]))
  })

  it('waits at most the default delays in total', () => {
    const d = deps(Array.from({ length: 10 }, () => ({ status: 1, output: REFUSED })))
    expect(() => mod.pullWithRetry('img', d)).toThrow()
    expect(d.pull).toHaveBeenCalledTimes(mod.PULL_RETRY_DELAYS_S.length + 1)
    expect(d.sleep.mock.calls.flat().reduce((a, b) => a + b, 0)).toBe(80_000)
  })
})
