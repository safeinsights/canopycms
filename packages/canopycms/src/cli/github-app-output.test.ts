import { afterEach, describe, it, expect, vi } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import { CANOPY_APP_PERMISSIONS } from './github-app-manifest'
import {
  deploymentSettingsMessage,
  recoveryPreamble,
  registrationMessage,
} from './github-app-output'

const plain = (message: string): string => stripVTControlCharacters(message)

describe('registrationMessage', () => {
  const message = plain(
    registrationMessage({
      name: 'a-site-cms',
      owner: 'an-org',
      repo: 'a-site',
      destination: 'the file ./key.pem',
      formFile: '/tmp/canopycms-app-x/create-a-site-cms.html',
      callbackPort: 4321,
      timeoutMinutes: 10,
    }),
  )

  it('lists every requested permission and level as a row, not as JSON', () => {
    const rows = message.split('\n').map((line) => line.trim().split(/\s+/))
    for (const [name, level] of Object.entries(CANOPY_APP_PERMISSIONS)) {
      expect(rows).toContainEqual([name, level])
    }
    expect(message).not.toContain('{')
  })

  it('names the target, the key destination, the form file and the callback port', () => {
    expect(message).toContain('Registering "a-site-cms" for an-org/a-site')
    expect(message).toContain('goes to the file ./key.pem')
    expect(message).toContain('/tmp/canopycms-app-x/create-a-site-cms.html')
    expect(message).toContain('127.0.0.1:4321')
    expect(message).toContain('up to 10 minutes')
  })
})

describe('recoveryPreamble', () => {
  it('says both ways out and where the key is generated', () => {
    const message = plain(recoveryPreamble())
    expect(message).toContain('delete the App in its settings and re-run')
    expect(message).toContain('"Generate a private key"')
  })
})

describe('deploymentSettingsMessage', () => {
  it('prints the ids, and a pointer to `verify` when the installation could not be read', () => {
    const message = plain(deploymentSettingsMessage(42, null))
    expect(message).toContain('GITHUB_APP_ID=42')
    expect(message).toContain('GITHUB_APP_INSTALLATION_ID=<run `verify` to read it>')
    expect(message).toContain('verify --app-id 42 --key-file <path>')
  })

  it('prints the installation id when it was read back', () => {
    expect(plain(deploymentSettingsMessage(42, 7))).toContain('GITHUB_APP_INSTALLATION_ID=7')
  })
})

describe('when escape codes are written', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function freshMessage(env: Record<string, string>): Promise<string> {
    vi.resetModules()
    for (const name of ['NO_COLOR', 'FORCE_COLOR', 'CI', 'TERM']) vi.stubEnv(name, '')
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const fresh = await import('./github-app-output')
    return fresh.deploymentSettingsMessage(42, 7) + fresh.tick('x') + fresh.cross('y')
  }

  it('writes none to a piped stream, even when CI is set', async () => {
    expect(await freshMessage({ CI: '1' })).not.toContain('\x1b')
  })

  it('writes none when FORCE_COLOR is 0', async () => {
    expect(await freshMessage({ FORCE_COLOR: '0' })).not.toContain('\x1b')
  })

  it('writes some when FORCE_COLOR asks for it', async () => {
    expect(await freshMessage({ FORCE_COLOR: '1' })).toContain('\x1b')
  })

  it('writes none when NO_COLOR is set, even with FORCE_COLOR', async () => {
    expect(await freshMessage({ FORCE_COLOR: '1', NO_COLOR: '1' })).not.toContain('\x1b')
  })

  it('keeps the NAME=value lines unstyled in every case', async () => {
    expect(await freshMessage({ FORCE_COLOR: '1' })).toContain('\n  GITHUB_APP_ID=42\n')
  })
})
