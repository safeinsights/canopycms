import path from 'node:path'
import type { CanopyConfig } from '../config'
import { DEFAULT_PROD_WORKSPACE } from '../config'

/**
 * Get the task queue directory for async worker operations.
 *
 * In prod mode: {CANOPYCMS_WORKSPACE_ROOT}/.tasks
 * In dev mode: {cwd}/.canopy-dev/.tasks
 */
export function getTaskQueueDir(config: Pick<CanopyConfig, 'mode'>): string {
  switch (config.mode) {
    case 'prod': {
      const workspace = process.env.CANOPYCMS_WORKSPACE_ROOT ?? DEFAULT_PROD_WORKSPACE
      return path.join(path.resolve(workspace), '.tasks')
    }
    case 'dev': {
      return path.join(process.cwd(), '.canopy-dev', '.tasks')
    }
  }
}
