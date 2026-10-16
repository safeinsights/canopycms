/**
 * The worker instance's units under the process split, as user data installs them from the
 * instance files: which layout a
 * bundle gets, what each process's environment holds, the units and their checked-in copies,
 * the host settings the split rests on, and the `canopy-inspect` sandbox.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Fn, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { aws_ecr as ecr, aws_lambda as lambda } from 'aws-cdk-lib'

import { CanopyCmsService, withoutShellComments } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { newTestApp } from '../../test-support/test-synth'
import {
  SHIPPED_INSTANCE_FILES,
  shippedInstanceFile,
  shippedInstanceFilesSha256,
} from '../../test-support/instance-files'
import {
  GATEWAY_SPLIT_CONTRACT,
  GITHUB_GATEWAY_SOCKET_ENV,
  GITHUB_GATEWAY_SOCKET_PATH,
  WORKER_CAPACITY_ENV,
  WORKER_CONTRACT_BANNER_PREFIX,
  WORKER_CONTRACT_ENV,
  WORKER_CONTRACT_VERSION,
} from './worker-lifecycle'
import {
  CANOPY_INSPECT,
  INSPECT_CHECKS,
  INSPECT_RC,
  INSTANCE_FILES_DIR,
  SINGLE_PROCESS_UNIT_CONTRACT,
  WORKER_SANDBOX_DIRECTIVES,
  WORKER_SPLIT_SANDBOX,
  canopyInspectScript,
  gatewaySocketUnit,
  gatewayUnit,
  inspectChecksScript,
  inspectRc,
  instanceFiles,
  instanceFilesScript,
  workerUnit,
} from './worker-units'

const PACKAGE_ROOT = path.join(__dirname, '../..')
const ARN = (name: string) => `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name}`

function synth(overrides: Partial<CanopyCmsServiceProps> = {}): Template {
  const app = newTestApp()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
    ...overrides,
  })
  return Template.fromStack(stack)
}

/** The user-data script with every `Ref` rendered as `REF_<LogicalId>`, a shell word. */
function userDataLines(t: Template): string[] {
  const [lt] = Object.values(t.findResources('AWS::EC2::LaunchTemplate'))
  const render = (node: unknown): string => {
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
    throw new Error(`userDataLines: unhandled node ${JSON.stringify(node)}`)
  }
  const data = (lt.Properties as { LaunchTemplateData: { UserData: unknown } }).LaunchTemplateData
  return render(data.UserData).split('\n')
}

/** The body of every `cat > <target> << 'X'` heredoc, in order. */
function heredocs(all: string[], target: string): string[][] {
  const bodies: string[][] = []
  const literal = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  all.forEach((line, i) => {
    const open = new RegExp(`^\\s*cat > ${literal} << '(\\w+)'$`).exec(line)
    if (!open) return
    const end = all.indexOf(open[1], i + 1)
    expect(end, `no end to the heredoc for ${target}`).toBeGreaterThan(i)
    bodies.push(all.slice(i + 1, end))
  })
  return bodies
}

/** The one line that is exactly `needle`'s index, asserting there is one. */
function indexOfLine(all: string[], predicate: (line: string) => boolean, what: string): number {
  const i = all.findIndex(predicate)
  expect(i, `no user-data line ${what}`).toBeGreaterThanOrEqual(0)
  return i
}

const parseEnv = (body: string[]) =>
  new Map(body.map((line) => line.split('=', 2) as [string, string]))

const tokenDeployment = synth({
  baseBranch: 'trunk',
  settingsBranch: 'canopycms-settings-docs',
  githubTokenSecretArn: ARN('token'),
  githubTokenSecretJsonField: 'token',
  clerkSecretKeySecretArn: ARN('clerk'),
  clerkSecretKeySecretJsonField: 'secretKey',
  protectedBranches: ['release/*'],
  workerCapacity: { type: 'spot' },
})
const appDeployment = synth({
  githubAppId: '123',
  githubAppInstallationId: '456',
  githubAppPrivateKeySecretArn: ARN('app-key'),
  githubAppPrivateKeySecretJsonField: 'privateKey',
})
const all = userDataLines(tokenDeployment)

/** Names the worker must never hold: secrets, names of secrets, AWS and what only the gateway enforces. */
const GATEWAY_ONLY =
  /^(?:CANOPYCMS_GITHUB_TOKEN|CANOPYCMS_GITHUB_APP_|CLERK_SECRET_KEY|AWS_|CANOPYCMS_PROTECTED_BRANCHES$|CANOPYCMS_WORKER_CAPACITY$)/

describe('the environment, split between the two processes', () => {
  const envFiles = (t: Template) => {
    const lines = userDataLines(t)
    const [splitWorker, ...moreWorker] = heredocs(lines, '/opt/canopy-worker/.env').map(parseEnv)
    const [gateway, ...moreGateway] = heredocs(lines, '/opt/canopy-worker/gateway.env').map(
      parseEnv,
    )
    // Each written once, for both layouts.
    expect([moreWorker, moreGateway]).toEqual([[], []])
    return { splitWorker, gateway }
  }
  const environmentFiles = (unit: string[]) =>
    unit.filter((line) => line.startsWith('EnvironmentFile='))

  it.each([
    [
      'a token',
      tokenDeployment,
      [
        'CANOPYCMS_GITHUB_TOKEN_SECRET_ARN',
        'CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD',
        'CLERK_SECRET_KEY_SECRET_ARN',
        'CLERK_SECRET_KEY_SECRET_JSON_FIELD',
        'CANOPYCMS_PROTECTED_BRANCHES',
        WORKER_CAPACITY_ENV,
        'CANOPYCMS_SETTINGS_BRANCH',
      ],
    ],
    [
      'an App',
      appDeployment,
      [
        'CANOPYCMS_GITHUB_APP_ID',
        'CANOPYCMS_GITHUB_APP_INSTALLATION_ID',
        'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN',
        'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD',
      ],
    ],
  ])(
    'gives the split worker nothing secret, and the gateway every secret, with %s',
    (_c, t, configured) => {
      const { splitWorker, gateway } = envFiles(t)
      const workerNames = [...splitWorker.keys()]
      expect(workerNames.filter((name) => GATEWAY_ONLY.test(name))).toEqual([])
      expect(workerNames).toContain('CANOPYCMS_WORKSPACE_ROOT')
      for (const name of configured.filter((n) => GATEWAY_ONLY.test(n))) {
        expect(gateway.has(name), name).toBe(true)
      }
      // Nothing is lost: every variable the props set is in one of the two files.
      const written = new Set([...splitWorker.keys(), ...gateway.keys()])
      for (const name of [
        'CANOPYCMS_WORKSPACE_ROOT',
        'CANOPYCMS_GITHUB_OWNER',
        'CANOPYCMS_GITHUB_REPO',
        'CANOPYCMS_DEPLOYMENT_NAME',
        'AWS_REGION',
        ...configured,
      ]) {
        expect(written, name).toContain(name)
      }
    },
  )

  it('has the split worker read its file alone, the gateway its own, and the single unit both', () => {
    expect(environmentFiles(shippedInstanceFile('canopy-worker.service'))).toEqual([
      'EnvironmentFile=/opt/canopy-worker/.env',
    ])
    expect(environmentFiles(shippedInstanceFile('canopy-github.service'))).toEqual([
      'EnvironmentFile=/opt/canopy-worker/gateway.env',
    ])
    expect(environmentFiles(shippedInstanceFile('canopy-worker-single-process.service'))).toEqual([
      'EnvironmentFile=/opt/canopy-worker/.env',
      'EnvironmentFile=/opt/canopy-worker/gateway.env',
    ])
  })

  it('gives both the repository and the base branch, and only the worker the workspace', () => {
    const { splitWorker, gateway } = envFiles(tokenDeployment)
    for (const name of ['CANOPYCMS_GITHUB_OWNER', 'CANOPYCMS_GITHUB_REPO']) {
      expect(splitWorker.get(name)).toBeDefined()
      expect(gateway.get(name)).toBe(splitWorker.get(name))
    }
    expect(splitWorker.get('CANOPYCMS_BASE_BRANCH')).toBe('trunk')
    expect(gateway.get('CANOPYCMS_BASE_BRANCH')).toBe('trunk')
    expect(gateway.get('CANOPYCMS_PROTECTED_BRANCHES')).toBe('release/*')
    expect(gateway.get(WORKER_CAPACITY_ENV)).toBe('spot')
    expect(gateway.has('CANOPYCMS_WORKSPACE_ROOT')).toBe(false)
    expect(splitWorker.get('CANOPYCMS_SETTINGS_BRANCH')).toBe('canopycms-settings-docs')
  })

  it("creates gateway.env root's alone before writing it, and gives the gateway's group read after adding the user", () => {
    const install = indexOfLine(
      all,
      (l) =>
        l.trim() === 'install -m 0600 -o root -g root /dev/null /opt/canopy-worker/gateway.env',
      'creates gateway.env',
    )
    const write = indexOfLine(
      all,
      (l) => l.includes("cat > /opt/canopy-worker/gateway.env << '"),
      'writes gateway.env',
    )
    const user = indexOfLine(all, (l) => l.includes('useradd --system'), 'adds the user')
    const chown = indexOfLine(
      all,
      (l) => l.trim() === 'chown root:canopy-github /opt/canopy-worker/gateway.env',
      'gives it to the group',
    )
    const chmod = indexOfLine(
      all,
      (l) => l.trim() === 'chmod 0640 /opt/canopy-worker/gateway.env',
      'opens it to the group',
    )
    expect(install).toBeLessThan(write)
    expect(write).toBeLessThan(user)
    expect(user).toBeLessThan(chown)
    expect(chown).toBeLessThan(chmod)
    // Only in the split's branch.
    expect(chmod).toBeLessThan(all.indexOf('else'))
    expect(all[user].trim()).toBe(
      'useradd --system --no-create-home --shell /sbin/nologin canopy-github',
    )
  })

  it('documents every variable the construct can write to gateway.env in the example', () => {
    const example = readFileSync(path.join(PACKAGE_ROOT, 'worker/gateway.env.example'), 'utf-8')
    const documented = new Set(
      example
        .split('\n')
        .map((line) => /^#?([A-Z][A-Z0-9_]+)=/.exec(line)?.[1])
        .filter((name) => name !== undefined),
    )
    for (const t of [tokenDeployment, appDeployment]) {
      for (const name of envFiles(t).gateway.keys()) expect(documented, name).toContain(name)
    }
  })
})

describe('the instance files', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'canopy-instance-files-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  it('are the asset user data downloads, checks against its sha256 and unpacks, under the fail-fast trap', () => {
    expect(readFileSync(SHIPPED_INSTANCE_FILES, 'utf-8')).toBe(instanceFilesScript())
    const download = indexOfLine(
      all,
      (l) => l.startsWith("retry 'worker instance files download' aws s3 cp s3://"),
      'downloads them',
    )
    const check = indexOfLine(
      all,
      (l) =>
        l ===
        `echo '${shippedInstanceFilesSha256()}  /tmp/canopy-instance-files.sh' | sha256sum -c -`,
      'checks them',
    )
    const unpack = indexOfLine(
      all,
      (l) => l === `(cd ${INSTANCE_FILES_DIR} && bash /tmp/canopy-instance-files.sh)`,
      'unpacks them',
    )
    expect(all).toContain(`install -d -o root -g root -m 0700 ${INSTANCE_FILES_DIR}`)
    expect(download).toBeLessThan(check)
    expect(check).toBeLessThan(unpack)
    expect(unpack).toBeLessThan(all.indexOf('trap - ERR'))
  })

  it('unpack into exactly the files the units and the inspect sandbox are made of', () => {
    const run = spawnSync('bash', ['--norc', SHIPPED_INSTANCE_FILES], {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(run.status).toBe(0)
    // A write that fails stops the unpack, which fails the boot.
    expect(readFileSync(SHIPPED_INSTANCE_FILES, 'utf-8').split('\n')[0]).toBe('set -eu')
    expect(Object.keys(instanceFiles()).sort()).toEqual(readdirSync(scratch).sort())
    for (const [name, lines] of Object.entries(instanceFiles())) {
      expect(readFileSync(path.join(scratch, name), 'utf-8'), name).toBe(`${lines.join('\n')}\n`)
    }
  })

  it('install by layout: the split units and canopy-inspect, or the single unit', () => {
    const split = indexOfLine(all, (l) => l.startsWith('if [ "${WORKER_BUNDLE_CONTRACT'), 'splits')
    const otherwise = all.indexOf('else', split)
    const end = all.indexOf('fi', otherwise)
    const installs = (from: number, to: number) =>
      all
        .slice(from, to)
        .filter((l) => l.trim().startsWith(`install -m `) && l.includes(INSTANCE_FILES_DIR))
        .map((l) => l.trim())
    expect(installs(split, otherwise)).toEqual([
      `install -m 0644 ${INSTANCE_FILES_DIR}/canopy-worker.service /etc/systemd/system/canopy-worker.service`,
      `install -m 0644 ${INSTANCE_FILES_DIR}/canopy-github.service /etc/systemd/system/canopy-github.service`,
      `install -m 0644 ${INSTANCE_FILES_DIR}/canopy-github.socket /etc/systemd/system/canopy-github.socket`,
      `install -m 0755 ${INSTANCE_FILES_DIR}/canopy-inspect ${CANOPY_INSPECT}`,
      `install -m 0755 ${INSTANCE_FILES_DIR}/inspect-checks ${INSPECT_CHECKS}`,
      `install -m 0644 ${INSTANCE_FILES_DIR}/inspect.rc ${INSPECT_RC}`,
    ])
    expect(installs(otherwise, end)).toEqual([
      `install -m 0644 ${INSTANCE_FILES_DIR}/canopy-worker-single-process.service /etc/systemd/system/canopy-worker.service`,
    ])
  })

  it('leave user data with typical long names well inside the 16 KiB EC2 allows', () => {
    const arn = (name: string) =>
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name.padEnd(80, 'x')}`
    const t = synth({
      githubOwner: 'o'.repeat(39),
      githubRepo: 'r'.repeat(100),
      baseBranch: `b${'x'.repeat(99)}`,
      settingsBranch: `canopycms-settings-${'s'.repeat(80)}`,
      githubAppId: '123456789',
      githubAppInstallationId: '123456789',
      githubAppPrivateKeySecretArn: arn('app'),
      githubAppPrivateKeySecretJsonField: 'f'.repeat(60),
      clerkSecretKeySecretArn: arn('clerk'),
      clerkSecretKeySecretJsonField: 'f'.repeat(60),
      protectedBranches: Array.from({ length: 20 }, (_, i) => `release-${i}/*`),
      workerCapacity: { type: 'spot' },
    })
    // Each Ref (the log group included) as 100 bytes; the synth-time bound is addUserData's,
    // tested below.
    const bytes = Buffer.byteLength(
      userDataLines(t)
        .join('\n')
        .replace(/REF_\w+/g, 'x'.repeat(100)),
    )
    expect(bytes).toBeLessThan(16_384 - 4_096)
  })

  it('are refused at synth when the props could take user data past 16 KiB', () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => `release-${i}/*`)
    expect(() => synth({ protectedBranches: many(200) })).not.toThrow()
    expect(() => synth({ protectedBranches: many(700) })).toThrow(
      /user data could reach \d+ bytes, over the 16384 EC2 accepts; protectedBranches has 700 entries\./,
    )
    expect(() => synth({ workerLogGroupName: `/canopycms/${'g'.repeat(500)}` })).not.toThrow()
  })

  it('state the protectedBranches count without blaming it when other names fill user data', () => {
    const long = (name: string) =>
      `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name}-${'x'.repeat(4_000)}`
    expect(() =>
      synth({
        workerLogGroupName: `/canopycms/${'g'.repeat(500)}`,
        githubTokenSecretArn: long('token'),
        clerkSecretKeySecretArn: long('clerk'),
      }),
    ).toThrow(
      /protectedBranches has 0 entries\. Protect branches with fewer, wider \* patterns, or shorten the other names/,
    )
  })

  it('measure the log group by its configured name and a token-valued ARN at its longest', () => {
    const measured = (overrides: Partial<CanopyCmsServiceProps>) => {
      try {
        synth({
          protectedBranches: Array.from({ length: 700 }, (_, i) => `release-${i}/*`),
          ...overrides,
        })
      } catch (err) {
        const bytes = /could reach (\d+) bytes/.exec(String(err))?.[1]
        if (bytes) return Number(bytes)
      }
      throw new Error('expected the size check to refuse')
    }
    const base = measured({})
    // The log group's name appears in both CloudWatch entries.
    const longName = `/canopycms/${'g'.repeat(500)}`
    expect(measured({ workerLogGroupName: longName }) - base).toBe(
      2 * (longName.length - '/canopycms/TestStack/worker'.length),
    )
    // A token-valued ARN counts as 640 bytes, not as the 128 of the construct's own values.
    const literal = measured({ githubTokenSecretArn: ARN('t') })
    const token = measured({ githubTokenSecretArn: Fn.importValue('TokenArn') })
    expect(token - literal).toBe(640 - ARN('t').length)
  })

  it('keep every heredoc body as written, and refuse a heredoc form they cannot follow', () => {
    expect(
      withoutShellComments(
        '#!/bin/bash',
        '# a comment',
        "  # an indented one, ending as an opener would << 'X'",
        "cat > f << 'BODY'",
        '# kept: part of the file',
        'BODY',
        'echo done # trailing text stays',
      ),
    ).toEqual([
      '#!/bin/bash',
      "cat > f << 'BODY'",
      '# kept: part of the file',
      'BODY',
      'echo done # trailing text stays',
    ])
    expect(() => withoutShellComments('cat > f << BODY', 'x', 'BODY')).toThrow(/unquoted heredoc/)
    expect(() => withoutShellComments("cat > f <<- 'BODY'", 'x', 'BODY')).toThrow(
      /unquoted heredoc/,
    )
  })

  it('leave no shell comment in user data outside a heredoc', () => {
    let heredocEnd: string | undefined
    const comments = all.filter((line) => {
      if (heredocEnd !== undefined) {
        if (line === heredocEnd) heredocEnd = undefined
        return false
      }
      heredocEnd = /<< '(\w+)'$/.exec(line)?.[1]
      return /^\s*#(?!!)/.test(line)
    })
    expect(comments).toEqual([])
    expect(heredocEnd).toBeUndefined()
  })
})

describe('the units', () => {
  const splitWorker = shippedInstanceFile('canopy-worker.service')
  const singleProcessWorker = shippedInstanceFile('canopy-worker-single-process.service')

  it('ships the split units in the package byte for byte as the instance gets them', () => {
    const checkedIn = (name: string) =>
      readFileSync(path.join(PACKAGE_ROOT, 'worker', name), 'utf-8')
    expect(splitWorker).toEqual(workerUnit('split'))
    expect(shippedInstanceFile('canopy-github.service')).toEqual(gatewayUnit())
    expect(shippedInstanceFile('canopy-github.socket')).toEqual(gatewaySocketUnit())
    expect(checkedIn('canopy-worker.service')).toBe(`${workerUnit('split').join('\n')}\n`)
    expect(checkedIn('canopy-github.service')).toBe(`${gatewayUnit().join('\n')}\n`)
    expect(checkedIn('canopy-github.socket')).toBe(`${gatewaySocketUnit().join('\n')}\n`)
  })

  it('stamps the split units with the current contract and the single unit with the one before it', () => {
    expect(splitWorker).toContain(`Environment=${WORKER_CONTRACT_ENV}=${WORKER_CONTRACT_VERSION}`)
    expect(gatewayUnit()).toContain(`Environment=${WORKER_CONTRACT_ENV}=${WORKER_CONTRACT_VERSION}`)
    expect(singleProcessWorker).toContain(
      `Environment=${WORKER_CONTRACT_ENV}=${SINGLE_PROCESS_UNIT_CONTRACT}`,
    )
    expect(SINGLE_PROCESS_UNIT_CONTRACT).toBe(GATEWAY_SPLIT_CONTRACT - 1)
    expect(WORKER_CONTRACT_VERSION).toBe(GATEWAY_SPLIT_CONTRACT)
  })

  it('cuts the split worker off from the network, and points it at the gateway', () => {
    for (const line of WORKER_SPLIT_SANDBOX) expect(splitWorker).toContain(line)
    // Spelled out, so a change to the shared constant cannot pass by changing what it checks.
    for (const line of [
      'PrivateNetwork=yes',
      'IPAddressDeny=any',
      'RestrictAddressFamilies=AF_UNIX',
      'PrivateIPC=yes',
      'InaccessiblePaths=-/run/dbus',
      'InaccessiblePaths=-/dev/shm',
      'InaccessiblePaths=-/var/log/journal',
      'InaccessiblePaths=-/run/log/journal',
      'SystemCallFilter=@system-service',
      'LimitCORE=0',
      'ProtectProc=invisible',
      'ProtectHome=tmpfs',
      'NoNewPrivileges=yes',
      'ReadWritePaths=/mnt/efs',
    ]) {
      expect(splitWorker).toContain(line)
    }
    expect(splitWorker).toContain(
      `Environment=${GITHUB_GATEWAY_SOCKET_ENV}=${GITHUB_GATEWAY_SOCKET_PATH}`,
    )
    expect(splitWorker).toContain('Requires=canopy-github.socket')
    expect(splitWorker).toContain('After=canopy-github.socket canopy-github.service')
    // Not bound to the gateway's restarts: an auto-restart of a bound unit restarts this one.
    expect(
      splitWorker.filter((l) => /^(BindsTo|PartOf|Requires)=.*canopy-github\.service/.test(l)),
    ).toEqual([])
  })

  it('leaves the single unit as before the split: no cut, no socket', () => {
    for (const line of WORKER_SANDBOX_DIRECTIVES) expect(singleProcessWorker).toContain(line)
    for (const line of ['PrivateNetwork=yes', 'IPAddressDeny=any', 'LimitCORE=0']) {
      expect(singleProcessWorker).not.toContain(line)
    }
    expect(singleProcessWorker.join('\n')).not.toContain('canopy-github')
  })

  it('runs the gateway as its own user, with a private state directory and no EFS', () => {
    const gateway = gatewayUnit()
    for (const line of [
      'User=canopy-github',
      'Group=canopy-github',
      'ExecStart=/usr/bin/node-22 index.js gateway',
      'Sockets=canopy-github.socket',
      'Requires=canopy-github.socket',
      'StateDirectory=canopy-github',
      'StateDirectoryMode=0700',
      'EnvironmentFile=/opt/canopy-worker/gateway.env',
      'InaccessiblePaths=/mnt/efs',
      'RequiresMountsFor=/mnt/efs',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
      'LimitCORE=0',
      'InaccessiblePaths=-/dev/shm',
      'KillMode=mixed',
      'WantedBy=multi-user.target',
    ]) {
      expect(gateway).toContain(line)
    }
  })

  it('restarts the gateway for as long as it fails, never giving up', () => {
    const gateway = gatewayUnit()
    expect(gateway).toContain('Restart=always')
    expect(gateway).toContain('StartLimitIntervalSec=0')
    // In [Unit], where systemd 252 reads it.
    expect(gateway.indexOf('StartLimitIntervalSec=0')).toBeLessThan(gateway.indexOf('[Service]'))
  })

  it('opens the socket to the worker user alone, in a root-owned directory', () => {
    const socket = gatewaySocketUnit()
    for (const line of [
      `ListenStream=${GITHUB_GATEWAY_SOCKET_PATH}`,
      'SocketUser=ec2-user',
      'SocketMode=0600',
      'DirectoryMode=0755',
      'WantedBy=sockets.target',
    ]) {
      expect(socket).toContain(line)
    }
    expect(socket.filter((l) => l.startsWith('Accept='))).toEqual([])
  })

  it.each([
    ['split worker', () => splitWorker],
    ['single-process worker', () => singleProcessWorker],
    ['gateway', gatewayUnit],
  ])('gives the %s no log directory of its own', (_name, unit) => {
    expect(unit().filter((l) => l.startsWith('LogsDirectory'))).toEqual([])
    expect(unit().filter((l) => l.startsWith('StandardOutput=append:/var/log/'))).toHaveLength(1)
  })
})

describe('the host settings the split rests on', () => {
  it('turns core dumps off for every service, and keeps fallback tunnels out of new namespaces', () => {
    const [sysctl] = heredocs(all, '/etc/sysctl.d/99-canopy.conf')
    expect(sysctl).toEqual([
      'kernel.core_pattern = core',
      'fs.suid_dumpable = 0',
      'net.core.fb_tunnels_only_for_init_net = 1',
    ])
    const write = indexOfLine(
      all,
      (l) => l.includes('/etc/sysctl.d/99-canopy.conf <<'),
      'writes it',
    )
    const apply = indexOfLine(
      all,
      (l) => l.trim() === 'sysctl -q -e -p /etc/sysctl.d/99-canopy.conf',
      'applies it',
    )
    const limit = indexOfLine(
      all,
      (l) =>
        l.includes('DefaultLimitCORE=0') && l.includes('/etc/systemd/system.conf.d/canopy.conf'),
      'sets the default core limit',
    )
    const reload = indexOfLine(all, (l) => l === 'systemctl daemon-reload', 'reloads systemd')
    const start = indexOfLine(
      all,
      (l) => l.trim() === 'systemctl enable --now canopy-github.socket canopy-github.service',
      'starts the gateway',
    )
    expect(write).toBeLessThan(apply)
    expect(apply).toBeLessThan(start)
    expect(limit).toBeLessThan(reload)
    expect(reload).toBeLessThan(start)
  })

  it('creates the gateway log root-owned and private before the gateway starts', () => {
    const dir = indexOfLine(
      all,
      (l) => l.trim() === 'install -d -o root -g root -m 0755 /var/log/canopy-github',
      'creates the directory',
    )
    const file = indexOfLine(
      all,
      (l) =>
        l.trim() === 'install -o root -g root -m 0640 /dev/null /var/log/canopy-github/gateway.log',
      'creates the file',
    )
    const start = indexOfLine(
      all,
      (l) => l.includes('systemctl enable --now canopy-github'),
      'starts it',
    )
    expect(dir).toBeLessThan(file)
    expect(file).toBeLessThan(start)
    expect(all.join('\n')).not.toMatch(/ch(own|mod)[^\n]*\/var\/log\/canopy-github/)
  })
})

describe('the layout a bundle gets, by its contract banner', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'canopy-banner-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  /** User-data's own selection lines, run against a bundle whose first lines are `head`. */
  function layoutFor(head: string): string {
    const bundle = path.join(scratch, `b${Math.random().toString(36).slice(2)}.js`)
    writeFileSync(bundle, `${head}\nconsole.log(1)\n`)
    const from = indexOfLine(
      all,
      (l) => l.startsWith('WORKER_BUNDLE_CONTRACT=$('),
      'reads the banner',
    )
    const condition = indexOfLine(
      all,
      (l) => l.startsWith('if [ "${WORKER_BUNDLE_CONTRACT'),
      'tests it',
    )
    const script = [
      'set -euo pipefail',
      ...all.slice(from, condition).map((l) => l.replace('/opt/canopy-worker/index.js', bundle)),
      all[condition],
      '  echo split',
      'else',
      '  echo single-process',
      'fi',
    ].join('\n')
    const run = spawnSync('bash', ['--norc', '-c', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    return run.stdout.trim()
  }

  const banner = (n: string | number) => `${WORKER_CONTRACT_BANNER_PREFIX}${n}`

  it.each<[string, string, string]>([
    [
      'the split contract, under the hashbang',
      `#!/usr/bin/env node\n${banner(GATEWAY_SPLIT_CONTRACT)}`,
      'split',
    ],
    ['a later contract', banner(GATEWAY_SPLIT_CONTRACT + 7), 'split'],
    ['the contract before the split', `#!/usr/bin/env node\n${banner(1)}`, 'single-process'],
    ['no banner', '#!/usr/bin/env node\nimport x from "y"', 'single-process'],
    [
      'a banner past line 5',
      `${'//\n'.repeat(5)}${banner(GATEWAY_SPLIT_CONTRACT)}`,
      'single-process',
    ],
    ['a banner with trailing text', `${banner(GATEWAY_SPLIT_CONTRACT)} x`, 'single-process'],
    ['a number too long to be a contract', banner('99999'), 'single-process'],
  ])('%s gets the %s layout', (_case, head, layout) => {
    expect(layoutFor(head)).toBe(layout)
  })

  it('reads the built bundle as the contract it was built for, which is the split', () => {
    const head = readFileSync(path.join(PACKAGE_ROOT, 'worker/dist/index.js'), 'utf-8')
      .split('\n')
      .slice(0, 5)
    expect(head).toContain(banner(WORKER_CONTRACT_VERSION))
    expect(layoutFor(head.join('\n'))).toBe('split')
  })
})

describe('canopy-inspect', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'canopy-inspect-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  it('ships its three files as the instance gets them', () => {
    expect(shippedInstanceFile('canopy-inspect')).toEqual(canopyInspectScript())
    expect(shippedInstanceFile('inspect-checks')).toEqual(inspectChecksScript())
    expect(shippedInstanceFile('inspect.rc')).toEqual(inspectRc())
  })

  /** The wrapper, with systemd-run replaced by a stub that prints its argv and stdin, exiting `status`. */
  function inspect(args: string[], status = 0) {
    const stub = path.join(scratch, 'systemd-run')
    writeFileSync(
      stub,
      `#!/bin/bash\nprintf '%s\\n' "$@"\necho "stdin:$(cat | wc -c | tr -d ' ')"\nprintf '\\033]52;c;x\\007' >&2\nexit ${status}\n`,
    )
    chmodSync(stub, 0o755)
    const script = canopyInspectScript().join('\n').replaceAll('/usr/bin/systemd-run', stub)
    return spawnSync('bash', ['--norc', '-c', script, 'canopy-inspect', ...args], {
      encoding: 'utf8',
      input: 'operator terminal input',
    })
  }

  it("runs the command after `--`, as the worker's user, under the worker unit's sandbox", () => {
    const run = inspect(['-a', 'git', 'status'])
    const argv = run.stdout.split('\n')
    const props = argv.flatMap((arg, i) => (argv[i - 1] === '-p' ? [arg] : []))
    expect(props).toEqual([...WORKER_SPLIT_SANDBOX])
    expect(argv).toEqual(
      expect.arrayContaining(['--uid=ec2-user', '--gid=ec2-user', '--pipe', '--wait']),
    )
    const dashdash = argv.indexOf('--')
    expect(argv.slice(dashdash + 1, dashdash + 5)).toEqual([INSPECT_CHECKS, '-a', 'git', 'status'])
  })

  it("reads nothing from the operator's terminal and shows the sandbox's output only through cat -v", () => {
    const run = inspect(['true'])
    expect(run.stdout).toContain('stdin:0')
    // The escape the sandbox wrote on stderr arrives on stdout, made visible.
    expect(run.stdout).toContain('^[]52;c;x^G')
    expect(run.stderr).toBe('')
  })

  it("exits with the sandbox's status, so a refusal is the caller's failure", () => {
    expect(inspect(['true'], 1).status).toBe(1)
    expect(inspect(['true'], 0).status).toBe(0)
  })

  it('opens a shell only with --interactive, through a pty, with its own rc file', () => {
    const run = inspect(['--interactive'])
    const argv = run.stdout.split('\n')
    expect(argv).toContain('--pty')
    const dashdash = argv.indexOf('--')
    expect(argv.slice(dashdash + 1, dashdash + 7)).toEqual([
      INSPECT_CHECKS,
      '/bin/bash',
      '--noprofile',
      '--rcfile',
      INSPECT_RC,
      '-i',
    ])
    expect(run.stderr).toMatch(/paste nothing from it into a root shell/)
    expect(inspect([]).status).toBe(2)
    expect(inspect(['--interactive', 'x']).status).toBe(2)
  })

  it('runs every check before the command, in the same process, through exec --', () => {
    const checks = inspectChecksScript()
    expect(checks[checks.length - 1]).toBe('exec -- "$@"')
    expect(checks).toContain('/usr/bin/node-22 /opt/canopy-worker/index.js self-check ||')
    expect(checks.slice(0, -1).join('\n')).not.toContain('"$@"')
  })
})
