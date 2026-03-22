import { describe, it, expect } from 'vitest'
import { getErrorMessage, isNodeError, isNotFoundError, isPermissionError } from './error'

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
})
