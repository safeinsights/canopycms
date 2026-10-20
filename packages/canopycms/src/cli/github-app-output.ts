/**
 * What `init-github-app` says to the operator, as strings. Each stream gets
 * its own palette, on only when that stream is a TTY (or FORCE_COLOR asks for
 * it) and NO_COLOR is unset. picocolors' own default also turns colour on for
 * `CI` and on Windows whatever the stream is, which would put escape codes in
 * a piped log.
 */
import pc from 'picocolors'
import { CANOPY_APP_PERMISSIONS } from './github-app-manifest'

type Palette = ReturnType<typeof pc.createColors>

function colorsFor(stream: NodeJS.WriteStream): Palette {
  const { NO_COLOR, FORCE_COLOR, TERM } = process.env
  if (NO_COLOR) return pc.createColors(false)
  if (FORCE_COLOR) return pc.createColors(FORCE_COLOR !== '0' && FORCE_COLOR !== 'false')
  return pc.createColors(Boolean(stream.isTTY) && TERM !== 'dumb')
}

/** For anything printed with `console.log`. */
export const outColors = colorsFor(process.stdout)
/** For anything printed with `console.error`. */
export const errColors = colorsFor(process.stderr)

export const tick = (text: string): string => `${outColors.green('✓')} ${text}`
export const failMark = errColors.red('✗')
export const cross = (text: string): string => `${failMark} ${text}`
/** `palette` is the stream the line goes to. */
export const link = (url: string, palette: Palette = outColors): string =>
  palette.cyan(palette.underline(url))
export const step = (n: number, text: string): string =>
  outColors.bold(outColors.cyan(`${n}.`) + ` ${text}`)

/** Printed before the browser opens, so it survives a terminal that is gone by the time it matters. */
export function recoveryPreamble(): string {
  return [
    outColors.bold(outColors.yellow('If this goes wrong after you click Create')),
    '  The App will exist, but this command will not have its private key. To recover, either:',
    '    • delete the App in its settings and re-run this command, or',
    '    • open the App, scroll to "Private keys" and click "Generate a private key". The',
    '      .pem it downloads is your only chance to save it.',
    outColors.dim(
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
    ([name, level]) => `  ${name.padEnd(width)}  ${outColors.bold(level)}`,
  )
  return [
    outColors.bold(`Registering "${input.name}" for ${input.owner}/${input.repo}`),
    '',
    `${outColors.bold('Permissions')} ${outColors.dim('(the part that matters)')}`,
    ...permissions,
    '',
    `${outColors.bold('Private key')} goes to ${input.destination}`,
    outColors.dim('  If that fails you are asked for somewhere else before the key is discarded.'),
    '',
    step(1, 'Open this file in a browser:'),
    '',
    `   ${link(input.formFile)}`,
    '',
    '   The browser matters, twice over. It must be:',
    `     • ${outColors.bold('logged in to GitHub')} as an owner of ${input.owner}`,
    `     • running ${outColors.bold('on this machine')}: the redirect returns to 127.0.0.1:${input.callbackPort}, which only a local browser can reach`,
    outColors.dim(
      '   An embedded or app-internal browser bounces off the GitHub login wall and appears\n' +
        '   to do nothing when you click Create.',
    ),
    '',
    '   The page posts the manifest to GitHub, which shows the App pre-filled with exactly',
    '   those permissions. Review them and click Create.',
    '',
    outColors.dim(`Waiting for GitHub to redirect back (up to ${input.timeoutMinutes} minutes)...`),
  ].join('\n')
}

export function deploymentSettingsMessage(appId: number, installationId: number | null): string {
  return [
    '',
    outColors.bold('Set these on your deployment'),
    '',
    `  GITHUB_APP_ID=${appId}`,
    `  GITHUB_APP_INSTALLATION_ID=${installationId ?? '<run `verify` to read it>'}`,
    `  GITHUB_APP_PRIVATE_KEY_SECRET_ARN=<wherever you just put the key>`,
    '',
    outColors.dim(
      '  Both ids are numeric. The App ID is NOT the "Client ID" (`Iv1.…`) shown beside it,\n' +
        '  and the installation id is NOT the App ID: an App installed twice has one App ID\n' +
        '  and two installation ids.',
    ),
    '',
    outColors.bold('Re-check this any time, without creating anything'),
    `  canopycms init-github-app verify --app-id ${appId} --key-file <path>`,
  ].join('\n')
}
