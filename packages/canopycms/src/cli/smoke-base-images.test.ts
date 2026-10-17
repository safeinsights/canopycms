/**
 * `scripts/smoke/base-images.mjs` decides which images CI puts in the local store before the
 * standalone-image smoke builds Dockerfile.cms, and which pull failures it retries. A base it
 * misses is pulled by the build from public.ecr.aws, the request this exists to avoid; a failure
 * it retries wrongly delays a real error. Its seed decides what main's cache holds, so every check
 * that ties a saved image to the digest ECR named is pinned here: a tar saved past a failed one is
 * an image nobody verified.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockConsole, type MockConsole } from '../test-utils/console-spy'

interface PullResult {
  status: number | null
  output: string
}

interface InspectedImage {
  Id: string
  Architecture: string
  RepoDigests: string[]
}

interface SeedDeps {
  platform: string
  save: string
  run: (args: string[]) => PullResult
  fetch: (url: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  syncSleep: (ms: number) => void
}

interface BaseImagesModule {
  PULL_RETRY_DELAYS_S: number[]
  INDEX_MEDIA_TYPES: string[]
  parseEcrRef(ref: string): { repository: string; tag: string }
  pullSources(repository: string): string[]
  platformArch(platform: string | undefined): string
  indexDigestFrom(response: Response, ref: string): string
  resolveEcrDigest(
    ref: string,
    deps: {
      fetch: (url: string, init: RequestInit) => Promise<Response>
      sleep: (ms: number) => Promise<void>
      delays?: number[]
    },
  ): Promise<string>
  platformFlags(driverStatus: string, platform: string): string[]
  checkImage(
    inspected: string,
    name: string,
    expected: { arch: string; id?: string; digest?: string },
  ): string
  seedBaseImages(dockerfilePath: string, deps: SeedDeps): Promise<{ ref: string; id: string }[]>
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
  ensureBaseImages(
    dockerfilePath: string,
    opts: {
      tar?: string
      run: (args: string[]) => PullResult
      sleep: (ms: number) => void
    },
  ): string[]
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
      'COPY --from=0 /c /c',
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

describe('ensureBaseImages', () => {
  const NODE = 'registry.example/node:22'
  const TOOL = 'registry.example/tool:1'
  let dir: string
  let dockerfile: string
  let tar: string
  let consoleSpy: MockConsole

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-base-images-'))
    dockerfile = path.join(dir, 'Dockerfile')
    fs.writeFileSync(
      dockerfile,
      `FROM ${NODE} AS b\nCOPY --from=${TOOL} /t /t\nCOPY --from=b /a /a\n`,
    )
    tar = path.join(dir, 'base-images.tar')
    fs.writeFileSync(tar, '')
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A docker whose store holds `present`; `load` adds `inTar` when `loads` is true, and each pull
   * answers with the next of `pulls`, then succeeds. Any other argument shape throws.
   */
  const fakeDocker = (
    present: string[],
    { inTar = [] as string[], loads = true, pulls = [] as PullResult[] } = {},
  ) => {
    const store = new Set(present)
    const run = vi.fn((args: string[]): PullResult => {
      const ref = args[args.length - 1]
      const shape = args.slice(0, -1).join(' ')
      if (shape === 'load -i' && ref === tar) {
        if (loads) inTar.forEach((image) => store.add(image))
        return { status: loads ? 0 : 1, output: '' }
      }
      if (shape === 'image inspect --format {{.Id}}') {
        return { status: store.has(ref) ? 0 : 1, output: '' }
      }
      if (shape === 'pull') {
        const result = pulls.shift() ?? { status: 0, output: '' }
        if (result.status === 0) store.add(ref)
        return result
      }
      throw new Error(`unexpected docker ${args.join(' ')}`)
    })
    const pulled = () => run.mock.calls.filter(([args]) => args[0] === 'pull').map(([a]) => a[1])
    return { run, pulled, sleep: vi.fn((_ms: number) => {}) }
  }

  it('pulls nothing when the tar holds every base', () => {
    const d = fakeDocker([], { inTar: [NODE, TOOL] })
    expect(mod.ensureBaseImages(dockerfile, { tar, ...d })).toEqual([NODE, TOOL])
    expect(d.run.mock.calls[0][0]).toEqual(['load', '-i', tar])
    expect(d.pulled()).toEqual([])
  })

  it('pulls only the base the tar lacks', () => {
    const d = fakeDocker([], { inTar: [NODE] })
    mod.ensureBaseImages(dockerfile, { tar, ...d })
    expect(d.pulled()).toEqual([TOOL])
  })

  it('pulls every base when the tar does not load', () => {
    const d = fakeDocker([], { inTar: [NODE, TOOL], loads: false })
    mod.ensureBaseImages(dockerfile, { tar, ...d })
    expect(d.pulled()).toEqual([NODE, TOOL])
  })

  it('loads nothing without a tar file, and pulls what the store lacks', () => {
    const d = fakeDocker([NODE])
    mod.ensureBaseImages(dockerfile, { tar: path.join(dir, 'absent.tar'), ...d })
    expect(d.run.mock.calls.some(([args]) => args[0] === 'load')).toBe(false)
    expect(d.pulled()).toEqual([TOOL])
  })

  it('stops at the first pull that fails for any reason but a refusal', () => {
    const d = fakeDocker([], { pulls: [{ status: 1, output: 'manifest unknown' }] })
    expect(() => mod.ensureBaseImages(dockerfile, { tar, ...d })).toThrow(/docker pull/)
    expect(d.pulled()).toEqual([NODE])
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it('waits through the injected sleep when a pull is refused', () => {
    const d = fakeDocker([], { pulls: [{ status: 1, output: REFUSED }] })
    mod.ensureBaseImages(dockerfile, { tar, ...d })
    expect(d.pulled()).toEqual([NODE, NODE, TOOL])
    expect(d.sleep.mock.calls).toEqual([[mod.PULL_RETRY_DELAYS_S[0] * 1000]])
    // Through the console, so a test's console spy holds it rather than the run's output.
    expect(consoleSpy.all().log).toContain(REFUSED)
  })
})

const NODE_REF = 'public.ecr.aws/docker/library/node:22-slim'
const ADAPTER_REF = 'public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1'
const NODE_DIGEST = `sha256:${'c3'.repeat(32)}`
const ADAPTER_DIGEST = `sha256:${'1e'.repeat(32)}`
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json'

const headResponse = (digest: string, type = OCI_INDEX, status = 200) =>
  new Response(null, { status, headers: { 'content-type': type, 'docker-content-digest': digest } })

describe('parseEcrRef', () => {
  it("splits both of the template's references into repository and tag", () => {
    expect(mod.parseEcrRef(NODE_REF)).toEqual({ repository: 'docker/library/node', tag: '22-slim' })
    expect(mod.parseEcrRef(ADAPTER_REF)).toEqual({
      repository: 'awsguru/aws-lambda-adapter',
      tag: '1.0.1',
    })
  })

  it.each([
    'docker.io/library/node:22-slim',
    'node:22-slim',
    'public.ecr.aws.example/docker/library/node:22-slim',
    'registry.example/public.ecr.aws/docker/library/node:22-slim',
    'public.ecr.aws/docker/library/node',
    `public.ecr.aws/docker/library/node@${NODE_DIGEST}`,
    `public.ecr.aws/docker/library/node:22-slim@${NODE_DIGEST}`,
    'public.ecr.aws/docker/../node:22-slim',
    'public.ecr.aws/docker//node:22-slim',
    'public.ecr.aws/docker/library/:22-slim',
    'public.ecr.aws/Docker/library/node:22-slim',
    'public.ecr.aws/docker/library/node:22?x=1',
  ])('refuses %s', (ref) => {
    expect(() => mod.parseEcrRef(ref)).toThrow(/tagged public\.ecr\.aws/)
  })
})

describe('pullSources', () => {
  it("pulls Docker's official images from mirror.gcr.io, then Docker Hub, never ECR", () => {
    expect(mod.pullSources('docker/library/node')).toEqual([
      'mirror.gcr.io/library/node',
      'docker.io/library/node',
    ])
  })

  it('pulls every other repository from ECR alone', () => {
    expect(mod.pullSources('awsguru/aws-lambda-adapter')).toEqual([
      'public.ecr.aws/awsguru/aws-lambda-adapter',
    ])
    expect(mod.pullSources('docker/library/node/extra')).toEqual([
      'public.ecr.aws/docker/library/node/extra',
    ])
    expect(mod.pullSources('docker/libraryx/node')).toEqual(['public.ecr.aws/docker/libraryx/node'])
  })
})

describe('platformArch', () => {
  it('maps the two platforms the CMS image ships on to their architectures', () => {
    expect(mod.platformArch('linux/amd64')).toBe('amd64')
    expect(mod.platformArch('linux/arm64')).toBe('arm64')
  })

  it.each([undefined, '', 'amd64', 'linux/arm/v7', 'linux/amd64 ', 'windows/amd64'])(
    'refuses %s',
    (platform) => {
      expect(() => mod.platformArch(platform)).toThrow(/--platform/)
    },
  )
})

describe('indexDigestFrom', () => {
  it('takes the digest of an OCI index or a Docker manifest list', () => {
    expect(mod.indexDigestFrom(headResponse(NODE_DIGEST), NODE_REF)).toBe(NODE_DIGEST)
    expect(
      mod.indexDigestFrom(
        headResponse(NODE_DIGEST, 'application/vnd.docker.distribution.manifest.list.v2+json'),
        NODE_REF,
      ),
    ).toBe(NODE_DIGEST)
    expect(
      mod.indexDigestFrom(headResponse(NODE_DIGEST, `${OCI_INDEX}; charset=utf-8`), NODE_REF),
    ).toBe(NODE_DIGEST)
  })

  it('refuses any status but 200', () => {
    expect(() => mod.indexDigestFrom(headResponse(NODE_DIGEST, OCI_INDEX, 429), NODE_REF)).toThrow(
      /with 429/,
    )
  })

  it('refuses a single-platform manifest or no type', () => {
    expect(() =>
      mod.indexDigestFrom(
        headResponse(NODE_DIGEST, 'application/vnd.oci.image.manifest.v1+json'),
        NODE_REF,
      ),
    ).toThrow(/not an index/)
    expect(() => mod.indexDigestFrom(headResponse(NODE_DIGEST, ''), NODE_REF)).toThrow(
      /no type, not an index/,
    )
  })

  it.each([
    '',
    'sha256:abc',
    `sha512:${'c3'.repeat(64)}`,
    `sha256:${'C3'.repeat(32)}`,
    `sha256:${'g3'.repeat(32)}`,
    `${NODE_DIGEST}00`,
  ])('refuses the digest %j', (digest) => {
    expect(() => mod.indexDigestFrom(headResponse(digest), NODE_REF)).toThrow(/sha256 digest/)
  })
})

describe('resolveEcrDigest', () => {
  let consoleSpy: MockConsole
  beforeEach(() => {
    consoleSpy = mockConsole()
  })
  afterEach(() => {
    consoleSpy.restore()
  })

  const tokenResponse = (body: unknown = { token: 'tok' }) =>
    new Response(JSON.stringify(body), { status: 200 })

  const fakeFetch = (responses: Response[]) => {
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> =>
        responses.shift() ?? new Response(null, { status: 500 }),
    )
    const sleep = vi.fn(async (_ms: number) => {})
    return { fetch, sleep }
  }

  it("reads the tag's index digest with an anonymous token and a HEAD, never a GET of it", async () => {
    const d = fakeFetch([tokenResponse(), headResponse(NODE_DIGEST)])
    await expect(mod.resolveEcrDigest(NODE_REF, d)).resolves.toBe(NODE_DIGEST)
    expect(d.fetch.mock.calls).toEqual([
      [
        'https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository:docker/library/node:pull',
        { method: 'GET' },
      ],
      [
        'https://public.ecr.aws/v2/docker/library/node/manifests/22-slim',
        {
          method: 'HEAD',
          headers: { Accept: mod.INDEX_MEDIA_TYPES.join(', '), Authorization: 'Bearer tok' },
        },
      ],
    ])
  })

  it('retries a 429 on either request after each delay', async () => {
    const refused = () => new Response(null, { status: 429 })
    const d = fakeFetch([refused(), tokenResponse(), refused(), headResponse(NODE_DIGEST)])
    await expect(mod.resolveEcrDigest(NODE_REF, { ...d, delays: [1, 2] })).resolves.toBe(
      NODE_DIGEST,
    )
    expect(d.sleep.mock.calls).toEqual([[1000], [1000]])
  })

  it('gives up on a HEAD refused past the last delay', async () => {
    const refused = () => new Response(null, { status: 429 })
    const d = fakeFetch([tokenResponse(), refused(), refused(), refused()])
    await expect(mod.resolveEcrDigest(NODE_REF, { ...d, delays: [1, 2] })).rejects.toThrow(
      /HEAD of .* with 429/,
    )
    expect(d.fetch).toHaveBeenCalledTimes(4)
  })

  it('fails at once on a refused token, without waiting', async () => {
    const d = fakeFetch([new Response(null, { status: 403 })])
    await expect(mod.resolveEcrDigest(NODE_REF, d)).rejects.toThrow(/token .* 403/)
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it.each([{}, { token: '' }, { token: 42 }])('fails on the token response %j', async (body) => {
    const d = fakeFetch([tokenResponse(body), headResponse(NODE_DIGEST)])
    await expect(mod.resolveEcrDigest(NODE_REF, d)).rejects.toThrow(/no token/)
    expect(d.fetch).toHaveBeenCalledTimes(1)
  })
})

// `docker info --format '{{json .DriverStatus}}'` from Docker 28.0.4 and 29.9, one per store.
const CLASSIC_STATUS =
  '[["Backing Filesystem","extfs"],["Supports d_type","true"],["Using metacopy","false"],["Native Overlay Diff","true"],["userxattr","false"]]'
const CONTAINERD_STATUS = '[["driver-type","io.containerd.snapshotter.v1"]]'

describe('platformFlags', () => {
  it('names the platform on the containerd store, where a tag names the whole index', () => {
    expect(mod.platformFlags(CONTAINERD_STATUS, 'linux/amd64')).toEqual([
      '--platform',
      'linux/amd64',
    ])
  })

  it('adds nothing on the classic store, whose Docker 28 refuses the flag on inspect', () => {
    expect(mod.platformFlags(CLASSIC_STATUS, 'linux/amd64')).toEqual([])
    expect(mod.platformFlags('null\n', 'linux/amd64')).toEqual([])
    expect(
      mod.platformFlags('[["Snapshotter hint","io.containerd.snapshotter.v1"]]', 'linux/amd64'),
    ).toEqual([])
  })

  it('throws on output it cannot read, rather than guess the store', () => {
    expect(() => mod.platformFlags('', 'linux/amd64')).toThrow()
    expect(() => mod.platformFlags('{"driver-type":"x"}', 'linux/amd64')).toThrow(/DriverStatus/)
  })
})

describe('checkImage', () => {
  const image = (over: Partial<InspectedImage> = {}) =>
    JSON.stringify({
      Id: 'sha256:id',
      Architecture: 'amd64',
      RepoDigests: [`mirror.gcr.io/library/node@${NODE_DIGEST}`],
      ...over,
    })

  it('passes an image for the architecture, with the id and the pull digest', () => {
    expect(
      mod.checkImage(image(), 'n', { arch: 'amd64', id: 'sha256:id', digest: NODE_DIGEST }),
    ).toBe('sha256:id')
  })

  it('refuses another architecture', () => {
    expect(() => mod.checkImage(image({ Architecture: 'arm64' }), 'n', { arch: 'amd64' })).toThrow(
      /arm64, not amd64/,
    )
  })

  it('refuses another image id', () => {
    expect(() => mod.checkImage(image(), 'n', { arch: 'amd64', id: 'sha256:other' })).toThrow(
      /not the verified/,
    )
  })

  it('refuses an image that no RepoDigest ties to the digest', () => {
    for (const RepoDigests of [
      [],
      [`mirror.gcr.io/library/node@${ADAPTER_DIGEST}`],
      [`x@${NODE_DIGEST}x`],
    ]) {
      expect(() =>
        mod.checkImage(image({ RepoDigests }), 'n', { arch: 'amd64', digest: NODE_DIGEST }),
      ).toThrow(/not pulled by/)
    }
  })
})

describe('seedBaseImages', () => {
  let dir: string
  let dockerfile: string
  let save: string
  let consoleSpy: MockConsole

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-seed-'))
    dockerfile = path.join(dir, 'Dockerfile')
    fs.writeFileSync(
      dockerfile,
      `FROM ${NODE_REF} AS b\nFROM ${NODE_REF}\nCOPY --from=${ADAPTER_REF} /a /a\nCOPY --from=b /x /x\n`,
    )
    save = path.join(dir, 'out', 'base-images.tar')
    consoleSpy = mockConsole()
  })

  afterEach(() => {
    consoleSpy.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** ECR's answers: a token, then the HEAD of each base, in Dockerfile order. */
  const ecr = (nodeDigest = NODE_DIGEST, adapterDigest = ADAPTER_DIGEST) => {
    const answers: Record<string, () => Response> = {
      'docker/library/node': () => headResponse(nodeDigest),
      'awsguru/aws-lambda-adapter': () =>
        headResponse(adapterDigest, 'application/vnd.docker.distribution.manifest.list.v2+json'),
    }
    return vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      if (init.method === 'GET')
        return new Response(JSON.stringify({ token: 't' }), { status: 200 })
      const repository = /\/v2\/(.+)\/manifests\//.exec(url)?.[1] ?? ''
      return answers[repository]()
    })
  }

  /**
   * A docker whose pulls by digest succeed from `serving` sources (each image for the pulled
   * platform unless `arch` overrides it), where `tag` copies an image and `save` writes the file.
   */
  const fakeDocker = ({
    serving = ['mirror.gcr.io/library/node', 'public.ecr.aws/awsguru/aws-lambda-adapter'],
    arch,
    retag = {} as Record<string, string>,
    saveStatus = 0,
    tagStatus = 0,
    driverStatus = CLASSIC_STATUS,
  }: {
    serving?: string[]
    arch?: string
    retag?: Record<string, string>
    saveStatus?: number
    tagStatus?: number
    driverStatus?: string
  } = {}) => {
    const flags = driverStatus === CONTAINERD_STATUS ? ['--platform'] : []
    const store = new Map<string, InspectedImage>()
    let pulledPlatform = ''
    const run = vi.fn((args: string[]): PullResult => {
      const [command] = args
      if (command === 'pull' && args[1] === '--platform' && args.length === 4) {
        const ref = args[3]
        pulledPlatform = args[2]
        if (!serving.includes(ref.split('@')[0])) return { status: 1, output: 'manifest unknown' }
        store.set(ref, {
          Id: `sha256:id-of-${ref}`,
          Architecture: arch ?? args[2].split('/')[1],
          RepoDigests: [ref],
        })
        return { status: 0, output: '' }
      }
      if (args.join(' ') === 'info --format {{json .DriverStatus}}') {
        return { status: 0, output: driverStatus }
      }
      const inspectAt = 2 + (flags.length && 2)
      if (
        args.slice(0, 2).join(' ') === 'image inspect' &&
        args.slice(2, inspectAt).join(' ') ===
          (flags.length ? `--platform ${pulledPlatform}` : '') &&
        args.slice(inspectAt, inspectAt + 2).join(' ') === '--format {{json .}}' &&
        args.length === inspectAt + 3
      ) {
        const image = store.get(args[inspectAt + 2])
        return image ? { status: 0, output: JSON.stringify(image) } : { status: 1, output: '' }
      }
      if (command === 'tag' && args.length === 3) {
        if (tagStatus !== 0) return { status: tagStatus, output: '' }
        const image = store.get(retag[args[2]] ?? args[1])
        if (!image) return { status: 1, output: '' }
        store.set(args[2], { ...image, RepoDigests: image.RepoDigests })
        return { status: 0, output: '' }
      }
      const saveAt = 1 + (flags.length && 2)
      if (
        command === 'save' &&
        args.slice(1, saveAt).join(' ') === (flags.length ? `--platform ${pulledPlatform}` : '') &&
        args[saveAt] === '-o'
      ) {
        fs.writeFileSync(
          args[saveAt + 1],
          saveStatus === 0 ? args.slice(saveAt + 2).join('\n') : 'partial',
        )
        return { status: saveStatus, output: '' }
      }
      throw new Error(`unexpected docker ${args.join(' ')}`)
    })
    const pulled = () => run.mock.calls.filter(([a]) => a[0] === 'pull').map(([a]) => a.slice(1))
    return { run, pulled, syncSleep: vi.fn((_ms: number) => {}) }
  }

  const seed = (docker: ReturnType<typeof fakeDocker>, fetch = ecr(), platform = 'linux/amd64') =>
    mod.seedBaseImages(dockerfile, {
      platform,
      save,
      fetch,
      sleep: async () => {},
      run: docker.run,
      syncSleep: docker.syncSleep,
    })

  it('pulls node from the mirror and the adapter from ECR, each by the digest ECR named', async () => {
    const d = fakeDocker()
    await expect(seed(d)).resolves.toEqual([
      { ref: NODE_REF, id: `sha256:id-of-mirror.gcr.io/library/node@${NODE_DIGEST}` },
      {
        ref: ADAPTER_REF,
        id: `sha256:id-of-public.ecr.aws/awsguru/aws-lambda-adapter@${ADAPTER_DIGEST}`,
      },
    ])
    expect(d.pulled()).toEqual([
      ['--platform', 'linux/amd64', `mirror.gcr.io/library/node@${NODE_DIGEST}`],
      ['--platform', 'linux/amd64', `public.ecr.aws/awsguru/aws-lambda-adapter@${ADAPTER_DIGEST}`],
    ])
    expect(d.run.mock.calls.filter(([a]) => a[0] === 'tag').map(([a]) => a.slice(1))).toEqual([
      [`mirror.gcr.io/library/node@${NODE_DIGEST}`, NODE_REF],
      [`public.ecr.aws/awsguru/aws-lambda-adapter@${ADAPTER_DIGEST}`, ADAPTER_REF],
    ])
    expect(fs.readFileSync(save, 'utf8')).toBe(`${NODE_REF}\n${ADAPTER_REF}`)
  })

  it('pulls the platform it is asked for', async () => {
    const d = fakeDocker()
    await seed(d, ecr(), 'linux/arm64')
    expect(d.pulled().map(([, platform]) => platform)).toEqual(['linux/arm64', 'linux/arm64'])
  })

  it('inspects and saves that platform by name on the containerd store', async () => {
    const d = fakeDocker({ driverStatus: CONTAINERD_STATUS })
    await seed(d, ecr(), 'linux/arm64')
    const named = d.run.mock.calls
      .map(([a]) => a)
      .filter((a) => a[0] === 'save' || a[1] === 'inspect')
    expect(named).toHaveLength(5)
    expect(named.every((a) => a.join(' ').includes('--platform linux/arm64'))).toBe(true)
    expect(fs.readFileSync(save, 'utf8')).toBe(`${NODE_REF}\n${ADAPTER_REF}`)
  })

  it('saves nothing when docker info fails', async () => {
    const d = fakeDocker()
    const run = vi.fn((args: string[]) =>
      args[0] === 'info' ? { status: 1, output: '' } : d.run(args),
    )
    await expect(seed({ ...d, run })).rejects.toThrow(/docker info/)
    expect(fs.existsSync(save)).toBe(false)
  })

  it('falls back to Docker Hub when the mirror lacks the digest', async () => {
    const d = fakeDocker({
      serving: ['docker.io/library/node', 'public.ecr.aws/awsguru/aws-lambda-adapter'],
    })
    await seed(d)
    expect(d.pulled().map(([, , ref]) => ref)).toEqual([
      `mirror.gcr.io/library/node@${NODE_DIGEST}`,
      `docker.io/library/node@${NODE_DIGEST}`,
      `public.ecr.aws/awsguru/aws-lambda-adapter@${ADAPTER_DIGEST}`,
    ])
    expect(fs.existsSync(save)).toBe(true)
  })

  it('saves nothing when no source has the digest', async () => {
    const d = fakeDocker({ serving: ['public.ecr.aws/awsguru/aws-lambda-adapter'] })
    await expect(seed(d)).rejects.toThrow(/no source had/)
    expect(fs.existsSync(save)).toBe(false)
    expect(d.run.mock.calls.some(([a]) => a[0] === 'save')).toBe(false)
  })

  it('saves nothing, and pulls nothing, when ECR names no digest', async () => {
    const d = fakeDocker()
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'GET'
        ? new Response(JSON.stringify({ token: 't' }), { status: 200 })
        : new Response(null, { status: 404 }),
    )
    await expect(seed(d, fetch)).rejects.toThrow(/with 404/)
    expect(d.pulled()).toEqual([])
    expect(fs.existsSync(save)).toBe(false)
  })

  it("saves nothing when a later base's digest cannot be read", async () => {
    const d = fakeDocker()
    await expect(seed(d, ecr(NODE_DIGEST, 'sha256:short'))).rejects.toThrow(/sha256 digest/)
    expect(fs.existsSync(save)).toBe(false)
  })

  it('saves nothing when a pulled image is for another architecture', async () => {
    const d = fakeDocker({ arch: 'arm64' })
    await expect(seed(d)).rejects.toThrow(/arm64, not amd64/)
    expect(fs.existsSync(save)).toBe(false)
  })

  it('saves nothing when a tag no longer names the verified image', async () => {
    const d = fakeDocker({
      retag: { [ADAPTER_REF]: `mirror.gcr.io/library/node@${NODE_DIGEST}` },
    })
    await expect(seed(d)).rejects.toThrow(/not the verified/)
    expect(d.run.mock.calls.some(([a]) => a[0] === 'save')).toBe(false)
  })

  it('leaves no tar when the save fails part-way', async () => {
    const d = fakeDocker({ saveStatus: 1 })
    await expect(seed(d)).rejects.toThrow(/docker save/)
    expect(fs.existsSync(save)).toBe(false)
  })

  it('saves nothing when a tag fails', async () => {
    const d = fakeDocker({ tagStatus: 1 })
    await expect(seed(d)).rejects.toThrow(/docker tag/)
    expect(d.run.mock.calls.some(([a]) => a[0] === 'save')).toBe(false)
  })

  it('refuses a platform before asking ECR anything', async () => {
    const d = fakeDocker()
    const fetch = ecr()
    await expect(seed(d, fetch, 'linux/arm/v7')).rejects.toThrow(/--platform/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
