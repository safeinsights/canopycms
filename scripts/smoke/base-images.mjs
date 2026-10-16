#!/usr/bin/env node

/**
 * Puts a Dockerfile's base images in the local image store, where `docker build` (without
 * `--pull`, on the classic or the containerd store) resolves them without asking the registry.
 * public.ecr.aws refuses anonymous pulls with `429 toomanyrequests` once an IP has used its data
 * quota, and GitHub-hosted runners share IPs, so CI loads the bases from a tar that
 * .github/workflows/cms-base-images.yml caches on main with `--dockerfile <path> --save <tar>`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** A refusal for quota or rate, the only pull failure retried, after each delay in seconds. */
export const PULL_REFUSED = /\btoomanyrequests\b/
export const PULL_RETRY_DELAYS_S = [20, 60]

/** Each image a `FROM` or `--from=` names, once, skipping `scratch` and earlier stages. */
export function baseImageRefs(dockerfile) {
  const stages = new Set(['scratch'])
  const refs = []
  const add = (ref) => {
    if (stages.has(ref.toLowerCase()) || refs.includes(ref)) return
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
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function dockerPull(ref) {
  console.log(`[base-images] $ docker pull ${ref}`)
  const result = docker(['pull', ref])
  process.stdout.write(result.output)
  return result
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function log(message) {
  console.log(`[base-images] ${message}`)
}

/**
 * Loads `tar` if it exists, then pulls each base the store lacks, so a tar saved for an older
 * Dockerfile is safe to load. `refresh` pulls every base instead.
 */
export function ensureBaseImages(dockerfilePath, { tar, refresh = false } = {}) {
  const refs = baseImageRefs(readFileSync(dockerfilePath, 'utf8'))
  if (tar && !refresh && existsSync(tar)) {
    log(`$ docker load -i ${tar}`)
    const loaded = docker(['load', '-i', tar], { capture: false })
    if (loaded.status !== 0) log(`could not load ${tar}; pulling the bases instead`)
  }
  const missing = refresh
    ? refs
    : refs.filter((ref) => docker(['image', 'inspect', '--format', '{{.Id}}', ref]).status !== 0)
  log(`bases: ${refs.join(', ')}; pulling: ${missing.length > 0 ? missing.join(', ') : 'none'}`)
  for (const ref of missing) pullWithRetry(ref, { pull: dockerPull, sleep: sleepSync, log })
  return refs
}

function main() {
  const { values } = parseArgs({
    options: { dockerfile: { type: 'string' }, save: { type: 'string' } },
  })
  if (!values.dockerfile || !values.save) {
    throw new Error('usage: base-images.mjs --dockerfile <path> --save <tar>')
  }
  const refs = ensureBaseImages(values.dockerfile, { refresh: true })
  mkdirSync(path.dirname(path.resolve(values.save)), { recursive: true })
  log(`$ docker save -o ${values.save} ${refs.join(' ')}`)
  const saved = docker(['save', '-o', values.save, ...refs], { capture: false })
  if (saved.status !== 0) throw new Error(`\`docker save\` exited with status ${saved.status}`)
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main()
  } catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
