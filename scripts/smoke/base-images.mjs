#!/usr/bin/env node

/**
 * Puts a Dockerfile's base images in the local image store, where `docker build` (without
 * `--pull`, on the classic or the containerd store) resolves them without asking the registry.
 * public.ecr.aws refuses anonymous pulls with `429 toomanyrequests` once an IP has used its data
 * quota, and GitHub-hosted runners share IPs, so CI loads the bases from a tar that
 * .github/workflows/cms-base-images.yml caches on main (seedBaseImages).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// The registry's refusal, the only pull failure retried, after each delay in seconds. A rate
// refusal clears that fast; a data-quota refusal, the one CI meets, rarely does.
export const PULL_REFUSED = /\btoomanyrequests\b/
export const PULL_RETRY_DELAYS_S = [20, 60]

/** Each image a `FROM` or `--from=` names, once, skipping `scratch` and stages by name or index. */
export function baseImageRefs(dockerfile) {
  const stages = new Set(['scratch'])
  const refs = []
  const add = (ref) => {
    if (/^\d+$/.test(ref) || stages.has(ref.toLowerCase()) || refs.includes(ref)) return
    if (ref.includes('$'))
      throw new Error(`cannot pre-pull a base image named by a variable: ${ref}`)
    refs.push(ref)
  }
  for (const line of dockerfile.split('\n')) {
    const words = line.trim().split(/\s+/)
    const instruction = words[0].toUpperCase()
    if (instruction === 'FROM') {
      const [ref, as, stage] = words.slice(1).filter((word) => !word.startsWith('--'))
      if (ref) add(ref)
      if (as?.toUpperCase() === 'AS' && stage) stages.add(stage.toLowerCase())
    } else if (instruction === 'COPY' || instruction === 'ADD') {
      const from = words.find((word) => word.startsWith('--from='))
      if (from) add(from.slice('--from='.length))
    }
  }
  return refs
}

/** Pull `ref`, retrying a refusal while a delay remains; any other failure throws at once. */
export function pullWithRetry(ref, { pull, sleep, log, delays = PULL_RETRY_DELAYS_S }) {
  for (let attempt = 0; ; attempt++) {
    const { status, output } = pull(ref)
    if (status === 0) return attempt + 1
    const delay = PULL_REFUSED.test(output) ? delays[attempt] : undefined
    if (delay === undefined) throw new Error(`\`docker pull ${ref}\` exited with status ${status}`)
    log(`the registry refused the pull of ${ref} (toomanyrequests); retrying in ${delay}s`)
    sleep(delay * 1000)
  }
}

function docker(args, { capture = true } = {}) {
  const result = spawnSync('docker', args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  const stdout = result.stdout ?? ''
  return { status: result.status, stdout, output: `${stdout}${result.stderr ?? ''}` }
}

function dockerPull(args, run) {
  log(`$ docker pull ${args.join(' ')}`)
  const result = run(['pull', ...args])
  if (result.output) console.log(result.output.trimEnd())
  return result
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(message) {
  console.log(`[base-images] ${message}`)
}

/**
 * Loads `tar` if it exists, then pulls each base the store lacks, so a tar saved for an older
 * Dockerfile is safe to load. `run` runs a docker command.
 */
export function ensureBaseImages(dockerfilePath, { tar, run = docker, sleep = sleepSync } = {}) {
  const refs = baseImageRefs(readFileSync(dockerfilePath, 'utf8'))
  if (tar && existsSync(tar)) {
    log(`$ docker load -i ${tar}`)
    const loaded = run(['load', '-i', tar], { capture: false })
    if (loaded.status !== 0) log(`could not load ${tar}; pulling the bases instead`)
  }
  const missing = refs.filter(
    (ref) => run(['image', 'inspect', '--format', '{{.Id}}', ref]).status !== 0,
  )
  log(`bases: ${refs.join(', ')}; pulling: ${missing.length > 0 ? missing.join(', ') : 'none'}`)
  const pull = (ref) => dockerPull([ref], run)
  for (const ref of missing) pullWithRetry(ref, { pull, sleep, log })
  return refs
}

// Pulled by digest with `--platform`, an index pins every architecture's image at once.
export const INDEX_MEDIA_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]
const DIGEST = /^sha256:[0-9a-f]{64}$/
const ECR_REF = /^public\.ecr\.aws\/([a-z0-9][a-z0-9._/-]*):(\w[\w.-]{0,127})$/
const PATH_COMPONENT = /^[a-z0-9][a-z0-9._-]*$/
const PLATFORM = /^linux\/(amd64|arm64)$/

export function parseEcrRef(ref) {
  const match = ECR_REF.exec(ref)
  if (!match || !match[1].split('/').every((part) => PATH_COMPONENT.test(part))) {
    throw new Error(`the seed takes only tagged public.ecr.aws images: ${ref}`)
  }
  return { repository: match[1], tag: match[2] }
}

/** ECR's `docker/library/*` is Docker's official image, served by mirror.gcr.io and Docker Hub
 * under the same digest, so the seed pulls it from those; anything else only ECR has. */
export function pullSources(repository) {
  const official = /^docker\/library\/([^/]+)$/.exec(repository)
  if (!official) return [`public.ecr.aws/${repository}`]
  return [`mirror.gcr.io/library/${official[1]}`, `docker.io/library/${official[1]}`]
}

export function platformArch(platform) {
  const match = PLATFORM.exec(platform ?? '')
  if (!match) throw new Error(`--platform must be linux/amd64 or linux/arm64, got ${platform}`)
  return match[1]
}

/** The index digest a manifest HEAD answered with, or a throw for any other answer. */
export function indexDigestFrom(response, ref) {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim()
  const digest = response.headers.get('docker-content-digest') ?? ''
  if (response.status !== 200) {
    throw new Error(`public.ecr.aws answered the HEAD of ${ref} with ${response.status}`)
  }
  if (!INDEX_MEDIA_TYPES.includes(type)) {
    throw new Error(
      `public.ecr.aws answered the HEAD of ${ref} with ${type || 'no type'}, not an index`,
    )
  }
  if (!DIGEST.test(digest)) {
    throw new Error(`public.ecr.aws answered the HEAD of ${ref} without a sha256 digest`)
  }
  return digest
}

async function fetchWithRetry(url, init, { fetch, sleep, delays }) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init)
    const delay = response.status === 429 ? delays[attempt] : undefined
    if (delay === undefined) return response
    log(`public.ecr.aws refused ${init.method} ${url} (429); retrying in ${delay}s`)
    await sleep(delay * 1000)
  }
}

/**
 * The index digest ECR's tag `ref` names now, read with an anonymous token and a manifest HEAD.
 * Neither carries image data, and an IP whose data quota is spent still gets both answered: the
 * quota refuses its GETs, the manifest's included.
 */
export async function resolveEcrDigest(
  ref,
  { fetch = globalThis.fetch, sleep = sleepAsync, delays = PULL_RETRY_DELAYS_S } = {},
) {
  const { repository, tag } = parseEcrRef(ref)
  const deps = { fetch, sleep, delays }
  const tokenUrl = `https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository:${repository}:pull`
  const tokenResponse = await fetchWithRetry(tokenUrl, { method: 'GET', redirect: 'error' }, deps)
  if (tokenResponse.status !== 200) {
    throw new Error(`public.ecr.aws refused a token for ${ref} with ${tokenResponse.status}`)
  }
  const { token } = await tokenResponse.json()
  if (typeof token !== 'string' || token === '') {
    throw new Error(`public.ecr.aws gave no token for ${ref}`)
  }
  const manifestUrl = `https://public.ecr.aws/v2/${repository}/manifests/${tag}`
  const headers = { Accept: INDEX_MEDIA_TYPES.join(', '), Authorization: `Bearer ${token}` }
  return indexDigestFrom(
    await fetchWithRetry(manifestUrl, { method: 'HEAD', headers, redirect: 'error' }, deps),
    ref,
  )
}

/** Throws unless the inspected image is for `arch`, and is `id` and pulled by `digest` if given. */
export function checkImage(inspected, name, { arch, id, digest }) {
  const image = JSON.parse(inspected)
  if (image.Architecture !== arch) {
    throw new Error(`${name} is for ${image.Architecture}, not ${arch}`)
  }
  if (id !== undefined && image.Id !== id) {
    throw new Error(`${name} is ${image.Id}, not the verified ${id}`)
  }
  if (digest !== undefined && !(image.RepoDigests ?? []).some((rd) => rd.endsWith(`@${digest}`))) {
    throw new Error(`${name} was not pulled by ${digest}`)
  }
  return image.Id
}

/**
 * The flags `docker image inspect` and `docker save` need to act on `platform`'s image, given
 * `docker info --format '{{json .DriverStatus}}'`. On the containerd store a tag names the whole
 * index and both act on the daemon's own platform unless told another. The classic store holds one
 * platform per image, and Docker 28, which GitHub's runners have, refuses `--platform` on inspect.
 */
export function platformFlags(driverStatus, platform) {
  const status = JSON.parse(driverStatus)
  if (status !== null && !Array.isArray(status))
    throw new Error('unexpected docker info DriverStatus')
  const containerd = (status ?? []).some(
    ([key, value]) =>
      key === 'driver-type' && String(value).startsWith('io.containerd.snapshotter'),
  )
  return containerd ? ['--platform', platform] : []
}

function inspect(name, run, flags) {
  const result = run(['image', 'inspect', ...flags, '--format', '{{json .}}', name])
  if (result.status !== 0)
    throw new Error(`\`docker image inspect ${name}\` exited with status ${result.status}`)
  return result.stdout
}

/**
 * Saves `platform`'s copy of every base `dockerfilePath` names to `save`, each pulled by the index
 * digest ECR's tag names now and tagged with the reference the Dockerfile uses. A pull by digest
 * is content-addressed, so no source can substitute another image for ECR's. Any failure throws
 * and leaves no `save`, so the workflow saves no cache entry and the previous one stays newest.
 */
export async function seedBaseImages(
  dockerfilePath,
  {
    platform,
    save,
    run = docker,
    fetch = globalThis.fetch,
    sleep = sleepAsync,
    syncSleep = sleepSync,
  },
) {
  const arch = platformArch(platform)
  const refs = baseImageRefs(readFileSync(dockerfilePath, 'utf8'))
  const info = run(['info', '--format', '{{json .DriverStatus}}'])
  if (info.status !== 0) throw new Error(`\`docker info\` exited with status ${info.status}`)
  const flags = platformFlags(info.stdout, platform)
  const verified = []
  for (const ref of refs) {
    const digest = await resolveEcrDigest(ref, { fetch, sleep })
    log(`public.ecr.aws names ${ref} ${digest}`)
    const pinned = pullPinned(pullSources(parseEcrRef(ref).repository), digest, platform, {
      run,
      sleep: syncSleep,
    })
    const id = checkImage(inspect(pinned, run, flags), pinned, { arch, digest })
    const tagged = run(['tag', pinned, ref])
    if (tagged.status !== 0)
      throw new Error(`\`docker tag ${pinned} ${ref}\` exited with status ${tagged.status}`)
    verified.push({ ref, id })
  }
  for (const { ref, id } of verified) checkImage(inspect(ref, run, flags), ref, { arch, id })
  mkdirSync(path.dirname(path.resolve(save)), { recursive: true })
  const saveArgs = ['save', ...flags, '-o', save, ...refs]
  log(`$ docker ${saveArgs.join(' ')}`)
  const saved = run(saveArgs, { capture: false })
  if (saved.status !== 0) {
    rmSync(save, { force: true })
    throw new Error(`\`docker save\` exited with status ${saved.status}`)
  }
  return verified
}

/** Pulls `digest` for `platform` from the first of `sources` that has it; the pulled name. */
function pullPinned(sources, digest, platform, { run, sleep }) {
  for (const source of sources) {
    const pinned = `${source}@${digest}`
    try {
      pullWithRetry(pinned, {
        pull: (ref) => dockerPull(['--platform', platform, ref], run),
        sleep,
        log,
      })
      return pinned
    } catch (err) {
      log(`${err instanceof Error ? err.message : String(err)}; trying the next source`)
    }
  }
  throw new Error(`no source had ${digest} for ${platform}: ${sources.join(', ')}`)
}

async function main() {
  const { values } = parseArgs({
    options: {
      dockerfile: { type: 'string' },
      platform: { type: 'string' },
      save: { type: 'string' },
    },
  })
  if (!values.dockerfile || !values.platform || !values.save) {
    throw new Error('usage: base-images.mjs --dockerfile <path> --platform <os/arch> --save <tar>')
  }
  await seedBaseImages(values.dockerfile, { platform: values.platform, save: values.save })
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
