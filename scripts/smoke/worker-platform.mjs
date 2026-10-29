#!/usr/bin/env node

/**
 * Boot the CMS worker's real user data in an Amazon Linux 2023 container, then run the worker's
 * tests, and the git-heavy suites of the code it runs, there with the git and Node that boot
 * installed.
 *
 *   node scripts/smoke/worker-platform.mjs            # build, render, boot, check, test
 *   node scripts/smoke/worker-platform.mjs --keep     # leave the container running afterwards
 *   node scripts/smoke/worker-platform.mjs --skip-tests
 *
 * Needs Docker and a `pnpm install`ed workspace. CI runs it from
 * .github/workflows/worker-platform.yml, on an arm64 runner because the worker is Graviton.
 *
 * It runs the script the construct synthesizes, verbatim, so its package list and tools are the
 * ones checked: nothing here restates them. Only what needs EC2 is replaced, by `shims`.
 *
 * What a container cannot show, so only a real instance does: the EFS mount itself (NFS
 * semantics, efs-utils' TLS tunnel, the IAM mount), systemd as PID 1 (the sandbox each unit asks
 * for, socket activation, restarts, the drain), the instance's own kernel, instance metadata and
 * its credentials, S3, the CloudWatch agent's start, and a t4g.nano's memory.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CDK_DIR = path.join(REPO_ROOT, 'packages/canopycms-cdk')

/** Docker Hub's official image first, then the same image from ECR Public. */
const IMAGES = ['amazonlinux:2023', 'public.ecr.aws/amazonlinux/amazonlinux:2023']

/**
 * What the AMI ships and the image lacks: `useradd`, `fallocate`, `swapon`, `mkswap`, `mount`,
 * `sysctl`, and the full coreutils. From the image's locked release, so the boot upgrades them.
 */
const AMI_BASELINE = ['coreutils', 'util-linux', 'shadow-utils', 'procps-ng']

/** Only for the tests, after the boot: npm installs pnpm. */
const TEST_EXTRAS = ['nodejs22-npm']

/** The worker's user on the AMI (cloud-init creates it), which its unit runs as. */
const WORKER_USER = 'ec2-user'

const BOOT_DIR = '/root/boot-check'
const CALLS_LOG = `${BOOT_DIR}/calls.log`
const SHUTDOWN_MARKER = `${BOOT_DIR}/shutdown-called`

/**
 * One shim per command that needs EC2, each logging its call. All but `shutdown`, which marks the
 * run failed whatever it is asked, refuse a call they were not written for. `aws s3 cp` copies the
 * local file for its destination, so both `sha256sum -c` lines check the real bundle and instance
 * files.
 */
function shims(downloads) {
  const log = `{ printf '%s' "$(basename "$0")"; [ "$#" -eq 0 ] || printf ' %q' "$@"; echo; } >> ${CALLS_LOG}`
  const cases = Object.entries(downloads)
    .map(([dest, file]) => `    '${dest}') cp '${BOOT_DIR}/${file}' "$4"; exit 0 ;;`)
    .join('\n')
  return {
    aws: `#!/bin/bash
${log}
if [ "$1 $2" = 's3 cp' ] && [ "$#" -eq 4 ] && [[ "$3" == s3://* ]]; then
  case "$4" in
${cases}
  esac
fi
echo "aws shim: unexpected call: $*" >&2
exit 97
`,
    mount: `#!/bin/bash
${log}
if [ "$1 $2" = '-t efs' ] && [ "$3" = '-o' ] && [ "$#" -eq 6 ]; then
  mkdir -p "$6"
  exit 0
fi
echo "mount shim: unexpected call: $*" >&2
exit 97
`,
    // A bare call is the CloudWatch agent's init-system probe, answered as systemctl answers off
    // PID 1; the agent's start is one of the things a container cannot show.
    systemctl: `#!/bin/bash
${log}
case "$1" in
  daemon-reload|enable|start) exit 0 ;;
  '') echo "System has not been booted with systemd as init system (PID 1). Can't operate." >&2; exit 1 ;;
esac
echo "systemctl shim: unexpected call: $*" >&2
exit 97
`,
    shutdown: `#!/bin/bash
${log}
touch ${SHUTDOWN_MARKER}
exit 0
`,
  }
}

/**
 * The calls the boot must make, in order. After them only the CloudWatch agent's bare probe may
 * follow, which is also why the boot's exit status is not checked: past `set +e` it is the status
 * of the agent's start, and the required part's failures all call shutdown.
 */
const EXPECTED_CALLS = [
  // As printf %q writes it, commas escaped.
  /^mount -t efs -o tls\\,iam\\,accesspoint=\S+ \S+:\/ \/mnt\/efs$/,
  /^aws s3 cp s3:\/\/\S+ \/tmp\/canopy-worker\.js$/,
  /^aws s3 cp s3:\/\/\S+ \/tmp\/canopy-instance-files\.sh$/,
  /^systemctl daemon-reload$/,
  /^systemctl enable --now canopy-github\.socket canopy-github\.service$/,
  /^systemctl enable canopy-worker$/,
  /^systemctl start canopy-worker$/,
  /^systemctl enable --now logrotate\.timer$/,
]

/** What the installed system must hold once the boot has run, each checked in the container. */
const POST_BOOT_CHECKS = [
  [
    'the packages user data installs',
    'rpm -q git nodejs22 amazon-efs-utils amazon-cloudwatch-agent logrotate',
  ],
  // `check-update` exits 100 when something is upgradable; the kernel is excluded as user data excludes it.
  [
    'nothing left to upgrade at the latest release',
    "dnf -q check-update --releasever=latest --exclude='kernel*'",
  ],
  [
    'node-22 is Node 22',
    `/usr/bin/node-22 -e 'process.exit(process.versions.node.split(".")[0] === "22" ? 0 : 1)'`,
  ],
  [
    'the bundle is installed as the one checked',
    `cmp ${BOOT_DIR}/index.js /opt/canopy-worker/index.js`,
  ],
  [
    'the split units are installed',
    'test -s /etc/systemd/system/canopy-worker.service && test -s /etc/systemd/system/canopy-github.service && test -s /etc/systemd/system/canopy-github.socket',
  ],
  [
    'the worker unit is the split one',
    'grep -q "^Requires=canopy-github.socket$" /etc/systemd/system/canopy-worker.service',
  ],
  [
    'gateway.env is root:canopy-github 0640',
    'test "$(stat -c %U:%G:%a /opt/canopy-worker/gateway.env)" = root:canopy-github:640',
  ],
  [
    'the gateway user is a system account',
    'test "$(getent passwd canopy-github | cut -d: -f7)" = /sbin/nologin',
  ],
  [
    'the worker log is root-owned 0644',
    'test "$(stat -c %U:%a /var/log/canopy-worker/worker.log)" = root:644',
  ],
  ['the EFS fstab entry is written', 'grep -q " /mnt/efs efs _netdev,tls,iam," /etc/fstab'],
  ['logrotate accepts the worker logs config', 'logrotate -d /etc/logrotate.d/canopy-worker'],
  // Syntax only: running the bundle would start the worker.
  // --check parses an ESM bundle only under this marker; without it, it skips the parse.
  [
    'the bundle is marked as a module',
    `test "$(cat /opt/canopy-worker/package.json)" = '{"type":"module"}'`,
  ],
  ['node-22 parses the installed bundle', '/usr/bin/node-22 --check /opt/canopy-worker/index.js'],
  [
    'the CloudWatch agent config is JSON',
    '/usr/bin/node-22 -e \'JSON.parse(require("fs").readFileSync("/opt/aws/amazon-cloudwatch-agent/etc/canopy-worker-logs.json", "utf8"))\'',
  ],
]

/** Kernel settings the boot writes, which a privileged container writes on the host's kernel. */
const HOST_SYSCTLS = ['vm.swappiness', 'kernel.core_pattern', 'fs.suid_dumpable']

const MINUTE = 60_000

/** Set by Ctrl-C. Its listener needs the event loop, which spawnSync blocks: run() yields to it. */
let interrupted = false
process.on('SIGINT', () => (interrupted = true))

/** Bounded, so a hang fails the run rather than outlasting the job, which reads as cancelled. */
async function run(
  cmd,
  args,
  { input, cwd, allowFail = false, quiet = false, timeoutMs = 10 * MINUTE, cleanup = false } = {},
) {
  await nextTurn()
  if (interrupted && !cleanup) throw new Error('interrupted')
  if (!quiet) console.log(`$ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: [
      input === undefined ? 'inherit' : 'pipe',
      quiet ? 'pipe' : 'inherit',
      quiet ? 'pipe' : 'inherit',
    ],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  await nextTurn()
  if (interrupted && !cleanup) throw new Error('interrupted')
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${cmd} ${args[0]} timed out after ${timeoutMs / MINUTE} minutes`)
  }
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFail) {
    if (quiet) process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    throw new Error(`${cmd} ${args[0]} exited ${result.status}`)
  }
  return result
}

/** A shell command in the container, as root unless `user` is given. */
async function exec(container, script, { user, env = {}, ...options } = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const userArgs = user ? ['-u', user, '-w', `/home/${user}`] : []
  return run('docker', ['exec', ...userArgs, ...envArgs, container, 'bash', '-c', script], options)
}

/** Pulls retry, and fall back to the next registry: both refuse anonymous pulls past a quota. */
async function pullImage() {
  for (const image of IMAGES) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (interrupted) throw new Error('interrupted')
      try {
        const pull = await run('docker', ['pull', '-q', image], {
          allowFail: true,
          timeoutMs: 3 * MINUTE,
        })
        if (pull.status === 0) return image
      } catch (err) {
        if (interrupted) throw err
        console.log(err.message)
      }
      await sleep(attempt * 10_000)
    }
  }
  throw new Error(`could not pull any of ${IMAGES.join(', ')}`)
}

async function renderUserData(outDir) {
  await run('pnpm', ['--filter', 'canopycms-cdk', 'run', 'build:worker'])
  await run('node', ['--import', 'tsx', 'test-support/render-user-data.ts', outDir], {
    cwd: CDK_DIR,
  })
}

async function checkBoot(container, downloads) {
  const failures = []
  const marker = await exec(container, `test -e ${SHUTDOWN_MARKER}`, {
    allowFail: true,
    quiet: true,
  })
  if (marker.status === 0) failures.push('the boot called shutdown (its ERR trap fired)')

  const calls = (await exec(container, `cat ${CALLS_LOG}`, { quiet: true })).stdout
    .split('\n')
    .filter(Boolean)
  console.log(`Shimmed calls:\n  ${calls.join('\n  ')}`)
  const required = calls.slice(0, EXPECTED_CALLS.length)
  const after = calls.slice(EXPECTED_CALLS.length)
  if (
    required.length !== EXPECTED_CALLS.length ||
    required.some((c, i) => !EXPECTED_CALLS[i].test(c)) ||
    after.some((c) => c !== 'systemctl')
  ) {
    failures.push(`the shimmed calls differ from the ${EXPECTED_CALLS.length} expected`)
  }
  if (Object.keys(downloads).length !== 2)
    failures.push('the manifest names other than two downloads')

  for (const [what, check] of POST_BOOT_CHECKS) {
    const result = await exec(container, check, { allowFail: true, quiet: true })
    console.log(`${result.status === 0 ? 'ok  ' : 'FAIL'} ${what}`)
    if (result.status !== 0) {
      failures.push(what)
      process.stderr.write(`${result.stdout}${result.stderr}`)
    }
  }
  const versions = await exec(
    container,
    'git --version; /usr/bin/node-22 --version; rpm -q system-release',
    {
      quiet: true,
    },
  )
  console.log(versions.stdout.trim())
  const swap = await exec(container, 'swapon --show=NAME --noheadings', {
    allowFail: true,
    quiet: true,
  })
  console.log(`swap after boot: ${swap.stdout.trim() || 'none (the boot only warns)'}`)
  return failures
}

/** The checkout's files, tracked and untracked but not ignored, as a tree to copy in. */
async function stageRepo(dir) {
  const files = async (args) =>
    (await run('git', ['ls-files', '-z', ...args], { cwd: REPO_ROOT, quiet: true })).stdout
      .split('\0')
      .filter(Boolean)
  // Deleted files, and sparse-checkout ones (tagged S), are listed but not on disk.
  const absent = new Set([
    ...(await files(['--deleted'])),
    ...(await files(['-t', '--cached']))
      .filter((entry) => entry.startsWith('S '))
      .map((entry) => entry.slice(2)),
  ])
  for (const file of await files(['--cached', '--others', '--exclude-standard'])) {
    if (absent.has(file)) continue
    cpSync(path.join(REPO_ROOT, file), path.join(dir, file), {
      recursive: false,
      verbatimSymlinks: true,
    })
  }
}

async function runTests(container, scratch) {
  await exec(container, `dnf install -y -q ${TEST_EXTRAS.join(' ')}`)
  const staged = path.join(scratch, 'repo')
  mkdirSync(staged)
  await stageRepo(staged)
  const home = `/home/${WORKER_USER}`
  await run('docker', ['cp', `${staged}/.`, `${container}:${home}/canopycms`], { quiet: true })
  await exec(container, `chown -R ${WORKER_USER}: ${home}/canopycms`)

  const pnpmVersion = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ).packageManager.replace(/^pnpm@/, '')
  const env = {
    CI: '1',
    PATH: `${home}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    GIT_AUTHOR_NAME: 'CI Bot',
    GIT_AUTHOR_EMAIL: 'ci@canopycms.test',
    GIT_COMMITTER_NAME: 'CI Bot',
    GIT_COMMITTER_EMAIL: 'ci@canopycms.test',
  }
  const asWorker = (script, options) =>
    exec(container, script, { user: WORKER_USER, env, ...options })
  await asWorker(
    `npm config set prefix ${home}/.npm-global && npm install -g -q pnpm@${pnpmVersion}`,
  )
  await asWorker('cd canopycms && command -v git node && pnpm install --frozen-lockfile')
  // Plus the git-heavy modules outside worker/ that the worker runs on the instance.
  await asWorker(
    'cd canopycms/packages/canopycms && pnpm exec vitest run src/worker src/git-manager ' +
      'src/branch-provisioning src/branch-sparse src/branch-workspace src/utils/git',
    { timeoutMs: 25 * MINUTE },
  )
  await asWorker('cd canopycms/packages/canopycms-cdk && pnpm exec vitest run --dir worker')
}

async function main() {
  const { values } = parseArgs({
    options: { keep: { type: 'boolean' }, 'skip-tests': { type: 'boolean' } },
  })
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'canopycms-worker-platform-'))
  const rendered = path.join(scratch, 'render')
  await renderUserData(rendered)
  const { downloads } = JSON.parse(readFileSync(path.join(rendered, 'manifest.json'), 'utf8'))

  const image = await pullImage()
  const container = `canopycms-worker-platform-${process.pid}`
  // Privileged, so the boot's swap and sysctl steps run for real; cleanup restores what they change
  // on the host's kernel. --init, so orphans are reaped as systemd reaps them on the instance: under
  // a bare `sleep` as PID 1, a killed git's children stay zombies, which `kill(pid, 0)` still finds.
  await run(
    'docker',
    ['run', '-d', '--init', '--privileged', '--name', container, image, 'sleep', 'infinity'],
    {
      quiet: true,
    },
  )
  let ok = false
  let hostSysctls = []
  try {
    for (const key of HOST_SYSCTLS) {
      const file = `/proc/sys/${key.replaceAll('.', '/')}`
      hostSysctls.push([key, (await exec(container, `cat ${file}`, { quiet: true })).stdout.trim()])
    }
    await exec(container, `dnf install -y -q --allowerasing ${AMI_BASELINE.join(' ')}`)
    await exec(container, `useradd -u 1000 -m ${WORKER_USER}`)
    await exec(container, `mkdir -p ${BOOT_DIR}/shims`)
    await run('docker', ['cp', `${rendered}/.`, `${container}:${BOOT_DIR}`], { quiet: true })
    const shimDir = path.join(scratch, 'shims')
    mkdirSync(shimDir)
    for (const [name, body] of Object.entries(shims(downloads))) {
      writeFileSync(path.join(shimDir, name), body, { mode: 0o755 })
    }
    await run('docker', ['cp', `${shimDir}/.`, `${container}:${BOOT_DIR}/shims`], { quiet: true })

    console.log('\n--- boot: the synthesized user data ---')
    const boot = await exec(
      container,
      `PATH=${BOOT_DIR}/shims:$PATH bash ${BOOT_DIR}/user-data.sh`,
      {
        allowFail: true,
        timeoutMs: 20 * MINUTE,
      },
    )
    console.log(`--- boot exited ${boot.status} ---\n`)
    const failures = await checkBoot(container, downloads)
    if (failures.length > 0) {
      throw new Error(`the boot check failed:\n  - ${failures.join('\n  - ')}`)
    }

    if (!values['skip-tests']) {
      console.log('\n--- worker tests on the booted platform ---')
      await runTests(container, scratch)
    }
    ok = true
  } finally {
    // A boot that timed out is still running in the container, and would write the sysctls again.
    await exec(container, 'pkill -KILL -f "user-data[.]sh"', {
      allowFail: true,
      quiet: true,
      cleanup: true,
    })
    for (const [key, value] of hostSysctls) {
      const file = `/proc/sys/${key.replaceAll('.', '/')}`
      await exec(container, `printf '%s\\n' '${value}' > ${file}`, {
        allowFail: true,
        quiet: true,
        cleanup: true,
      })
    }
    if (values.keep) {
      console.log(`Left running: docker exec -it ${container} bash`)
    } else {
      // The swap is the host kernel's: left on, it outlives the container.
      await exec(container, 'swapoff /swapfile', { allowFail: true, quiet: true, cleanup: true })
      await run('docker', ['rm', '-f', container], { allowFail: true, quiet: true, cleanup: true })
    }
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(ok ? '\nworker platform check passed' : '')
}

main().catch((err) => {
  console.error(`\nworker platform check FAILED: ${err.message}`)
  process.exit(1)
})
