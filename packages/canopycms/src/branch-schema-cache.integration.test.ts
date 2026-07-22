/**
 * Process-boundary smoke test for the GIT-M2 concurrency epic (PR C):
 * proves the resource-generation.ts marker protocol actually crosses a real
 * process boundary, not just in-process mocks. A genuinely separate `node`
 * process mutates the branch's schema and bumps the on-disk generation
 * marker (plain fs, no CanopyCMS imports — the marker is just a file), and
 * the parent process's BranchSchemaCache must observe the change on its next
 * getSchema() call. This is the scenario several warm Lambda containers plus
 * the EC2 worker sharing branch clones on EFS are meant to handle.
 *
 * Deliberately spawns plain `node -e <script>` rather than going through tsx
 * (see cli/init.integration.test.ts for the tsx-spawn convention used
 * elsewhere) — the child only needs to write two files, so keeping it to
 * built-in fs/crypto avoids tsx and its sandbox-EPERM flakiness entirely.
 */
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { BranchSchemaCache } from './branch-schema-cache'
import type { FieldConfig } from './config'

const execFileAsync = promisify(execFile)

describe('BranchSchemaCache process-boundary smoke test', () => {
  it('observes a schema change + marker bump made by a separate node process', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-cache-proc-'))
    try {
      const branchRoot = path.join(tempDir, 'branch-workspace')
      const contentRoot = path.join(branchRoot, 'content')
      await fs.mkdir(contentRoot, { recursive: true })

      const collectionPath = path.join(contentRoot, '.collection.json')
      await fs.writeFile(
        collectionPath,
        JSON.stringify({
          label: 'Root',
          entries: [{ name: 'page', format: 'md', schema: 'pageSchema' }],
          order: [],
        }),
        'utf-8',
      )

      const entrySchemaRegistry: Record<string, readonly FieldConfig[]> = {
        pageSchema: [{ name: 'title', type: 'string', label: 'Title' }],
      }

      // Parent: warm the cache in prod mode (no mtime walk backstop available —
      // this must work off the marker alone).
      const cache = new BranchSchemaCache('prod')
      const warm = await cache.getSchema(branchRoot, entrySchemaRegistry)
      expect(warm.schema.label).toBe('Root')

      const markerPath = path.join(branchRoot, '.canopy-meta', 'schema.generation')

      // Child process: mutate the schema and bump the marker via temp-file +
      // rename, exactly as bumpResourceGeneration does — but with plain
      // node/fs so this child needs no CanopyCMS source imports.
      const script = `
        const fs = require('node:fs');
        const path = require('node:path');
        const crypto = require('node:crypto');

        const collectionPath = ${JSON.stringify(collectionPath)};
        const markerPath = ${JSON.stringify(markerPath)};

        const meta = JSON.parse(fs.readFileSync(collectionPath, 'utf-8'));
        meta.label = 'Changed by child process';
        fs.writeFileSync(collectionPath, JSON.stringify(meta), 'utf-8');

        const token = crypto.randomUUID();
        const tmpPath = markerPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);
        fs.writeFileSync(tmpPath, token, 'utf-8');
        fs.renameSync(tmpPath, markerPath);
      `

      await execFileAsync('node', ['-e', script], { timeout: 15_000 })

      // Parent: next getSchema() must observe the child's bump and re-resolve.
      const result = await cache.getSchema(branchRoot, entrySchemaRegistry)
      expect(result.schema.label).toBe('Changed by child process')
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
