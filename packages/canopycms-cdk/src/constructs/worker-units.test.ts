/**
 * The worker instance's units under the process split, as user-data writes them: which layout a
 * bundle gets, what each process's environment holds, the units and their checked-in copies,
 * the host settings the split rests on, and the `canopy-inspect` sandbox.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { aws_ecr as ecr, aws_lambda as lambda } from 'aws-cdk-lib'

import { CanopyCmsService } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { newTestApp } from '../../test-support/test-synth'
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
  SINGLE_PROCESS_UNIT_CONTRACT,
  WORKER_SANDBOX_DIRECTIVES,
  WORKER_SPLIT_SANDBOX,
  canopyInspectScript,
  gatewaySocketUnit,
  gatewayUnit,
  inspectChecksScript,
  inspectRc,
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
  all.forEach((line, i) => {
    const open = new RegExp(`^\\s*cat > ${target.replace(/[.]/g, '\\.')} << '(\\w+)'$`).exec(line)
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
    const [splitWorker, singleProcess] = heredocs(lines, '/opt/canopy-worker/.env').map(parseEnv)
    const [gateway] = heredocs(lines, '/opt/canopy-worker/gateway.env').map(parseEnv)
    return { splitWorker, singleProcess, gateway }
  }

  it.each([
    ['a token', tokenDeployment],
    ['an App', appDeployment],
  ])('gives the split worker nothing secret, and the gateway every secret, with %s', (_c, t) => {
    const { splitWorker, singleProcess, gateway } = envFiles(t)
    const workerNames = [...splitWorker.keys()]
    expect(workerNames.filter((name) => GATEWAY_ONLY.test(name))).toEqual([])
    expect(workerNames).toContain('CANOPYCMS_WORKSPACE_ROOT')
    // Every gateway-only name the single process holds is the gateway's under the split.
    const secretNames = [...singleProcess.keys()].filter((name) => GATEWAY_ONLY.test(name))
    expect(secretNames.length).toBeGreaterThan(2)
    for (const name of secretNames) expect(gateway.get(name)).toBe(singleProcess.get(name))
    // And nothing is lost: every single-process entry is in one of the two.
    for (const [name, value] of singleProcess) {
      expect(splitWorker.get(name) ?? gateway.get(name), name).toBe(value)
    }
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

  it('creates gateway.env with its mode and group, after the user and before writing it', () => {
    const user = indexOfLine(all, (l) => l.includes('useradd --system'), 'adds the user')
    const install = indexOfLine(
      all,
      (l) =>
        l.trim() ===
        'install -m 0640 -o root -g canopy-github /dev/null /opt/canopy-worker/gateway.env',
      'creates gateway.env',
    )
    const write = indexOfLine(
      all,
      (l) => l.includes("cat > /opt/canopy-worker/gateway.env << '"),
      'writes gateway.env',
    )
    expect(user).toBeLessThan(install)
    expect(install).toBeLessThan(write)
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

describe('the units', () => {
  const [splitWorker, singleProcessWorker] = heredocs(
    all,
    '/etc/systemd/system/canopy-worker.service',
  )

  it('writes the split units user-data and the package ship, byte for byte', () => {
    const checkedIn = (name: string) =>
      readFileSync(path.join(PACKAGE_ROOT, 'worker', name), 'utf-8')
    expect(splitWorker).toEqual(workerUnit('split'))
    expect(heredocs(all, '/etc/systemd/system/canopy-github.service')).toEqual([gatewayUnit()])
    expect(heredocs(all, '/etc/systemd/system/canopy-github.socket')).toEqual([gatewaySocketUnit()])
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
      (l) => l.trim() === 'sysctl -q -p /etc/sysctl.d/99-canopy.conf',
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

  it('installs its three files, root-owned, the scripts executable', () => {
    expect(heredocs(all, CANOPY_INSPECT)).toEqual([canopyInspectScript()])
    expect(heredocs(all, INSPECT_CHECKS)).toEqual([inspectChecksScript()])
    expect(heredocs(all, INSPECT_RC)).toEqual([inspectRc()])
    expect(all.map((l) => l.trim())).toContain(`chmod 0755 ${CANOPY_INSPECT} ${INSPECT_CHECKS}`)
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
