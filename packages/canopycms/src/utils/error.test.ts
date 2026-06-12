import { describe, it, expect } from 'vitest'
import {
  getErrorMessage,
  isNodeError,
  isNotFoundError,
  isPermissionError,
  sanitizeErrorMessage,
} from './error'

describe('error utilities', () => {
  describe('getErrorMessage', () => {
    it('extracts message from Error instances', () => {
      const err = new Error('Something went wrong')
      expect(getErrorMessage(err)).toBe('Something went wrong')
    })

    it('returns string errors as-is', () => {
      expect(getErrorMessage('Plain string error')).toBe('Plain string error')
    })

    it('converts numbers to strings', () => {
      expect(getErrorMessage(404)).toBe('404')
    })

    it('converts null to string', () => {
      expect(getErrorMessage(null)).toBe('null')
    })

    it('converts undefined to string', () => {
      expect(getErrorMessage(undefined)).toBe('undefined')
    })

    it('converts objects to string', () => {
      expect(getErrorMessage({ code: 'ERR' })).toBe('[object Object]')
    })
  })

  describe('isNodeError', () => {
    it('returns true for errors with code property', () => {
      const err = Object.assign(new Error('Not found'), { code: 'ENOENT' })
      expect(isNodeError(err)).toBe(true)
    })

    it('returns false for plain Error without code', () => {
      const err = new Error('Plain error')
      expect(isNodeError(err)).toBe(false)
    })

    it('returns false for non-Error objects with code', () => {
      const err = { code: 'ENOENT', message: 'Not found' }
      expect(isNodeError(err)).toBe(false)
    })

    it('returns false for strings', () => {
      expect(isNodeError('ENOENT')).toBe(false)
    })

    it('returns false for null', () => {
      expect(isNodeError(null)).toBe(false)
    })
  })

  describe('isNotFoundError', () => {
    it('returns true for ENOENT errors', () => {
      const err = Object.assign(new Error('Not found'), { code: 'ENOENT' })
      expect(isNotFoundError(err)).toBe(true)
    })

    it('returns false for other error codes', () => {
      const err = Object.assign(new Error('Permission denied'), {
        code: 'EACCES',
      })
      expect(isNotFoundError(err)).toBe(false)
    })

    it('returns false for errors without code', () => {
      expect(isNotFoundError(new Error('Not found'))).toBe(false)
    })
  })

  describe('isPermissionError', () => {
    it('returns true for EACCES errors', () => {
      const err = Object.assign(new Error('Permission denied'), {
        code: 'EACCES',
      })
      expect(isPermissionError(err)).toBe(true)
    })

    it('returns false for other error codes', () => {
      const err = Object.assign(new Error('Not found'), { code: 'ENOENT' })
      expect(isPermissionError(err)).toBe(false)
    })

    it('returns false for errors without code', () => {
      expect(isPermissionError(new Error('Permission denied'))).toBe(false)
    })
  })

  describe('sanitizeErrorMessage', () => {
    it('redacts credentials embedded in URLs', () => {
      const msg = 'failed to fetch https://x-access-token:ghp_abc123@github.com/org/repo.git'
      expect(sanitizeErrorMessage(msg)).toBe('failed to fetch https://***@github.com/org/repo.git')
    })

    it('redacts userless token credentials in URLs', () => {
      const msg = 'push to https://ghp_abc123@github.com/org/repo.git failed'
      expect(sanitizeErrorMessage(msg)).toBe('push to https://***@github.com/org/repo.git failed')
    })

    it('keeps credential-free URLs intact', () => {
      const msg = 'cloning https://github.com/org/repo.git'
      expect(sanitizeErrorMessage(msg)).toBe(msg)
    })

    it('relativizes paths under the current working directory', () => {
      const msg = `cannot lock ${process.cwd()}/.canopy-dev/remote.git`
      expect(sanitizeErrorMessage(msg)).toBe('cannot lock .canopy-dev/remote.git')
    })

    it('replaces the bare cwd itself with a dot', () => {
      const msg = `not a git repository: ${process.cwd()}`
      expect(sanitizeErrorMessage(msg)).toBe('not a git repository: .')
    })

    it('fully redacts sibling paths that share the cwd prefix', () => {
      const msg = `error in ${process.cwd()}-other/secret/file.txt here`
      expect(sanitizeErrorMessage(msg)).toBe('error in <path> here')
    })

    it('redacts quoted absolute paths even when they contain spaces', () => {
      const msg = "destination path '/Users/bob/My Documents/repo' already exists"
      expect(sanitizeErrorMessage(msg)).toBe("destination path '<path>' already exists")
    })

    it('only redacts unquoted spaced paths up to the first space (known limitation)', () => {
      const msg = 'cannot open /Users/bob/My Documents/repo/file.txt now'
      expect(sanitizeErrorMessage(msg)).toBe('cannot open <path> Documents/repo/file.txt now')
    })

    it('redacts absolute paths outside the working directory', () => {
      const msg = "destination path '/mnt/efs/workspace/main' already exists"
      expect(sanitizeErrorMessage(msg)).toBe("destination path '<path>' already exists")
    })

    it('redacts Windows drive paths', () => {
      const msg = 'cannot open C:\\Users\\bob\\repo\\file.txt here'
      expect(sanitizeErrorMessage(msg)).toBe('cannot open <path> here')
    })

    it('leaves branch names with slashes alone', () => {
      const msg = "base branch 'fix/unify-base-branch-resolution' does not exist locally"
      expect(sanitizeErrorMessage(msg)).toBe(msg)
    })
  })
})
