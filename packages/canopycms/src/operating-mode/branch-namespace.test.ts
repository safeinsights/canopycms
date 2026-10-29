import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BRANCH_NAMESPACE_ENV,
  DEFAULT_BRANCH_NAMESPACE_TEMPLATE,
  branchNamespaceProblem,
  resolveBranchNamespace,
  resolveBranchNamespaceTemplate,
} from './branch-namespace'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('branchNamespaceProblem', () => {
  it.each(['canopycms/prod/', 'editor-production/', 'cms/', 'a.b/c_d/', 'Editor/Prod/'])(
    'takes %s',
    (namespace) => {
      expect(branchNamespaceProblem(namespace)).toBeNull()
    },
  )

  it.each([
    ['no trailing slash', 'canopycms-prod-', /must end with "\/"/],
    ['an empty one', '', /must end with "\/"/],
    ['only a slash', '/', /a branch in it would be refused/],
    ['a space', 'editor prod/', /printable ASCII without spaces/],
    ['non-ASCII', 'éditeur/', /printable ASCII/],
    ['a percent sign', 'editor%2F/', /contains ", %, \{ or \}/],
    ['braces left by a template', 'editor-{env}/', /contains ", %, \{ or \}/],
    ['a refs/ start', 'refs/heads/x/', /starts with 'refs\/'/],
    ['a heads/ start', 'Heads/x/', /starts with 'refs\/'/],
    ['two slashes', 'editor//', /a branch in it would be refused/],
    ['a leading dash', '-editor/', /a branch in it would be refused/],
    ['dots', 'editor..prod/', /a branch in it would be refused/],
    ['a dot part', 'editor/.hidden/', /starts with '\.'/],
    ['a .lock part', 'editor.lock/', /ends with '\.lock'/],
    ['a settings branch', 'canopycms-settings-prod/', /settings branches/],
    ['a settings branch once sanitized', 'canopycms/settings-/', /settings branches/],
    ['one whose branches sanitize into settings names', 'canopycms/', /settings branches/],
    ['the same, with a dash', 'canopycms-/', /settings branches/],
  ])('refuses %s', (_label, namespace, why) => {
    expect(branchNamespaceProblem(namespace)).toMatch(why)
  })
})

describe('resolveBranchNamespaceTemplate', () => {
  it('fills every {deployment}', () => {
    expect(
      resolveBranchNamespaceTemplate('editor-{deployment}/{deployment}/', 'prod', 'test'),
    ).toBe('editor-prod/prod/')
    expect(resolveBranchNamespaceTemplate(DEFAULT_BRANCH_NAMESPACE_TEMPLATE, 'docs', 'test')).toBe(
      'canopycms/docs/',
    )
  })

  it('refuses another placeholder, naming where the template came from', () => {
    expect(() => resolveBranchNamespaceTemplate('editor-{env}/', 'prod', 'config.x')).toThrow(
      'invalid branch namespace "editor-{env}/" (from config.x): "{env}" is not a placeholder',
    )
  })

  it('refuses the namespace a template resolves to', () => {
    expect(() => resolveBranchNamespaceTemplate('editor-{deployment}', 'prod', 'config.x')).toThrow(
      'invalid branch namespace "editor-prod" (from config.x): it must end with "/"',
    )
  })
})

describe('resolveBranchNamespace', () => {
  // resolveDeploymentName reads the process's variable first.
  const noDeploymentEnv = () => vi.stubEnv('CANOPYCMS_DEPLOYMENT_NAME', '')

  it('defaults to canopycms/{deployment}/ with the mode default deployment name', () => {
    noDeploymentEnv()
    expect(resolveBranchNamespace({}, 'prod', {})).toBe('canopycms/prod/')
    expect(resolveBranchNamespace({}, 'local', {})).toBe('canopycms/local/')
    expect(resolveBranchNamespace({ deploymentName: 'docs' }, 'prod', {})).toBe('canopycms/docs/')
  })

  it('takes the config template, and the environment over it', () => {
    noDeploymentEnv()
    // The disagreement is warned about; the warn-once test below pins that.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = { branchNamespace: 'editor-{deployment}/', deploymentName: 'docs' }

    expect(resolveBranchNamespace(config, 'prod', {})).toBe('editor-docs/')
    expect(
      resolveBranchNamespace(config, 'prod', { [BRANCH_NAMESPACE_ENV]: ' cms/{deployment}/ ' }),
    ).toBe('cms/docs/')
    expect(resolveBranchNamespace(config, 'prod', { [BRANCH_NAMESPACE_ENV]: '  ' })).toBe(
      'editor-docs/',
    )
    warn.mockRestore()
  })

  it('warns once when the environment variable and config disagree, and takes the variable', async () => {
    noDeploymentEnv()
    vi.resetModules()
    const { resolveBranchNamespace: fresh } = await import('./branch-namespace')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = { branchNamespace: 'editor/' }
    const env = { [BRANCH_NAMESPACE_ENV]: 'cms/' }

    expect(fresh(config, 'prod', env)).toBe('cms/')
    expect(fresh(config, 'prod', env)).toBe('cms/')
    expect(fresh(config, 'prod', { [BRANCH_NAMESPACE_ENV]: 'editor/' })).toBe('editor/')

    const lines = warn.mock.calls
      .map((call) => call.join(' '))
      .filter((line) => line.includes(BRANCH_NAMESPACE_ENV))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('differs from config.branchNamespace')
    warn.mockRestore()
  })

  it('names the environment variable when its template is the invalid one', () => {
    noDeploymentEnv()
    expect(() =>
      resolveBranchNamespace({}, 'prod', { [BRANCH_NAMESPACE_ENV]: 'no-slash' }),
    ).toThrow(`(from ${BRANCH_NAMESPACE_ENV})`)
  })
})
