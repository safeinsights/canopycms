import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CANOPYCMS_VERSION } from './version'

describe('CANOPYCMS_VERSION', () => {
  it("equals the package manifest's version", () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'))
    expect(CANOPYCMS_VERSION).toBe(manifest.version)
  })
})
