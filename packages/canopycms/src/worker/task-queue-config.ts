import path from 'node:path'
import type { CanopyConfig } from '../config'

const DEFAULT_PROD_WORKSPACE = '/mnt/efs/workspace'

/**
 * Get the task queue directory for async worker operations.
 * Returns null if the mode doesn't support task queuing (e.g., dev mode).
 *
 * In prod mode: {CANOPYCMS_WORKSPACE_ROOT}/.tasks
 * In prod-sim mode: {cwd}/.canopy-prod-sim/.tasks
 * In dev mode: null (no task queue needed)
 */
export function getTaskQueueDir(config: Pick<CanopyConfig, 'mode'>): string | null {
  switch (config.mode) {
    case 'prod': {
      const workspace = process.env.CANOPYCMS_WORKSPACE_ROOT ?? DEFAULT_PROD_WORKSPACE
      return path.join(path.resolve(workspace), '.tasks')
    }
    case 'prod-sim': {
      return path.join(process.cwd(), '.canopy-prod-sim', '.tasks')
    }
    case 'dev':
      return null
  }
}
