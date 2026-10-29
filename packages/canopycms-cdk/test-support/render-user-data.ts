/**
 * Writes the worker's boot script as a default `CanopyCmsService` synthesizes it, with the two
 * files it downloads, for scripts/smoke/worker-platform.mjs to run on Amazon Linux 2023.
 *
 *   pnpm run build:worker && node --import tsx test-support/render-user-data.ts <out-dir>
 *
 * The out dir gets `user-data.sh`, the bundle and instance files the script's sha256 lines name,
 * and `manifest.json` with the paths the script downloads them to. Every `Ref` renders as
 * `REF_<LogicalId>`, a shell word.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { App, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { aws_ecr as ecr, aws_lambda as lambda } from 'aws-cdk-lib'

import { CanopyCmsService } from '../src/constructs/cms-service'
import {
  INSTANCE_FILES_DOWNLOAD_PATH,
  WORKER_BUNDLE_DOWNLOAD_PATH,
} from '../src/constructs/worker-bundle'

const WORKER_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '../worker/dist')

function render(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(render).join('')
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (typeof obj.Ref === 'string') return `REF_${obj.Ref}`
    const join = obj['Fn::Join']
    if (Array.isArray(join)) {
      const [sep, parts] = join as [string, unknown[]]
      return parts.map(render).join(sep)
    }
    if ('Fn::Base64' in obj) return render(obj['Fn::Base64'])
  }
  throw new Error(`render-user-data: unhandled node ${JSON.stringify(node)}`)
}

function main(outDir: string): void {
  // A script, not a test, so the suite's synth root (test-synth.ts) does not exist here.
  const synthRoot = mkdtempSync(path.join(os.tmpdir(), 'canopycms-render-user-data-'))
  try {
    const app = new App({ outdir: synthRoot })
    const stack = new Stack(app, 'WorkerPlatform', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    new CanopyCmsService(stack, 'Cms', {
      cmsDockerImage: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
      ),
      githubOwner: 'acme',
      githubRepo: 'site',
    })
    const templates = Object.values(
      Template.fromStack(stack).findResources('AWS::EC2::LaunchTemplate'),
    )
    if (templates.length !== 1) {
      throw new Error(`render-user-data: expected 1 launch template, found ${templates.length}`)
    }
    const data = (templates[0].Properties as { LaunchTemplateData: { UserData: unknown } })
      .LaunchTemplateData

    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'user-data.sh'), render(data.UserData))
    copyFileSync(path.join(WORKER_DIST, 'index.js'), path.join(outDir, 'index.js'))
    copyFileSync(
      path.join(WORKER_DIST, 'instance-files.sh'),
      path.join(outDir, 'instance-files.sh'),
    )
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      JSON.stringify(
        {
          downloads: {
            [WORKER_BUNDLE_DOWNLOAD_PATH]: 'index.js',
            [INSTANCE_FILES_DOWNLOAD_PATH]: 'instance-files.sh',
          },
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    rmSync(synthRoot, { recursive: true, force: true })
  }
}

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: node --import tsx test-support/render-user-data.ts <out-dir>')
  process.exit(2)
}
main(path.resolve(outDir))
