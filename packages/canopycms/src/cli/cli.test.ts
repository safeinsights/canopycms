import { describe, it, expect } from 'vitest'
import {
  parseArgs,
  resolveSyncSubcommand,
  parseAuthFlag,
  parseDualBuildFlag,
  isKnownAuthMode,
  passthroughArgs,
} from './cli'

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

  it('keeps argv after a literal -- out of the positionals', () => {
    // `init-github-app create -- <command>` hands everything after the `--` to
    // spawn(). Without minimist's `'--': true` these words land in `argv._`,
    // indistinguishable from the command's own positionals, and the `--` itself
    // is discarded — so there is no way to recover a clean argv.
    const { argv, command } = parseArgs([
      'init-github-app',
      'create',
      '--owner',
      'an-org',
      '--',
      'store-it',
      '--name',
      'a/secret',
    ])
    expect(command).toBe('init-github-app')
    expect(argv._).toEqual(['init-github-app', 'create'])
    expect(passthroughArgs(argv)).toEqual(['store-it', '--name', 'a/secret'])
  })

  it('does not let the passthrough command steal the caller’s own flags', () => {
    // `--name` appears on both sides of the `--`. The one before it is the
    // App name; the one after belongs to the destination command.
    const { flags, argv } = parseArgs([
      'init-github-app',
      'create',
      '--name',
      'Mine',
      '--',
      'store-it',
      '--name',
      'theirs',
    ])
    expect(flags['name']).toBe('Mine')
    expect(passthroughArgs(argv)).toEqual(['store-it', '--name', 'theirs'])
  })

  it('reports an empty passthrough when there is no --', () => {
    const { argv } = parseArgs(['init-github-app', 'verify', '--app-id', '1'])
    expect(passthroughArgs(argv)).toEqual([])
  })

  it('parses the init-github-app flags', () => {
    const { flags } = parseArgs([
      'init-github-app',
      'verify',
      '--app-id',
      '123456',
      '--key-file',
      '/tmp/k.pem',
      '--key-stdin',
      '--repo',
      'a-site',
    ])
    // --app-id is declared a STRING: an id read as a number would lose
    // precision and reach the JWT `iss` claim in exponential notation.
    expect(flags['app-id']).toBe('123456')
    expect(flags['key-file']).toBe('/tmp/k.pem')
    expect(flags['key-stdin']).toBe(true)
    expect(flags['repo']).toBe('a-site')
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

  it('parses --auth as a string flag', () => {
    const { flags } = parseArgs(['init', '--auth', 'clerk'])
    expect(flags['auth']).toBe('clerk')
  })

  it('parses --dual-build as boolean true when passed', () => {
    const { flags } = parseArgs(['init', '--dual-build'])
    expect(flags['dual-build']).toBe(true)
  })

  it('leaves --dual-build undefined when not passed', () => {
    const { flags } = parseArgs(['init'])
    expect(flags['dual-build']).toBeUndefined()
  })

  it('parses --no-dual-build as boolean false (explicit override)', () => {
    const { flags } = parseArgs(['init', '--no-dual-build'])
    expect(flags['dual-build']).toBe(false)
  })

  it('parses --auth and --dual-build together with --non-interactive', () => {
    const { flags } = parseArgs(['init', '--non-interactive', '--auth', 'clerk', '--dual-build'])
    expect(flags['non-interactive']).toBe(true)
    expect(flags['auth']).toBe('clerk')
    expect(flags['dual-build']).toBe(true)
  })
})

describe('parseAuthFlag', () => {
  it('returns undefined when the flag was not provided', () => {
    expect(parseAuthFlag(undefined)).toBeUndefined()
  })

  it('accepts "clerk"', () => {
    expect(parseAuthFlag('clerk')).toBe('clerk')
  })

  it('accepts "dev"', () => {
    expect(parseAuthFlag('dev')).toBe('dev')
  })

  it('throws for an unrecognized value', () => {
    expect(() => parseAuthFlag('foo')).toThrow(/--auth must be "clerk" or "dev"/)
  })

  it('throws for an empty string (--auth passed with no value)', () => {
    expect(() => parseAuthFlag('')).toThrow(/--auth must be "clerk" or "dev"/)
  })

  it('throws when given a boolean (defensive — should not happen for a string-declared flag)', () => {
    expect(() => parseAuthFlag(true)).toThrow(/--auth must be "clerk" or "dev"/)
  })
})

describe('parseDualBuildFlag', () => {
  it('returns undefined when the flag was not provided', () => {
    expect(parseDualBuildFlag(undefined)).toBeUndefined()
  })

  it('accepts a real boolean true (bare --dual-build)', () => {
    expect(parseDualBuildFlag(true)).toBe(true)
  })

  it('accepts a real boolean false (--no-dual-build)', () => {
    expect(parseDualBuildFlag(false)).toBe(false)
  })

  it('coerces the string "true" (--dual-build=true / --dual-build true)', () => {
    expect(parseDualBuildFlag('true')).toBe(true)
  })

  it('coerces the string "false" (--dual-build=false)', () => {
    expect(parseDualBuildFlag('false')).toBe(false)
  })

  it('throws for an unrecognized value', () => {
    expect(() => parseDualBuildFlag('foo')).toThrow(/--dual-build must be a boolean/)
  })

  it('throws for an empty string (--dual-build passed with no value)', () => {
    expect(() => parseDualBuildFlag('')).toThrow(/--dual-build must be a boolean/)
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

describe('isKnownAuthMode', () => {
  // The guard that stops `worker run-once` silently refreshing nothing: the
  // dispatch knows only 'clerk' and 'dev', and the catch around plugin loading
  // fires only on an IMPORT failure, so any other value used to select no
  // plugin, skip the refresh, and exit 0.
  it.each(['clerk', 'dev'])('accepts %s', (mode) => {
    expect(isKnownAuthMode(mode)).toBe(true)
  })

  it.each([
    ['Clerk', 'wrong casing -- the realistic typo'],
    ['DEV', 'wrong casing'],
    ['clerk ', 'trailing whitespace from a .env line'],
    ['', 'empty'],
    ['auth0', 'a provider this CLI cannot construct'],
  ])('rejects %j (%s)', (mode) => {
    expect(isKnownAuthMode(mode)).toBe(false)
  })
})
