import { describe, it, expect } from 'vitest'
import {
  getErrorMessage,
  isNodeError,
  isNotFoundError,
  isPermissionError,
  redactCredentials,
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

    it('redacts absolute paths directly after a colon, comma, or bracket', () => {
      expect(sanitizeErrorMessage('lock held:/mnt/efs/workspace/main')).toBe('lock held:<path>')
      expect(sanitizeErrorMessage('copied x.txt,/mnt/backup/x.txt')).toBe('copied x.txt,<path>')
      // The closing bracket is swallowed by the greedy trailing segment —
      // over-redaction is the safe direction here.
      expect(sanitizeErrorMessage('at [/mnt/efs/workspace/main]')).toBe('at [<path>')
    })

    it('still keeps credential-free URL slashes untouched with the wider boundary', () => {
      const msg = 'cloning https://github.com/org/repo.git'
      expect(sanitizeErrorMessage(msg)).toBe(msg)
    })

    it('redacts bare GitHub token shapes outside URL userinfo', () => {
      const msg = 'auth failed for token ghp_abcdefghijklmnop1234'
      expect(sanitizeErrorMessage(msg)).toBe('auth failed for token ***')
    })

    it('redacts Bearer tokens', () => {
      const msg = 'header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig rejected'
      expect(sanitizeErrorMessage(msg)).toBe('header Authorization: Bearer *** rejected')
    })
  })

  describe('redactCredentials', () => {
    it('redacts URL credentials but keeps filesystem paths', () => {
      const msg =
        'push https://x-access-token:ghp_secret9876543210@github.com/org/repo.git failed in /mnt/efs/workspace/main'
      expect(redactCredentials(msg)).toBe(
        'push https://***@github.com/org/repo.git failed in /mnt/efs/workspace/main',
      )
    })

    it('redacts bare token shapes but keeps everything else', () => {
      const msg = "remote rejected github_pat_11ABCDEFG0123456789 for '/mnt/efs/clone'"
      expect(redactCredentials(msg)).toBe("remote rejected *** for '/mnt/efs/clone'")
    })

    it('leaves ordinary messages untouched', () => {
      const msg = "base branch 'fix/thing' does not exist at /mnt/efs/workspace"
      expect(redactCredentials(msg)).toBe(msg)
    })

    // GitHub App auth puts two new credential shapes into worker error text,
    // and `task.error` / worker-status.json are served to a browser by the
    // admin panel. Each case below asserts what SURVIVES as well as what is
    // gone -- an absence check alone passes vacuously on an empty result.
    it('redacts a PKCS#1 private-key block, keeping the surrounding message', () => {
      const msg = [
        'failed to sign JWT with key',
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy',
        'vGZlGJpmn65+A4xHXInJYiPuKzrKUnApeLZ+vw1HocOAZtWK0z3r26uA8kQYOKX9',
        '-----END RSA PRIVATE KEY-----',
        'for app 12345',
      ].join('\n')

      const redacted = redactCredentials(msg)

      expect(redacted).toContain('failed to sign JWT with key')
      expect(redacted).toContain('for app 12345')
      expect(redacted).toContain('<private-key>')
      expect(redacted).not.toContain('MIIEowIBAAKCAQEA')
      expect(redacted).not.toContain('BEGIN RSA PRIVATE KEY')
    })

    it('redacts a PKCS#8 block too, and one truncated mid-key', () => {
      const labelled = redactCredentials(
        'key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----',
      )
      expect(labelled).toBe('key: <private-key>')

      // No END footer: a message cut off mid-key must not pass the body
      // through just because the terminator never arrived.
      const truncated = redactCredentials(
        'key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAy8Dbv8prpJ',
      )
      expect(truncated).toBe('key: <private-key>')
    })

    it('redacts a bare JWT, keeping the surrounding message', () => {
      const jwt =
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE2MDAwMDAwMDAsImlzcyI6IjEyMzQ1In0.c2lnbmF0dXJlLWJ5dGVz'
      const msg = `POST /app/installations/42/access_tokens failed: token ${jwt} is invalid`

      const redacted = redactCredentials(msg)

      expect(redacted).toBe('POST /app/installations/42/access_tokens failed: token *** is invalid')
      expect(redacted).not.toContain('eyJhbGciOiJSUzI1NiI')
    })

    it('does not mistake ordinary dotted words for a JWT', () => {
      const msg = 'no such file: config.settings.json'
      expect(redactCredentials(msg)).toBe(msg)
    })
  })
})
