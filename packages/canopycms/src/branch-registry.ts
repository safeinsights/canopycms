import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchState } from './types'

const REGISTRY_DIR = '.canopycms'
const REGISTRY_FILE = 'branches.json'
const REGISTRY_VERSION = 1

export interface BranchRegistrySnapshot {
  version: number
  branches: BranchState[]
}

export class BranchRegistry {
  private readonly root: string
  private readonly registryPath: string

  constructor(root: string) {
    this.root = path.resolve(root)
    this.registryPath = path.join(this.root, REGISTRY_DIR, REGISTRY_FILE)
  }

  private async read(): Promise<BranchRegistrySnapshot> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8')
      const parsed = JSON.parse(raw) as BranchRegistrySnapshot
      if (!parsed.version || !Array.isArray(parsed.branches)) {
        throw new Error('Invalid registry format')
      }
      return parsed
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return { version: REGISTRY_VERSION, branches: [] }
      }
      throw err
    }
  }

  private async write(snapshot: BranchRegistrySnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true })
    await fs.writeFile(this.registryPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  }

  async list(): Promise<BranchState[]> {
    const snapshot = await this.read()
    return snapshot.branches
  }

  async get(name: string): Promise<BranchState | undefined> {
    const snapshot = await this.read()
    return snapshot.branches.find((b) => b.branch.name === name)
  }

  async upsert(state: BranchState): Promise<void> {
    const snapshot = await this.read()
    const existingIndex = snapshot.branches.findIndex((b) => b.branch.name === state.branch.name)
    if (existingIndex >= 0) {
      snapshot.branches[existingIndex] = state
    } else {
      snapshot.branches.push(state)
    }
    await this.write(snapshot)
  }

  async remove(name: string): Promise<void> {
    const snapshot = await this.read()
    const filtered = snapshot.branches.filter((b) => b.branch.name !== name)
    if (filtered.length !== snapshot.branches.length) {
      await this.write({ ...snapshot, branches: filtered })
    }
  }
}
