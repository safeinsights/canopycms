import { describe, it, expect } from 'vitest'
import { parseArgs, resolveSyncDirection } from './cli'

describe('parseArgs', () => {
  it('parses command as first positional arg', () => {
    const { command } = parseArgs(['init'])
    expect(command).toBe('init')
  })

  it('returns undefined command when no args', () => {
    const { command } = parseArgs([])
    expect(command).toBeUndefined()
  })

  it('parses boolean flags', () => {
    const { flags } = parseArgs(['sync', '--push', '--force'])
    expect(flags['push']).toBe(true)
    expect(flags['force']).toBe(true)
  })

  it('parses string flags', () => {
    const { flags } = parseArgs(['sync', '--branch', 'feat-x', '--content-root', 'docs'])
    expect(flags['branch']).toBe('feat-x')
    expect(flags['content-root']).toBe('docs')
  })

  it('supports -f alias for --force', () => {
    const { flags } = parseArgs(['init', '-f'])
    expect(flags['force']).toBe(true)
  })

  it('parses sub-positional args', () => {
    const { argv } = parseArgs(['init-deploy', 'aws'])
    expect(argv._[1]).toBe('aws')
  })

  it('parses init flags together', () => {
    const { command, flags } = parseArgs([
      'init',
      '--non-interactive',
      '--no-ai',
      '--app-dir',
      'src',
    ])
    expect(command).toBe('init')
    expect(flags['non-interactive']).toBe(true)
    // minimist treats --no-X as a negation: sets ai=false (not no-ai=true)
    expect(flags['ai']).toBe(false)
    expect(flags['no-ai']).toBe(false)
    expect(flags['app-dir']).toBe('src')
  })

  it('parses generate-ai-content flags', () => {
    const { command, flags } = parseArgs([
      'generate-ai-content',
      '--output',
      'public/ai',
      '--config',
      'ai.config.ts',
    ])
    expect(command).toBe('generate-ai-content')
    expect(flags['output']).toBe('public/ai')
    expect(flags['config']).toBe('ai.config.ts')
  })
})

describe('resolveSyncDirection', () => {
  it('returns push when only --push is set', () => {
    expect(resolveSyncDirection(true, false)).toBe('push')
  })

  it('returns pull when only --pull is set', () => {
    expect(resolveSyncDirection(false, true)).toBe('pull')
  })

  it('returns both when neither flag is set', () => {
    expect(resolveSyncDirection(false, false)).toBe('both')
  })

  it('returns both when both flags are set', () => {
    expect(resolveSyncDirection(true, true)).toBe('both')
  })
})
