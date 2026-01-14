/**
 * Operating Mode Strategy Pattern Tests
 *
 * Tests for both client-safe and client-unsafe strategies
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  clientOperatingStrategy,
  clearClientStrategyCache,
  operatingStrategy,
  clearStrategyCache,
} from '../index'
import type { OperatingMode } from '..'

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

    describe('Local Production Simulation Mode', () => {
      const mode: OperatingMode = 'prod-sim'

      it('should have correct mode identifier', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.mode).toBe('prod-sim')
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

    describe('Local Simple Mode', () => {
      const mode: OperatingMode = 'dev'

      it('should have correct mode identifier', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.mode).toBe('dev')
      })

      it('should NOT support branching', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsBranching()).toBe(false)
      })

      it('should NOT support status badge', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsStatusBadge()).toBe(false)
      })

      it('should NOT support comments', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.supportsComments()).toBe(false)
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

      it('should NOT commit changes', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.shouldCommit()).toBe(false)
      })

      it('should NOT push changes', () => {
        const strategy = clientOperatingStrategy(mode)
        expect(strategy.shouldPush()).toBe(false)
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
        const branchName = strategy.getSettingsBranchName({ deploymentName: 'staging' })
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
        expect(
          strategy.shouldCreateSettingsPR({ autoCreateSettingsPR: false })
        ).toBe(false)
      })

      it('should return git exclude pattern', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.getGitExcludePattern()).toBe('.canopy-meta/')
      })
    })

    describe('Local Production Simulation Mode', () => {
      const mode: OperatingMode = 'prod-sim'

      it('should inherit all client-safe methods', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.mode).toBe('prod-sim')
        expect(strategy.supportsBranching()).toBe(true)
        expect(strategy.shouldCommit()).toBe(true)
        expect(strategy.supportsPullRequests()).toBe(false)
      })

      it('should use .canopy-prod-sim/content-branches as branches root', () => {
        const strategy = operatingStrategy(mode)
        const branchesRoot = strategy.getContentBranchesRoot()
        expect(branchesRoot).toContain('.canopy-prod-sim/content-branches')
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

    describe('Local Simple Mode', () => {
      const mode: OperatingMode = 'dev'

      it('should inherit all client-safe methods', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.mode).toBe('dev')
        expect(strategy.supportsBranching()).toBe(false)
        expect(strategy.shouldCommit()).toBe(false)
        expect(strategy.getPermissionsFileName()).toBe('permissions.json')
      })

      it('should get content root', () => {
        const strategy = operatingStrategy(mode)
        const contentRoot = strategy.getContentRoot()
        expect(contentRoot).toContain('content')
      })

      it('should throw error when getting content branches root', () => {
        const strategy = operatingStrategy(mode)
        expect(() => strategy.getContentBranchesRoot()).toThrow('No branching in dev mode')
      })

      it('should throw error when getting content branch root', () => {
        const strategy = operatingStrategy(mode)
        expect(() => strategy.getContentBranchRoot('feature-branch')).toThrow('No branching in dev mode')
      })

      it('should construct permissions file path in .canopy-dev', () => {
        const strategy = operatingStrategy(mode)
        const path = strategy.getPermissionsFilePath('/root')
        expect(path).toContain('.canopy-dev')
        expect(path).toContain('permissions.json')
      })

      it('should require existing repo', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.requiresExistingRepo()).toBe(true)
      })

      it('should use main branch for settings by default', () => {
        const strategy = operatingStrategy(mode)
        const branchName = strategy.getSettingsBranchName({})
        expect(branchName).toBe('main')
      })

      it('should respect custom default base branch', () => {
        const strategy = operatingStrategy(mode)
        const branchName = strategy.getSettingsBranchName({
          defaultBaseBranch: 'master',
        })
        expect(branchName).toBe('master')
      })

      it('should NOT use separate settings branch', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.usesSeparateSettingsBranch()).toBe(false)
      })

      it('should NOT validate config', () => {
        const strategy = operatingStrategy(mode)
        expect(() => {
          strategy.validateConfig({})
        }).not.toThrow()
      })

      it('should NOT create permissions PR', () => {
        const strategy = operatingStrategy(mode)
        expect(strategy.shouldCreateSettingsPR({})).toBe(false)
      })

      it('should not auto-init local remote', () => {
        const strategy = operatingStrategy(mode)
        const config = strategy.getRemoteUrlConfig()
        expect(config.shouldAutoInitLocal).toBe(false)
        expect(config.envVarName).toBe('CANOPYCMS_REMOTE_URL')
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
        expect(clientStrategy.getPermissionsFileName()).toBe(
          fullStrategy.getPermissionsFileName()
        )
      })
    })
  })
})
