/**
 * Operating Mode Strategy Pattern Tests
 *
 * Tests for both client-safe and client-unsafe strategies
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  clientOperatingStrategy,
  clearClientStrategyCache,
  operatingStrategy,
  clearStrategyCache,
} from '../index'
import type { OperatingMode } from '..'
import { mockConsole } from '../../test-utils'

describe('Operating Mode Strategies', () => {
  // Clean up caches after each test
  afterEach(() => {
    clearClientStrategyCache()
    clearStrategyCache()
  })

  describe('Client-Safe Strategies', () => {
    describe('Production Mode', () => {
      const mode: OperatingMode = 'prod'

      it('should have correct mode identifier', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.mode).toBe('prod')
      })

      it('should support branching', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsBranching()).toBe(true)
      })

      it('should support status badge', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsStatusBadge()).toBe(true)
      })

      it('should support comments', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsComments()).toBe(true)
      })

      it('should support pull requests', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsPullRequests()).toBe(true)
      })

      it('should use standard permissions file name', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.getPermissionsFileName()).toBe('permissions.json')
      })

      it('should use standard groups file name', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.getGroupsFileName()).toBe('groups.json')
      })

      it('should commit changes', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.shouldCommit()).toBe(true)
      })

      it('should push changes', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.shouldPush()).toBe(true)
      })
    })

    describe('Dev Mode', () => {
      const mode: OperatingMode = 'dev'

      it('should have correct mode identifier', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.mode).toBe('dev')
      })

      it('should support branching', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsBranching()).toBe(true)
      })

      it('should support status badge', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsStatusBadge()).toBe(true)
      })

      it('should support comments', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsComments()).toBe(true)
      })

      it('should NOT support pull requests', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsPullRequests()).toBe(false)
      })

      it('should use standard permissions file name', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.getPermissionsFileName()).toBe('permissions.json')
      })

      it('should use standard groups file name', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.getGroupsFileName()).toBe('groups.json')
      })

      it('should commit changes', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.shouldCommit()).toBe(true)
      })

      it('should push changes', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.shouldPush()).toBe(true)
      })
    })

    describe('Memoization', () => {
      it('should return same instance for same mode', () => {
        const strategy1 = clientOperatingStrategy('prod')
        const strategy2 = clientOperatingStrategy('prod')
        expect(strategy1).toBe(strategy2)
      })

      it('should return different instances for different modes', () => {
        const prodStrategy = clientOperatingStrategy('prod')
        const localStrategy = clientOperatingStrategy('dev')
        expect(prodStrategy).not.toBe(localStrategy)
      })

      it('should create new instance after cache clear', () => {
        const strategy1 = clientOperatingStrategy('prod')
        clearClientStrategyCache()
        const strategy2 = clientOperatingStrategy('prod')
        expect(strategy1).not.toBe(strategy2)
      })
    })
  })

  describe('Client-Unsafe Strategies', () => {
    describe('Production Mode', () => {
      const mode: OperatingMode = 'prod'
      const originalEnv = process.env.CANOPYCMS_WORKSPACE_ROOT

      afterEach(() => {
        // Restore original env
        if (originalEnv) {
          process.env.CANOPYCMS_WORKSPACE_ROOT = originalEnv
        } else {
          delete process.env.CANOPYCMS_WORKSPACE_ROOT
        }
      })

      it('should inherit all client-safe methods', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.mode).toBe('prod')
        expect(strategy.supportsBranching()).toBe(true)
        expect(strategy.shouldCommit()).toBe(true)
        expect(strategy.getPermissionsFileName()).toBe('permissions.json')
      })

      it('should use default content branches root', () => {
        delete process.env.CANOPYCMS_WORKSPACE_ROOT
        const strategy = operatingStrategy(mode)
        const branchesRoot = strategy.getContentBranchesRoot()
        expect(branchesRoot).toContain('/mnt/efs/workspace/content-branches')
      })

      it('should use env variable for content branches root', () => {
        process.env.CANOPYCMS_WORKSPACE_ROOT = '/custom/path'
        const strategy = operatingStrategy(mode)
        const branchesRoot = strategy.getContentBranchesRoot()
        expect(branchesRoot).toContain('/custom/path/content-branches')
      })

      it('should get content root', () => {
        const strategy = operatingStrategy(mode)
        const contentRoot = strategy.getContentRoot()
        expect(contentRoot).toContain('content')
      })

      it('should create branch subdirectories', () => {
        const strategy = operatingStrategy(mode)
        const branchRoot = strategy.getContentBranchRoot('feature-branch')
        expect(branchRoot).toContain('feature-branch')
      })

      it('should construct permissions file path', () => {
        const strategy = operatingStrategy(mode)
        const path = strategy.getPermissionsFilePath('/root')
        expect(path).toContain('/root')
        expect(path).toContain('permissions.json')
      })

      it('should construct groups file path', () => {
        const strategy = operatingStrategy(mode)
        const path = strategy.getGroupsFilePath('/root')
        expect(path).toContain('/root')
        expect(path).toContain('groups.json')
      })

      it('should NOT require existing repo', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.requiresExistingRepo()).toBe(false)
      })

      it('should use canopycms-settings-prod branch by default', () => {
        const strategy = operatingStrategy(mode)
        const branchName = strategy.getSettingsBranchName({})
        expect(branchName).toBe('canopycms-settings-prod')
      })

      it('should use deploymentName for settings branch', () => {
        const strategy = operatingStrategy(mode)
        const branchName = strategy.getSettingsBranchName({
          deploymentName: 'staging',
        })
        expect(branchName).toBe('canopycms-settings-staging')
      })

      it('should respect custom settings branch', () => {
        const strategy = operatingStrategy(mode)
        const branchName = strategy.getSettingsBranchName({
          settingsBranch: 'custom-settings',
        })
        expect(branchName).toBe('custom-settings')
      })

      it('should use separate settings branch', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.usesSeparateSettingsBranch()).toBe(true)
      })

      it('should validate config requires git bot info', () => {
        const strategy = operatingStrategy(mode)
        expect(() => {
          strategy.validateConfig({})
        }).toThrow('gitBotAuthorName and gitBotAuthorEmail')
      })

      it('should allow valid config', () => {
        const strategy = operatingStrategy(mode)
        expect(() => {
          strategy.validateConfig({
            gitBotAuthorName: 'Bot',
            gitBotAuthorEmail: 'bot@example.com',
          })
        }).not.toThrow()
      })

      it('should create permissions PR by default', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.shouldCreateSettingsPR({})).toBe(true)
      })

      it('should respect autoCreatePermissionsPR config', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.shouldCreateSettingsPR({ autoCreateSettingsPR: false })).toBe(false)
      })

      it('should return git exclude pattern', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.getGitExcludePattern()).toBe('.canopy-meta/')
      })

      it('should have autoDetectRemotePath pointing to remote.git at workspace root', () => {
        delete process.env.CANOPYCMS_WORKSPACE_ROOT
        clearStrategyCache()
        const strategy = operatingStrategy(mode)
        const config = strategy.getRemoteUrlConfig()
        expect(config.shouldAutoInitLocal).toBe(false)
        expect(config.autoDetectRemotePath).toContain('/mnt/efs/workspace/remote.git')
      })

      it('should use custom workspace root in autoDetectRemotePath', () => {
        process.env.CANOPYCMS_WORKSPACE_ROOT = '/custom/workspace'
        clearStrategyCache()
        const strategy = operatingStrategy(mode)
        const config = strategy.getRemoteUrlConfig()
        expect(config.autoDetectRemotePath).toContain('/custom/workspace/remote.git')
      })
    })

    describe('Dev Mode', () => {
      const mode: OperatingMode = 'dev'

      it('should inherit all client-safe methods', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.mode).toBe('dev')
        expect(strategy.supportsBranching()).toBe(true)
        expect(strategy.shouldCommit()).toBe(true)
        expect(strategy.supportsPullRequests()).toBe(false)
      })

      it('should use .canopy-dev/content-branches as branches root', () => {
        const strategy = operatingStrategy(mode)
        const branchesRoot = strategy.getContentBranchesRoot()
        expect(branchesRoot).toContain('.canopy-dev/content-branches')
      })

      it('should create branch subdirectories', () => {
        const strategy = operatingStrategy(mode)
        const branchRoot = strategy.getContentBranchRoot('feature-branch')
        expect(branchRoot).toContain('feature-branch')
      })

      it('should NOT require existing repo', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.requiresExistingRepo()).toBe(false)
      })

      it('should use separate settings branch', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.usesSeparateSettingsBranch()).toBe(true)
      })

      it('should NOT create permissions PR', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.shouldCreateSettingsPR({})).toBe(false)
      })

      it('should return git exclude pattern', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.getGitExcludePattern()).toBe('.canopy-meta/')
      })
    })

    describe('Memoization', () => {
      it('should return same instance for same mode', () => {
        const strategy1 = operatingStrategy('prod')
        const strategy2 = operatingStrategy('prod')
        expect(strategy1).toBe(strategy2)
      })

      it('should return different instances for different modes', () => {
        const prodStrategy = operatingStrategy('prod')
        const localStrategy = operatingStrategy('dev')
        expect(prodStrategy).not.toBe(localStrategy)
      })

      it('should create new instance after cache clear', () => {
        const strategy1 = operatingStrategy('prod')
        clearStrategyCache()
        const strategy2 = operatingStrategy('prod')
        expect(strategy1).not.toBe(strategy2)
      })
    })

    describe('Integration with Client-Safe Strategies', () => {
      it('should have separate caches', () => {
        const clientStrategy = clientOperatingStrategy('prod')
        const fullStrategy = operatingStrategy('prod')
        // They should not be the same instance
        expect(clientStrategy).not.toBe(fullStrategy)
      })

      it('should have same mode values', () => {
        const clientStrategy = clientOperatingStrategy('prod')
        const fullStrategy = operatingStrategy('prod')
        expect(clientStrategy.mode).toBe(fullStrategy.mode)
      })

      it('should have same client-safe method results', () => {
        const clientStrategy = clientOperatingStrategy('prod')
        const fullStrategy = operatingStrategy('prod')

        expect(clientStrategy.supportsBranching()).toBe(fullStrategy.supportsBranching())
        expect(clientStrategy.shouldCommit()).toBe(fullStrategy.shouldCommit())
        expect(clientStrategy.getPermissionsFileName()).toBe(fullStrategy.getPermissionsFileName())
      })
    })

    describe('deploymentName resolution (env > config > modeDefault)', () => {
      afterEach(() => {
        vi.unstubAllEnvs()
        clearStrategyCache()
      })

      it('falls back to the mode default when neither env nor config is set (prod -> prod, dev -> local)', () => {
        vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
        expect(operatingStrategy('prod').getSettingsBranchName({})).toBe('canopycms-settings-prod')
        expect(operatingStrategy('dev').getSettingsBranchName({})).toBe('canopycms-settings-local')
      })

      it('uses config.deploymentName when env is unset', () => {
        vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
        expect(operatingStrategy('prod').getSettingsBranchName({ deploymentName: 'acme' })).toBe(
          'canopycms-settings-acme',
        )
      })

      it('ignores a whitespace-only env var and falls back to config', () => {
        vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '   ')
        expect(operatingStrategy('prod').getSettingsBranchName({ deploymentName: 'acme' })).toBe(
          'canopycms-settings-acme',
        )
      })

      it('uses the env var alone when config.deploymentName is unset', () => {
        vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'from-env')
        expect(operatingStrategy('prod').getSettingsBranchName({})).toBe(
          'canopycms-settings-from-env',
        )
      })

      it('prefers the env var over config.deploymentName when both are set and differ (env is the value guaranteed to differ between two stacks sharing a repo)', () => {
        const consoleSpy = mockConsole()
        try {
          vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'from-env')
          expect(
            operatingStrategy('prod').getSettingsBranchName({ deploymentName: 'from-config' }),
          ).toBe('canopycms-settings-from-env')
        } finally {
          consoleSpy.restore()
        }
      })

      // These two use a freshly re-imported module (vi.resetModules + dynamic
      // import) rather than the statically-imported `operatingStrategy` above,
      // so each starts with resolveDeploymentName's module-level `warned` flag
      // at its initial `false` - the mismatch test right above this one
      // deliberately latches that flag on the ALREADY-loaded module, which
      // would otherwise make a "did it warn" assertion here meaningless.
      it('does not warn when env and config agree', async () => {
        const consoleSpy = mockConsole()
        try {
          vi.resetModules()
          const { resolveDeploymentName } = await import('../deployment-name')
          vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'same')
          expect(resolveDeploymentName({ deploymentName: 'same' }, 'prod')).toBe('same')
          expect(consoleSpy.all().warn).toHaveLength(0)
        } finally {
          consoleSpy.restore()
          vi.resetModules()
        }
      })

      it('warns exactly once (naming both values) across repeated mismatched resolutions', async () => {
        const consoleSpy = mockConsole()
        try {
          vi.resetModules()
          const { resolveDeploymentName } = await import('../deployment-name')
          vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'from-env')

          resolveDeploymentName({ deploymentName: 'from-config' }, 'prod')
          resolveDeploymentName({ deploymentName: 'from-config' }, 'prod')
          resolveDeploymentName({ deploymentName: 'another-config' }, 'prod')

          expect(consoleSpy.all().warn).toHaveLength(1)
          expect(consoleSpy).toHaveWarned('from-env')
          expect(consoleSpy).toHaveWarned('from-config')
        } finally {
          consoleSpy.restore()
          vi.resetModules()
        }
      })

      // The env route bypasses the config schema entirely, so this is the only
      // thing standing between an infra-stamped value and a malformed git ref.
      describe('rejects deployment names that would not be a valid ref component', () => {
        const invalid = [
          ['a slash (would add a ref hierarchy level)', 'team/prod'],
          ['whitespace', 'my prod'],
          ['a leading dash (parses as a git option)', '-prod'],
          ['a git-forbidden character', 'prod:1'],
          ['dot-dot', 'a..b'],
          ['a leading dot', '.prod'],
        ] as const

        for (const [why, value] of invalid) {
          it(`rejects ${why} from the env var`, () => {
            vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', value)
            expect(() => operatingStrategy('prod').getSettingsBranchName({})).toThrow(
              /invalid deploymentName/i,
            )
          })

          it(`rejects ${why} from config`, () => {
            vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')
            expect(() =>
              operatingStrategy('prod').getSettingsBranchName({ deploymentName: value }),
            ).toThrow(/invalid deploymentName/i)
          })
        }

        it('names the offending source in the error', () => {
          vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'bad/name')
          expect(() => operatingStrategy('prod').getSettingsBranchName({})).toThrow(
            /CANOPYCMS_DEPLOYMENT_NAME/,
          )
        })

        it('still accepts ordinary names with dots, dashes and underscores', () => {
          vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'acme-prod_2.1')
          expect(operatingStrategy('prod').getSettingsBranchName({})).toBe(
            'canopycms-settings-acme-prod_2.1',
          )
        })

        it('does not validate an explicit settingsBranch override (it short-circuits first)', () => {
          vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', 'bad/name')
          expect(
            operatingStrategy('prod').getSettingsBranchName({ settingsBranch: 'my-settings' }),
          ).toBe('my-settings')
        })
      })
    })
  })
})
