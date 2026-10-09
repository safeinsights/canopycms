/**
 * The entry schema registry the serving editor was built with, recorded beside the branch
 * directories for the worker, which has no adopter config. The worker's git sync holds the base
 * branch while incoming content names a schema this record lacks (worker/schema-gate.ts), so a
 * merge that adds a schema and content using it waits for the image carrying the schema.
 *
 * Last write wins, which tracks the serving image: each process records once, at its first API
 * request, and only the newest image's processes start after a deploy. An old image starting
 * during the rollout leaves the record behind, and the gate then holds until the next new-image
 * start, the safe direction.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { readsFromCheckout } from './build-mode'
import { getBuildIdentity, type BuildIdentity } from './build-identity'
import type { CanopyConfig } from './config'
import { operatingStrategy } from './operating-mode'
import { registryFingerprint } from './schema/registry-fingerprint'
import type { EntrySchemaRegistry } from './schema/types'
import { getErrorMessage, isNodeError } from './utils/error'
import { canopyLogWarn } from './utils/logger'

/** @internal Exported for tests. */
export const SCHEMA_REGISTRY_RECORD = '.schema-registry.json'

export interface SchemaRegistryRecord {
  version: 1
  /** The registry's keys, sorted: the names a `.collection.json` entry type may reference. */
  schemas: string[]
  /** `registryFingerprint` of the registry, the key the branch schema cache is stored under. */
  fingerprint: string
  /** Content root relative to the repository root, as the editor resolves it. */
  contentRoot: string
  build: BuildIdentity
  recordedAt: string
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isBuildIdentity(value: unknown): value is BuildIdentity {
  if (typeof value !== 'object' || value === null) return false
  if (!('canopycmsVersion' in value) || typeof value.canopycmsVersion !== 'string') return false
  return !('sourceRevision' in value) || typeof value.sourceRevision === 'string'
}

/** The record, or undefined when none is recorded or it does not parse. */
export async function readSchemaRegistryRecord(
  contentBranchesRoot: string,
): Promise<SchemaRegistryRecord | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(contentBranchesRoot, SCHEMA_REGISTRY_RECORD), 'utf8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return undefined
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  if (!('version' in parsed) || parsed.version !== 1) return undefined
  if (!('schemas' in parsed) || !isStringArray(parsed.schemas)) return undefined
  if (!('fingerprint' in parsed) || typeof parsed.fingerprint !== 'string') return undefined
  if (!('contentRoot' in parsed) || typeof parsed.contentRoot !== 'string') return undefined
  if (!('build' in parsed) || !isBuildIdentity(parsed.build)) return undefined
  if (!('recordedAt' in parsed) || typeof parsed.recordedAt !== 'string') return undefined
  return {
    version: 1,
    schemas: parsed.schemas,
    fingerprint: parsed.fingerprint,
    contentRoot: parsed.contentRoot,
    build: parsed.build,
    recordedAt: parsed.recordedAt,
  }
}

function sameRecord(
  a: SchemaRegistryRecord,
  b: Omit<SchemaRegistryRecord, 'version' | 'recordedAt'>,
): boolean {
  return (
    a.fingerprint === b.fingerprint &&
    a.contentRoot === b.contentRoot &&
    a.build.canopycmsVersion === b.build.canopycmsVersion &&
    a.build.sourceRevision === b.build.sourceRevision
  )
}

/**
 * Record `schemas` unless the record already says the same, by temp file and rename. Does not
 * create the branches root: a deployment without one has no worker syncing into it.
 * @internal Exported for tests; `recordServedSchemaRegistry` is the caller.
 */
export async function recordSchemaRegistry(
  contentBranchesRoot: string,
  entry: {
    schemas: readonly string[]
    fingerprint: string
    contentRoot: string
    build: BuildIdentity
  },
): Promise<void> {
  const next = { ...entry, schemas: [...entry.schemas].sort() }
  const current = await readSchemaRegistryRecord(contentBranchesRoot)
  if (current && sameRecord(current, next)) return
  const record: SchemaRegistryRecord = {
    version: 1,
    ...next,
    recordedAt: new Date().toISOString(),
  }
  const target = path.join(contentBranchesRoot, SCHEMA_REGISTRY_RECORD)
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fs.writeFile(temp, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    throw err
  }
  try {
    await fs.rename(temp, target)
  } catch (err) {
    await fs.unlink(temp).catch(() => {})
    throw err
  }
}

/**
 * Record the registry this process serves, once per process start. A process with an empty
 * registry speaks for no editor (a config-only handler resolves no schema at all), so it records
 * nothing rather than make the worker hold every new reference. Best-effort: a failure is logged.
 */
export async function recordServedSchemaRegistry(
  config: CanopyConfig,
  registry: EntrySchemaRegistry,
): Promise<void> {
  try {
    if (readsFromCheckout(config)) return
    const schemas = Object.keys(registry)
    if (schemas.length === 0) return
    await recordSchemaRegistry(
      operatingStrategy(config.mode).getContentBranchesRoot(config.sourceRoot),
      {
        schemas,
        fingerprint: registryFingerprint(registry),
        contentRoot: config.contentRoot || 'content',
        build: getBuildIdentity(),
      },
    )
  } catch (err: unknown) {
    canopyLogWarn(`[canopy] Could not record the entry schema registry: ${getErrorMessage(err)}`)
  }
}
