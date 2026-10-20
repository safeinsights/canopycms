/**
 * What `init-github-app` says to the operator, as strings. Styling goes
 * through picocolors, which drops every escape code when stdout is not a TTY
 * or NO_COLOR is set, so piped output and logs stay plain text.
 */
import pc from 'picocolors'
import { CANOPY_APP_PERMISSIONS } from './github-app-manifest'

export const tick = (text: string): string => `${pc.green('✓')} ${text}`
export const cross = (text: string): string => `${pc.red('✗')} ${text}`
export const link = (url: string): string => pc.cyan(pc.underline(url))
export const step = (n: number, text: string): string => pc.bold(pc.cyan(`${n}.`) + ` ${text}`)

/** Printed before the browser opens, so it survives a terminal that is gone by the time it matters. */
export function recoveryPreamble(): string {
  return [
    pc.bold(pc.yellow('If this goes wrong after you click Create')),
    '  The App will exist, but this command will not have its private key. To recover, either:',
    '    • delete the App in its settings and re-run this command, or',
    '    • open the App, scroll to "Private keys" and click "Generate a private key". The',
    '      .pem it downloads is your only chance to save it.',
    pc.dim(
      '  (Not the "client secret" a few sections above: that is for OAuth user flows, is unused\n' +
        '  by this App, and fails confusingly when used to sign.)',
    ),
    '',
  ].join('\n')
}

export type RegistrationMessageInput = {
  name: string
  owner: string
  repo: string
  /** `describeDestination`'s wording of where the key is going. */
  destination: string
  formFile: string
  callbackPort: number
  timeoutMinutes: number
}

export function registrationMessage(input: RegistrationMessageInput): string {
  const width = Math.max(...Object.keys(CANOPY_APP_PERMISSIONS).map((name) => name.length))
  const permissions = Object.entries(CANOPY_APP_PERMISSIONS).map(
    ([name, level]) => `  ${name.padEnd(width)}  ${pc.bold(level)}`,
  )
  return [
    pc.bold(`Registering "${input.name}" for ${input.owner}/${input.repo}`),
    '',
    `${pc.bold('Permissions')} ${pc.dim('(the part that matters)')}`,
    ...permissions,
    '',
    `${pc.bold('Private key')} goes to ${input.destination}`,
    pc.dim('  If that fails you are asked for somewhere else before the key is discarded.'),
    '',
    step(1, 'Open this file in a browser:'),
    '',
    `   ${link(input.formFile)}`,
    '',
    '   The browser matters, twice over. It must be:',
    `     • ${pc.bold('logged in to GitHub')} as an owner of ${input.owner}`,
    `     • running ${pc.bold('on this machine')}: the redirect returns to 127.0.0.1:${input.callbackPort}`,
    pc.dim(
      '   An embedded or app-internal browser bounces off the GitHub login wall and appears\n' +
        '   to do nothing when you click Create.',
    ),
    '',
    '   The page posts the manifest to GitHub, which shows the App pre-filled with exactly',
    '   those permissions. Review them and click Create.',
    '',
    pc.dim(`Waiting for GitHub to redirect back (up to ${input.timeoutMinutes} minutes)...`),
  ].join('\n')
}

export function deploymentSettingsMessage(appId: number, installationId: number | null): string {
  return [
    '',
    pc.bold('Set these on your deployment'),
    '',
    `  ${pc.bold('GITHUB_APP_ID')}=${appId}`,
    `  ${pc.bold('GITHUB_APP_INSTALLATION_ID')}=${installationId ?? '<run `verify` to read it>'}`,
    `  ${pc.bold('GITHUB_APP_PRIVATE_KEY_SECRET_ARN')}=<wherever you just put the key>`,
    '',
    pc.dim(
      '  Both ids are numeric. The App ID is NOT the "Client ID" (`Iv1.…`) shown beside it,\n' +
        '  and the installation id is NOT the App ID: an App installed twice has one App ID\n' +
        '  and two installation ids.',
    ),
    '',
    pc.bold('Re-check this any time, without creating anything'),
    `  canopycms init-github-app verify --app-id ${appId} --key-file <path>`,
  ].join('\n')
}
