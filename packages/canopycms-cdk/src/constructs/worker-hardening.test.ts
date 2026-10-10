/**
 * The worker instance's hardening: IMDSv2, the integrity-checked and narrowly
 * readable bundle, IAM- and TLS-only EFS, the encrypted root volume, patching
 * between deploys and a boot that survives a failed upgrade, EFS backups and
 * the systemd sandbox.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Duration, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { aws_ecr as ecr, aws_iam as iam, aws_lambda as lambda, aws_sns as sns } from 'aws-cdk-lib'

import { CanopyCmsService } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { newTestApp } from '../../test-support/test-synth'

interface Statement {
  Effect: string
  Action: string | string[]
  Resource?: unknown
  Principal?: unknown
  Condition?: Record<string, Record<string, unknown>>
}

function synth(
  overrides:
    | Partial<CanopyCmsServiceProps>
    | ((stack: Stack) => Partial<CanopyCmsServiceProps>) = {},
  context: Record<string, unknown> = {},
): Template {
  const app = newTestApp({ context })
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
    ...(typeof overrides === 'function' ? overrides(stack) : overrides),
  })
  return Template.fromStack(stack)
}

const template = synth()

function only(resources: Record<string, { Properties?: unknown }>): {
  id: string
  props: Record<string, unknown>
} {
  const entries = Object.entries(resources)
  expect(entries).toHaveLength(1)
  return { id: entries[0][0], props: (entries[0][1].Properties ?? {}) as Record<string, unknown> }
}

const launchTemplateData = (t: Template) =>
  only(t.findResources('AWS::EC2::LaunchTemplate')).props.LaunchTemplateData as Record<
    string,
    unknown
  >

/** The user-data script with every `Ref` rendered as `<LogicalId>`. */
function userDataScript(t: Template): string {
  const render = (node: unknown): string => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(render).join('')
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (typeof obj.Ref === 'string') return `<${obj.Ref}>`
      const join = obj['Fn::Join']
      if (Array.isArray(join)) {
        const [sep, parts] = join as [string, unknown[]]
        return parts.map(render).join(sep)
      }
      if ('Fn::Base64' in obj) return render(obj['Fn::Base64'])
    }
    throw new Error(`userDataScript: unhandled node ${JSON.stringify(node)}`)
  }
  return render(launchTemplateData(t).UserData)
}

const lines = (t: Template) => userDataScript(t).split('\n')

/** Index of the first line containing `needle`, asserting there is one. */
function lineIndex(all: string[], needle: string): number {
  const i = all.findIndex((l) => l.includes(needle))
  expect(i, `no user-data line contains ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0)
  return i
}

function statementsOf(t: Template, roleLogicalId: string): Statement[] {
  return Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p) =>
      JSON.stringify((p.Properties as { Roles: unknown }).Roles).includes(
        JSON.stringify({ Ref: roleLogicalId }),
      ),
    )
    .flatMap(
      (p) =>
        (p.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement,
    )
}

const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action])

function workerRoleId(t: Template): string {
  return only(
    t.findResources('AWS::IAM::Role', {
      Properties: Match.objectLike({ Description: 'CanopyCMS EC2 Worker role' }),
    }),
  ).id
}

const fileSystem = (t: Template) => only(t.findResources('AWS::EFS::FileSystem'))
const accessPointId = (t: Template) => only(t.findResources('AWS::EFS::AccessPoint')).id

const BUNDLE = path.join(__dirname, '../../worker/dist/index.js')

describe('instance metadata', () => {
  it('requires IMDSv2 tokens and keeps their responses on the host', () => {
    expect(launchTemplateData(template).MetadataOptions).toEqual({
      HttpTokens: 'required',
      HttpPutResponseHopLimit: 1,
    })
  })
})

describe('the worker bundle', () => {
  const all = lines(template)
  const copyLine = all[lineIndex(all, 'aws s3 cp s3://')]
  const [, bucket, key] = /s3:\/\/([^/]+)\/(\S+) /.exec(copyLine) ?? []

  it('is the bundle file itself, so its hash is known at synth', () => {
    expect(key).toMatch(/^[0-9a-f]{64}\.js$/)
    expect(userDataScript(template)).not.toContain('unzip')
  })

  it('is refused unless its sha256 matches the file synthesized', () => {
    const sha = createHash('sha256').update(readFileSync(BUNDLE)).digest('hex')
    const check = lineIndex(all, 'sha256sum -c -')
    expect(all[check]).toBe(`echo '${sha}  /tmp/canopy-worker.js' | sha256sum -c -`)
    // Checked after the download and before anything installs or runs it.
    expect(check).toBeGreaterThan(all.indexOf(copyLine))
    expect(check).toBeLessThan(lineIndex(all, '/opt/canopy-worker/index.js'))
    expect(check).toBeLessThan(lineIndex(all, 'systemctl start canopy-worker'))
    // Under the fail-fast trap, so a mismatch replaces the instance.
    expect(check).toBeLessThan(all.indexOf('trap - ERR'))
  })

  it('is the only object in the asset bucket the worker can read', () => {
    const statements = statementsOf(template, workerRoleId(template))
    const s3 = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('s3:')))
    expect(s3).toHaveLength(1)
    expect(actionsOf(s3[0])).toEqual(['s3:GetObject'])
    const resource = JSON.stringify(s3[0].Resource)
    expect(resource).toContain(`${bucket}/${key}`)
    expect(resource).not.toContain('/*')
  })
})

describe('EFS access requires IAM and TLS', () => {
  const policyOf = (t: Template) =>
    (fileSystem(t).props.FileSystemPolicy as { Statement: Statement[] } | undefined)?.Statement

  const denyPlaintext: Statement = {
    Effect: 'Deny',
    Principal: { AWS: '*' },
    Action: [
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite',
      'elasticfilesystem:ClientRootAccess',
    ],
    Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  }

  it('denies plaintext and grants nothing to anonymous clients', () => {
    // With a policy in effect, a client mounting without `iam` is evaluated
    // against Principal "*" statements alone, so no Allow here means no mount.
    expect(policyOf(template)).toEqual([denyPlaintext])
  })

  it("keeps CDK's anonymous-access statement out under its feature flag too", () => {
    const flagged = synth({}, { '@aws-cdk/aws-efs:denyAnonymousAccess': true })
    expect(policyOf(flagged)).toEqual([denyPlaintext])
  })

  it('carries no policy while a live stack moves its worker to an IAM mount first', () => {
    const stepOne = synth({ efsEnforceIamAndTls: false })
    expect(fileSystem(stepOne).props.FileSystemPolicy).toBeUndefined()
    // Everything else the enforced policy needs is already in place.
    expect(userDataScript(stepOne)).toContain('-o tls,iam,accesspoint=')
    expect(statementsOf(stepOne, workerRoleId(stepOne))).toContainEqual(
      expect.objectContaining({
        Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      }),
    )
  })

  it('mounts on the worker with IAM, now and after a reboot', () => {
    const ap = accessPointId(template)
    const fsId = fileSystem(template).id
    const all = lines(template)
    expect(all).toContain(
      `retry 'EFS mount' mount -t efs -o tls,iam,accesspoint=<${ap}> <${fsId}>:/ /mnt/efs`,
    )
    expect(all).toContain(
      `echo '<${fsId}>:/ /mnt/efs efs _netdev,tls,iam,accesspoint=<${ap}> 0 0' >> /etc/fstab`,
    )
  })

  it('grants the worker mount and write on this file system through its access point only', () => {
    const statements = statementsOf(template, workerRoleId(template))
    const client = statements.filter((s) =>
      actionsOf(s).some((a) => a.startsWith('elasticfilesystem:Client')),
    )
    expect(client).toHaveLength(1)
    expect(client[0]).toMatchObject({
      Effect: 'Allow',
      Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
      Resource: { 'Fn::GetAtt': [fileSystem(template).id, 'Arn'] },
    })
    expect(Object.keys(client[0].Condition?.StringEquals ?? {})).toEqual([
      'elasticfilesystem:AccessPointArn',
    ])
    expect(JSON.stringify(client[0].Condition)).toContain(accessPointId(template))
  })

  it('no longer attaches the account-wide EFS client managed policy', () => {
    expect(JSON.stringify(template.findResources('AWS::IAM::Role'))).not.toContain(
      'AmazonElasticFileSystemClientReadWriteAccess',
    )
  })

  it.each([
    ['the role CDK creates', false],
    ['a role the adopter passes', true],
  ])('leaves the Lambda able to mount through the access point (%s)', (_label, passRole) => {
    const t = passRole
      ? synth((stack) => ({
          lambdaRole: new iam.Role(stack, 'PassedRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          }),
        }))
      : template
    const fn = only(t.findResources('AWS::Lambda::Function'))
    const roleRef = fn.props.Role as { 'Fn::GetAtt': [string, string] }
    const statements = statementsOf(t, roleRef['Fn::GetAtt'][0])
    // CDK's `fromEfsAccessPoint` grants: mount only through the access point,
    // write only on this file system.
    const mount = statements.find((s) => actionsOf(s).includes('elasticfilesystem:ClientMount'))
    expect(JSON.stringify(mount?.Condition ?? null)).toContain(accessPointId(t))
    const write = statements.find((s) => actionsOf(s).includes('elasticfilesystem:ClientWrite'))
    expect(JSON.stringify(write?.Resource ?? null)).toContain(fileSystem(t).id)
  })

  it('updates the worker role before the group rolls, so a new worker boots with its grants', () => {
    // CDK makes the launch template wait for the role's policy, and the group
    // reads the template's latest version.
    const roleId = workerRoleId(template)
    const [defaultPolicyId] = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([, p]) =>
        JSON.stringify((p.Properties as { Roles: unknown }).Roles).includes(roleId),
      )
      .map(([id]) => id)
      .filter((id) => id.startsWith('CmsWorkerRoleDefaultPolicy'))
    expect(defaultPolicyId).toBeDefined()
    const [lt] = Object.entries(template.findResources('AWS::EC2::LaunchTemplate'))
    expect((lt[1] as { DependsOn?: string[] }).DependsOn).toContain(defaultPolicyId)
    expect(
      JSON.stringify(only(template.findResources('AWS::AutoScaling::AutoScalingGroup')).props),
    ).toContain(JSON.stringify({ 'Fn::GetAtt': [lt[0], 'LatestVersionNumber'] }))
  })
})

describe('the root volume', () => {
  it('is an explicitly encrypted gp3 volume on the AMI root device', () => {
    expect(launchTemplateData(template).BlockDeviceMappings).toEqual([
      {
        // No VolumeSize: the AMI snapshot's size, whatever it grows to.
        DeviceName: '/dev/xvda',
        Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeType: 'gp3' },
      },
    ])
  })
})

describe('patching between deploys', () => {
  it('moves to the latest AL2023 release before installing anything', () => {
    const all = lines(template)
    const upgrade = lineIndex(all, 'dnf upgrade')
    expect(all[upgrade]).toBe(
      "if ! retry 'dnf upgrade' dnf upgrade --releasever=latest --exclude='kernel*' -y; then",
    )
    expect(upgrade).toBeLessThan(lineIndex(all, 'dnf install'))
    expect(upgrade).toBeGreaterThan(lineIndex(all, 'retry() {'))
  })

  it('recycles the instance weekly by default', () => {
    expect(only(template.findResources('AWS::AutoScaling::AutoScalingGroup')).props).toMatchObject({
      MaxInstanceLifetime: 7 * 24 * 60 * 60,
    })
  })

  it('takes another lifetime, or none', () => {
    const asgProps = (t: Template) =>
      only(t.findResources('AWS::AutoScaling::AutoScalingGroup')).props
    expect(
      asgProps(synth({ workerMaxInstanceLifetime: Duration.days(14) })).MaxInstanceLifetime,
    ).toBe(14 * 24 * 60 * 60)
    expect(asgProps(synth({ workerMaxInstanceLifetime: null })).MaxInstanceLifetime).toBeUndefined()
  })

  it('refuses a lifetime Auto Scaling would reject', () => {
    expect(() => synth({ workerMaxInstanceLifetime: Duration.hours(12) })).toThrow(/1 and 365 days/)
  })
})

describe('boot memory', () => {
  const all = lines(template)

  it('turns on swap before the first dnf', () => {
    const firstDnf = all.findIndex((l) => /^\s*(if ! )?retry '[^']+' dnf /.test(l))
    expect(firstDnf).toBeGreaterThan(0)
    expect(lineIndex(all, 'if ! setup_swap; then')).toBeLessThan(firstDnf)
  })

  it('makes a 1 GiB swap file once, keeps it across reboots, and swaps reluctantly', () => {
    for (const line of [
      '  swapon --show=NAME --noheadings | grep -qx /swapfile && return 0',
      '  if [ "$(stat -c %s /swapfile 2>/dev/null)" != 1073741824 ]; then',
      '    fallocate -l 1G /swapfile || return 1',
      '  chmod 600 /swapfile || return 1',
      '  mkswap /swapfile || return 1',
      "  grep -qs '^/swapfile ' /etc/fstab || echo '/swapfile none swap defaults 0 0' >> /etc/fstab || return 1",
      '  mkdir -p /etc/sysctl.d || return 1',
      "  echo 'vm.swappiness = 10' > /etc/sysctl.d/90-canopy-worker-swap.conf || return 1",
      '  sysctl -q -w vm.swappiness=10 || return 1',
      '  swapon /swapfile',
    ]) {
      expect(all).toContain(line)
    }
    // swapon is the last command, so swap is never on when setup_swap reports failure.
    const end = all.indexOf('}', all.indexOf('setup_swap() {'))
    expect(all[end - 1]).toBe('  swapon /swapfile')
  })
})

describe('boot failures name their step', () => {
  const all = lines(template)

  it('gives every retried step its own name', () => {
    const calls = all.filter((l) => /^\s*(if ! )?retry /.test(l))
    const names = calls.map((l) => /retry '([^']+)' /.exec(l)?.[1])
    expect(names).toEqual([
      'dnf upgrade',
      'dnf install git',
      'dnf install nodejs22',
      'dnf install amazon-efs-utils',
      'EFS mount',
      'worker bundle download',
      'dnf install amazon-cloudwatch-agent logrotate',
    ])
    expect(all).toContain(`      echo "canopy-worker boot: '$step' failed after $n attempts" >&2`)
  })

  it('writes the unpatched line the alarm counts, in the worker log format', () => {
    const withTopic = synth((stack) => ({ alarmTopic: new sns.Topic(stack, 'Alerts') }))
    const filters = Object.entries(withTopic.findResources('AWS::Logs::MetricFilter'))
    const [, unpatched] = filters.find(([id]) => id.startsWith('CmsWorkerUnpatchedBoots'))!
    const pattern = (unpatched.Properties as { FilterPattern: string }).FilterPattern
    const phrase = JSON.parse(pattern) as string
    const logLine = all.find((l) => l.includes('>> /var/log/canopy-worker/worker.log'))
    expect(logLine).toBe(
      `  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) ERROR canopy-worker boot: 'dnf upgrade' failed; ${phrase}" >> /var/log/canopy-worker/worker.log`,
    )
    expect(all).toContain(`  echo "canopy-worker boot: ${phrase}" >&2`)
    // Written before the worker starts, so it is the first line of the log.
    expect(all.indexOf(logLine!)).toBeLessThan(lineIndex(all, 'systemctl start canopy-worker'))
  })
})

/**
 * Runs user data up to the EFS mount under bash, with dnf, sleep, shutdown and
 * the swap probes replaced by stubs on PATH, so a step's failure is observed
 * as bash handles it: `set -e`, the ERR trap, and conditions that suspend both.
 */
describe('a failed boot step, run', () => {
  let stubs: string

  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }

  beforeEach(() => {
    stubs = mkdtempSync(path.join(os.tmpdir(), 'canopy-boot-'))
    stub(
      'dnf',
      [
        `echo "$*" >> "${stubs}/dnf.calls"`,
        'case "$*" in',
        '  $DNF_FAIL)',
        `    n=$(($(cat "${stubs}/fails" 2>/dev/null || echo 0) + 1))`,
        `    echo "$n" > "${stubs}/fails"`,
        '    [ "$n" -le "$DNF_FAIL_TIMES" ] && exit 1 ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    )
    stub('sleep', 'exit 0')
    stub('shutdown', 'echo "SHUTDOWN $*"')
    stub('swapon', 'case "$1" in --show*) [ -n "$SWAP_ACTIVE" ] && echo /swapfile ;; esac\nexit 0')
    stub('stat', 'exit 1')
    stub('df', 'printf "Avail\\n  100\\n"')
    stub('fallocate', `echo "fallocate $*" >> "${stubs}/swap.calls"; exit 1`)
  })

  afterEach(() => {
    rmSync(stubs, { recursive: true, force: true })
  })

  function boot(env: { DNF_FAIL?: string; DNF_FAIL_TIMES?: number; SWAP_ACTIVE?: string } = {}) {
    const all = lines(template)
    const prelude = all.slice(0, lineIndex(all, 'mkdir -p /mnt/efs')).join('\n')
    // --norc and no stdin: bash sources ~/.bashrc when stdin is a socket,
    // which is what Node hands a child, and a .bashrc can reorder PATH.
    const run = spawnSync('bash', ['--norc', '-c', `${prelude}\necho REACHED-END`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: stubs,
        PATH: `${stubs}:${process.env.PATH ?? ''}`,
        DNF_FAIL: env.DNF_FAIL ?? '__never__',
        DNF_FAIL_TIMES: String(env.DNF_FAIL_TIMES ?? 99),
        SWAP_ACTIVE: env.SWAP_ACTIVE ?? '1',
      },
    })
    let dnf: string[] = []
    try {
      dnf = readFileSync(path.join(stubs, 'dnf.calls'), 'utf8').trim().split('\n')
    } catch {
      // dnf never ran.
    }
    return { ...run, dnf }
  }

  const installs = ['install -y git', 'install -y nodejs22', 'install -y amazon-efs-utils']

  it('boots through when every step succeeds', () => {
    const run = boot()
    expect(run.stderr).not.toContain('canopy-worker')
    expect(run.stdout).toContain('REACHED-END')
    expect(run.status).toBe(0)
    expect(run.dnf).toEqual(['upgrade --releasever=latest --exclude=kernel* -y', ...installs])
  })

  it('absorbs three failed upgrade attempts, as a nano without swap saw', () => {
    const run = boot({ DNF_FAIL: 'upgrade*', DNF_FAIL_TIMES: 3 })
    expect(run.stderr).not.toContain('canopy-worker')
    expect(run.status).toBe(0)
    expect(run.dnf.filter((c) => c.startsWith('upgrade'))).toHaveLength(4)
  })

  it('starts unpatched when the upgrade exhausts its attempts, and says so', () => {
    const run = boot({ DNF_FAIL: 'upgrade*' })
    expect(run.stderr).toContain("canopy-worker boot: 'dnf upgrade' failed after 5 attempts")
    expect(run.stderr).toContain('canopy-worker boot: running unpatched on the AMI packages')
    expect(run.stdout).not.toContain('SHUTDOWN')
    expect(run.stdout).toContain('REACHED-END')
    expect(run.status).toBe(0)
    expect(run.dnf.slice(-3)).toEqual(installs)
  })

  it.each([
    ['git', 'dnf install git'],
    ['nodejs22', 'dnf install nodejs22'],
    ['amazon-efs-utils', 'dnf install amazon-efs-utils'],
  ])('fails the boot when installing %s exhausts its attempts', (pkg, step) => {
    const run = boot({ DNF_FAIL: `install -y ${pkg}` })
    expect(run.stderr).toContain(`canopy-worker boot: '${step}' failed after 5 attempts`)
    expect(run.stderr).toContain('canopy-worker user-data FAILED')
    expect(run.stdout).toContain('SHUTDOWN -h now')
    expect(run.stdout).not.toContain('REACHED-END')
    expect(run.status).not.toBe(0)
  })

  it('warns and carries on when swap cannot be set up', () => {
    const run = boot({ SWAP_ACTIVE: '' })
    expect(run.stderr).toContain('canopy-worker boot: under 3 GiB free on /, so no swap file')
    expect(run.stderr).toContain("canopy-worker boot: 'swap' setup failed; continuing without swap")
    expect(run.stdout).toContain('REACHED-END')
    expect(run.status).toBe(0)
    expect(run.dnf[0]).toMatch(/^upgrade/)
  })

  it('makes no swap file when the free space cannot be read', () => {
    stub('df', 'echo "df: cannot read /" >&2')
    const run = boot({ SWAP_ACTIVE: '' })
    expect(run.stderr).toContain("canopy-worker boot: 'swap' setup failed; continuing without swap")
    expect(() => readFileSync(path.join(stubs, 'swap.calls'))).toThrow()
    expect(run.status).toBe(0)
  })

  it('leaves an active swap file alone', () => {
    const run = boot()
    expect(run.stderr).not.toContain('swap')
    expect(() => readFileSync(path.join(stubs, 'swap.calls'))).toThrow()
  })
})

describe('EFS backups', () => {
  it('are on by default', () => {
    expect(fileSystem(template).props.BackupPolicy).toEqual({ Status: 'ENABLED' })
  })

  it('can be turned off', () => {
    expect(fileSystem(synth({ efsBackup: false })).props.BackupPolicy).toBeUndefined()
  })
})

describe('the worker systemd unit is sandboxed', () => {
  const sandbox = [
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=tmpfs',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectProc=invisible',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'RestrictNamespaces=yes',
    'RestrictSUIDSGID=yes',
    'RestrictRealtime=yes',
    'LockPersonality=yes',
    'SystemCallArchitectures=native',
    'CapabilityBoundingSet=',
    'ReadWritePaths=/mnt/efs',
    // The private GitHub mirror, which the worker refuses to start without.
    'StateDirectory=canopy-worker',
  ]
  const checkedIn = readFileSync(
    path.join(__dirname, '../../worker/canopy-worker.service'),
    'utf-8',
  ).split('\n')

  it.each(sandbox)('the deployed unit carries %s', (line) => {
    expect(lines(template)).toContain(line)
  })

  it.each(sandbox)('the checked-in copy carries %s', (line) => {
    expect(checkedIn).toContain(line)
  })

  it("leaves the worker's own code read-only", () => {
    for (const unit of [lines(template), checkedIn]) {
      const writable = unit.filter((l) => l.startsWith('ReadWritePaths='))
      expect(writable).toEqual(['ReadWritePaths=/mnt/efs'])
    }
  })

  // systemd opens the append: log as root, following symlinks, before the
  // sandbox applies; LogsDirectory= would chown its directory to the worker.
  it('gives the worker no ownership of its log directory', () => {
    for (const unit of [lines(template), checkedIn]) {
      expect(unit.filter((l) => l.startsWith('LogsDirectory'))).toEqual([])
    }
  })
})
