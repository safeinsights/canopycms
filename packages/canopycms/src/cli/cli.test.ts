import { describe, it, expect } from 'vitest'
import { parseArgs, resolveSyncSubcommand } from './cli'

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
    const { flags } = parseArgs(['sync', 'push', '--force'])
    expect(flags['force']).toBe(true)
  })

  it('parses sync subcommands as positional args', () => {
    const { argv } = parseArgs(['sync', 'push'])
    expect(argv._[0]).toBe('sync')
    expect(argv._[1]).toBe('push')
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
    // minimist treats --no-X as a negation: sets ai=false
    expect(flags['ai']).toBe(false)
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

describe('resolveSyncSubcommand', () => {
  it('returns push for "push"', () => {
    expect(resolveSyncSubcommand('push')).toBe('push')
  })

  it('returns pull for "pull"', () => {
    expect(resolveSyncSubcommand('pull')).toBe('pull')
  })

  it('returns both for "both"', () => {
    expect(resolveSyncSubcommand('both')).toBe('both')
  })

  it('returns abort for "abort"', () => {
    expect(resolveSyncSubcommand('abort')).toBe('abort')
  })

  it('returns null for undefined', () => {
    expect(resolveSyncSubcommand(undefined)).toBeNull()
  })

  it('returns null for unrecognized subcommand', () => {
    expect(resolveSyncSubcommand('foo')).toBeNull()
  })
})
