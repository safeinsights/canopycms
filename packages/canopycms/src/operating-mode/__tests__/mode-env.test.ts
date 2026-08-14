/**
 * Guards the deployed-mode switch (baseline review E4).
 *
 * Before this existed, `canopycms init` baked `mode: 'dev'` into the generated
 * config and nothing read `CANOPY_MODE` anywhere — so following
 * docs/deploying-to-aws.md shipped a dev-mode Lambda that resolved its
 * workspace to `<cwd>/.canopy-dev` and died with EROFS on Lambda's read-only
 * filesystem.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

import { resolveOperatingMode, resetModeWarning } from '../mode-env'
import { validateCanopyConfig } from '../../config/validation'
import { composeCanopyConfig, defineCanopyConfig } from '../../config/helpers'
import { mockConsole } from '../../test-utils/console-spy'

const baseConfig = {
  gitBotAuthorName: 'Test Bot',
  gitBotAuthorEmail: 'bot@example.com',
  mode: 'dev' as const,
}

/**
 * The suite runs in a node environment, so `window` is absent by default —
 * i.e. every test is on the server path unless it opts into the browser one.
 */
function withBrowserWindow(fn: () => void): void {
  const globals = globalThis as { window?: unknown }
  globals.window = {}
  try {
    fn()
  } finally {
    delete globals.window
  }
}

beforeEach(() => {
  resetModeWarning()
  vi.stubEnv('CANOPY_MODE', '')
  vi.stubEnv('NEXT_PUBLIC_CANOPY_MODE', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetModeWarning()
})

describe('resolveOperatingMode', () => {
  it('returns the config literal when nothing is set in the environment', () => {
    expect(resolveOperatingMode('dev')).toBe('dev')
    expect(resolveOperatingMode('prod')).toBe('prod')
  })

  it('lets CANOPY_MODE=prod win over a dev config literal (the deployed-Lambda case)', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', 'prod')
      expect(resolveOperatingMode('dev')).toBe('prod')
    } finally {
      spy.restore()
    }
  })

  it('lets CANOPY_MODE=dev win over a prod config literal', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', 'dev')
      expect(resolveOperatingMode('prod')).toBe('dev')
    } finally {
      spy.restore()
    }
  })

  it('ignores an empty or whitespace-only value', () => {
    vi.stubEnv('CANOPY_MODE', '   ')
    expect(resolveOperatingMode('dev')).toBe('dev')
  })

  it('trims surrounding whitespace rather than rejecting the value', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', ' prod ')
      expect(resolveOperatingMode('dev')).toBe('prod')
    } finally {
      spy.restore()
    }
  })

  // The point of throwing: a typo must not silently degrade a prod deployment
  // to dev auth semantics (the failure SEC-C1 made `mode` required to prevent).
  it.each(['production', 'PROD', 'development', 'true', 'staging'])(
    'throws on an unrecognized value (%s) instead of falling back to the config literal',
    (value) => {
      vi.stubEnv('CANOPY_MODE', value)
      expect(() => resolveOperatingMode('dev')).toThrow(/invalid CANOPY_MODE/i)
    },
  )

  it('names the offending variable in the error', () => {
    vi.stubEnv('CANOPY_MODE', 'production')
    expect(() => resolveOperatingMode('dev')).toThrow(/CANOPY_MODE/)
  })

  it('warns exactly once when the environment disagrees with the config literal', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', 'prod')
      resolveOperatingMode('dev')
      resolveOperatingMode('dev')
      resolveOperatingMode('dev')
      expect(spy.all().warn).toHaveLength(1)
      expect(spy.all().warn[0]).toMatch(/CANOPY_MODE/)
    } finally {
      spy.restore()
    }
  })

  it('does not warn when the environment agrees with the config literal', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', 'dev')
      expect(resolveOperatingMode('dev')).toBe('dev')
      expect(spy.all().warn).toHaveLength(0)
    } finally {
      spy.restore()
    }
  })

  describe('browser half (NEXT_PUBLIC_CANOPY_MODE)', () => {
    // The editor page is a client component that imports the adopter's config
    // directly, so the browser's copy of `mode` can only come from a value
    // inlined at build time — a Lambda environment variable never reaches it.
    it('reads NEXT_PUBLIC_CANOPY_MODE in the browser', () => {
      const spy = mockConsole()
      try {
        vi.stubEnv('NEXT_PUBLIC_CANOPY_MODE', 'prod')
        withBrowserWindow(() => {
          expect(resolveOperatingMode('dev')).toBe('prod')
        })
      } finally {
        spy.restore()
      }
    })

    it('ignores the server variable in the browser', () => {
      vi.stubEnv('CANOPY_MODE', 'prod')
      withBrowserWindow(() => {
        expect(resolveOperatingMode('dev')).toBe('dev')
      })
    })

    // This is what keeps the image build in dev mode: the generated Dockerfile
    // sets NEXT_PUBLIC_CANOPY_MODE so it reaches the client bundle, and that
    // must NOT put `next build`'s own server-side content reads into prod mode.
    it('ignores the browser variable on the server', () => {
      vi.stubEnv('NEXT_PUBLIC_CANOPY_MODE', 'prod')
      expect(resolveOperatingMode('dev')).toBe('dev')
    })

    it('names the browser variable in the error it throws', () => {
      vi.stubEnv('NEXT_PUBLIC_CANOPY_MODE', 'production')
      withBrowserWindow(() => {
        expect(() => resolveOperatingMode('dev')).toThrow(/NEXT_PUBLIC_CANOPY_MODE/)
      })
    })
  })
})

describe('config-authoring paths honor the mode override', () => {
  // Applied in validateCanopyConfig so it cannot be bypassed by choosing a
  // different helper.
  it('validateCanopyConfig resolves the deployed mode', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', 'prod')
      expect(validateCanopyConfig(baseConfig).mode).toBe('prod')
    } finally {
      spy.restore()
    }
  })

  it('defineCanopyConfig resolves the deployed mode on both server and client config', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', 'prod')
      const config = defineCanopyConfig(baseConfig)
      expect(config.server.mode).toBe('prod')
      expect(config.client().mode).toBe('prod')
    } finally {
      spy.restore()
    }
  })

  it('composeCanopyConfig resolves the deployed mode', () => {
    const spy = mockConsole()
    try {
      vi.stubEnv('CANOPY_MODE', 'prod')
      expect(composeCanopyConfig(baseConfig).mode).toBe('prod')
    } finally {
      spy.restore()
    }
  })

  // SEC-C1 is unchanged: the override replaces a declared value, it never
  // supplies a missing one.
  it('still rejects a config that omits mode, even with the environment set', () => {
    vi.stubEnv('CANOPY_MODE', 'prod')
    const { mode: _mode, ...withoutMode } = baseConfig
    expect(() => validateCanopyConfig(withoutMode)).toThrow(/mode/i)
  })
})
