/**
 * Child process for branch-provisioning.kill.integration.test.ts. Provisions one content branch,
 * or the settings workspace, in prod mode, writing each provisioning step line to stdout
 * synchronously. The line containing `PROVISION_CHILD_PAUSE_AT` is followed by a pause, so a
 * parent that kills on that line kills at exactly that step boundary.
 *
 * argv: `branch|settings <workspaceRoot> <remoteUrl>`
 */
import { writeSync } from 'node:fs'
import path from 'node:path'

import { BranchWorkspaceManager } from '../../branch-workspace'
import { defineCanopyConfig } from '../../config'
import { SettingsWorkspaceManager } from '../../settings-workspace'
import { getErrorMessage } from '../../utils/error'
import { setProvisionLogSink } from '../../utils/provision-log'

const [kind, workspaceRoot, remoteUrl] = process.argv.slice(2)
process.env.CANOPYCMS_WORKSPACE_ROOT = workspaceRoot

const pauseAt = process.env.PROVISION_CHILD_PAUSE_AT
const pause = new Int32Array(new SharedArrayBuffer(4))
setProvisionLogSink((line) => {
  writeSync(1, `${line}\n`)
  if (pauseAt && line.includes(pauseAt)) Atomics.wait(pause, 0, 0, 10_000)
})

const config = defineCanopyConfig({
  mode: 'prod',
  gitBotAuthorName: 'Kill Test Bot',
  gitBotAuthorEmail: 'kill-test@canopycms.test',
  defaultBaseBranch: 'main',
  defaultRemoteUrl: remoteUrl,
  deploymentName: 'kill',
}).server

async function main(): Promise<string> {
  if (kind === 'settings') {
    await new SettingsWorkspaceManager(config).ensureGitWorkspace({
      settingsRoot: path.join(workspaceRoot, 'settings'),
      branchName: 'canopycms-settings-kill',
      mode: 'prod',
      remoteUrl,
    })
    return 'ensured'
  }
  const outcome = await new BranchWorkspaceManager(config).provisionBranch({
    branchName: 'feat',
    mode: 'prod',
    createdBy: 'kill-test',
  })
  return outcome.kind
}

main().then(
  (result) => {
    writeSync(1, `CHILD done ${result}\n`)
  },
  (err: unknown) => {
    writeSync(1, `CHILD error ${getErrorMessage(err)}\n`)
    process.exitCode = 1
  },
)
