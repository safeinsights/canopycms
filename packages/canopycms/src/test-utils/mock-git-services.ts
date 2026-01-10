import { vi } from 'vitest'
import type { CanopyServices } from '../services'

/**
 * Create mock git service methods for testing.
 * Returns vi.fn() mocks for commitFiles and submitBranch.
 */
export function createMockGitServices(): Pick<CanopyServices, 'commitFiles' | 'submitBranch'> {
  return {
    commitFiles: vi.fn(),
    submitBranch: vi.fn(),
  }
}
