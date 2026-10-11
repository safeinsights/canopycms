/**
 * The worker instance's systemd units and the `canopy-inspect` sandbox, as the lines user-data
 * writes (cms-service.ts). The split's units are also checked in under worker/, byte for byte,
 * for a hand install; worker-units.test.ts holds the two together.
 *
 * Two layouts, chosen at boot by the bundle's contract banner (WORKER_CONTRACT_BANNER_PREFIX):
 * - split, for a bundle at GATEWAY_SPLIT_CONTRACT or later: `canopy-worker.service` with no
 *   network and no secret, `canopy-github.service` holding every secret with no view of EFS, and
 *   `canopy-github.socket` between them;
 * - single-process, for an older bundle: one `canopy-worker.service` holding the secrets, as
 *   before the split.
 */

import {
  EXIT_DRAINED_FOR_TERMINATION,
  GATEWAY_SPLIT_CONTRACT,
  GITHUB_GATEWAY_SOCKET_ENV,
  GITHUB_GATEWAY_SOCKET_PATH,
  WORKER_CONTRACT_ENV,
  WORKER_CONTRACT_VERSION,
} from './worker-lifecycle'

/**
 * Where the Lambda AND the worker mount the `WorkspaceAP` access point (rooted
 * at EFS:/workspace), and so the workspace root of both.
 *
 * One path string, not merely one directory: git records absolute paths on
 * EFS (a workspace clone's `origin` is `<root>/remote.git`), and a path written
 * by one process must resolve for the other.
 */
export const EFS_MOUNT_PATH = '/mnt/efs'

/** The worker's code, env files and the inspect sandbox's scripts: root-owned. */
export const WORKER_INSTALL_DIR = '/opt/canopy-worker'

/** The GitHub gateway's system user (D8 of the split's plan): a static, non-login account. */
export const GATEWAY_USER = 'canopy-github'

/** The worker's user; `canopy-github.socket` belongs to it, so only it (and root) can connect. */
export const WORKER_USER = 'ec2-user'

/** The worker contract the single-process unit provides: the last before the split. */
export const SINGLE_PROCESS_UNIT_CONTRACT = GATEWAY_SPLIT_CONTRACT - 1

/**
 * The sandbox both services share. Node and git need none of what these take away;
 * `MemoryDenyWriteExecute` is left out because V8's JIT writes executable memory.
 */
export const WORKER_SANDBOX_DIRECTIVES = [
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
] as const

/**
 * Hidden from both services under the split. The journal because the worker's user's groups can
 * read it (and a crash's environment is journaled there); `/dev/shm` because it would otherwise be
 * the one directory both services and root can write outside EFS and `PrivateTmp`; the system bus
 * because neither service has a use for it. A `-` covers only the path it prefixes, and makes a
 * missing one (no persistent journal) no error.
 */
const HIDDEN_PATHS = [
  'InaccessiblePaths=-/run/dbus',
  'InaccessiblePaths=-/dev/shm',
  'InaccessiblePaths=-/var/log/journal',
  'InaccessiblePaths=-/run/log/journal',
] as const

/**
 * The split worker's sandbox, which `canopy-inspect` applies too, so an operator's command on EFS
 * runs exactly as confined as the worker: the shared sandbox, the workspace writable, and the cut.
 * - `PrivateNetwork=yes`: only `lo`, so no route to the instance metadata service.
 * - `IPAddressDeny=any`: a second layer, which needs cgroup BPF (silently absent without it).
 * - `RestrictAddressFamilies=AF_UNIX`: `socket()` only; the gateway's socket is a file.
 * - `PrivateIPC=yes`, the hidden paths, `SystemCallFilter=@system-service` (node and git need
 *   nothing outside it), and `LimitCORE=0`.
 */
export const WORKER_SPLIT_SANDBOX = [
  ...WORKER_SANDBOX_DIRECTIVES,
  `ReadWritePaths=${EFS_MOUNT_PATH}`,
  'PrivateNetwork=yes',
  'IPAddressDeny=any',
  'RestrictAddressFamilies=AF_UNIX',
  'PrivateIPC=yes',
  ...HIDDEN_PATHS,
  'SystemCallFilter=@system-service',
  'LimitCORE=0',
] as const

/**
 * The gateway's sandbox: the shared one, no view of EFS, the network it needs (`AF_NETLINK` for
 * glibc's `getaddrinfo`), and the rest of the worker's additions.
 */
export const GATEWAY_SANDBOX = [
  ...WORKER_SANDBOX_DIRECTIVES,
  `InaccessiblePaths=${EFS_MOUNT_PATH}`,
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
  'PrivateIPC=yes',
  ...HIDDEN_PATHS,
  'SystemCallFilter=@system-service',
  'LimitCORE=0',
] as const

/** The worker's log; its directory and the file are root-owned. */
export const WORKER_LOG_DIR = '/var/log/canopy-worker'
export const WORKER_LOG = `${WORKER_LOG_DIR}/worker.log`

/** The gateway's log; its directory and the file are root-owned. */
export const GATEWAY_LOG_DIR = '/var/log/canopy-github'
export const GATEWAY_LOG = `${GATEWAY_LOG_DIR}/gateway.log`

const LOG_RULE = [
  '# File output, not journal: the CloudWatch agent cannot read journald,',
  '# so it tails this file instead.',
  '# systemd opens append: targets as root, following symlinks, before it',
  '# applies the sandbox or drops to User=. So the service must own neither',
  '# the file nor its directory: one that could swap the file for a symlink',
  '# would have its output appended to any file on the host as root.',
  '# Hence no LogsDirectory=, which chowns the directory to User=. Both are',
  '# created root-owned before the first start (user-data does), since',
  '# without the directory the start fails with 209/STDOUT. The service',
  '# writes through the descriptor systemd hands it.',
]

/**
 * `canopy-worker.service`. Split: no network, no secret, the gateway's socket. Single-process:
 * the unit as it was before the split, holding the secrets, for a bundle older than the split.
 */
export function workerUnit(layout: 'split' | 'single-process'): string[] {
  const split = layout === 'split'
  return [
    '[Unit]',
    'Description=CanopyCMS Worker Daemon',
    'After=network.target',
    ...(split
      ? [
          '# Stopped before the gateway, so its drain runs while the gateway is up.',
          'After=canopy-github.socket canopy-github.service',
          'Requires=canopy-github.socket',
          'Wants=canopy-github.service',
        ]
      : []),
    '# Never run against an unmounted /mnt/efs (user-data adds the fstab entry).',
    `RequiresMountsFor=${EFS_MOUNT_PATH}`,
    '',
    '[Service]',
    'Type=simple',
    `User=${WORKER_USER}`,
    `WorkingDirectory=${WORKER_INSTALL_DIR}`,
    '# Namespaced binary, not bare `node`: AL2023 points /usr/bin/node at',
    '# an installed version through `alternatives`, and AWS documents that',
    '# selection as able to change at any time. node-22 always means 22.',
    'ExecStart=/usr/bin/node-22 index.js',
    'Restart=always',
    'RestartSec=5',
    'TimeoutStartSec=300',
    '# Stopping drains: SIGTERM reaches node ONLY (mixed), so the git',
    '# children it waits for keep running. Whatever is left when node',
    '# exits, or at TimeoutStopSec, is SIGKILLed; 120s outlasts the 90s',
    '# drain and its abort grace.',
    'KillMode=mixed',
    'TimeoutStopSec=120',
    '# A worker that drained for an instance termination exits with this;',
    '# restarting it would start work on an instance about to disappear.',
    `RestartPreventExitStatus=${EXIT_DRAINED_FOR_TERMINATION}`,
    `SuccessExitStatus=${EXIT_DRAINED_FOR_TERMINATION}`,
    ...LOG_RULE,
    `StandardOutput=append:${WORKER_LOG}`,
    `StandardError=append:${WORKER_LOG}`,
    ...(split
      ? ['# The worker requires it; it holds nothing secret.']
      : [
          '# The private GitHub mirror, /var/lib/canopy-worker on the root volume:',
          '# the only git repository the GitHub credential is used in. The worker',
          '# does not start without it.',
        ]),
    'StateDirectory=canopy-worker',
    `EnvironmentFile=${WORKER_INSTALL_DIR}/.env`,
    ...(split ? [] : [`EnvironmentFile=${WORKER_INSTALL_DIR}/gateway.env`]),
    '# What this unit provides; a bundle needing more refuses to start.',
    `Environment=${WORKER_CONTRACT_ENV}=${split ? WORKER_CONTRACT_VERSION : SINGLE_PROCESS_UNIT_CONTRACT}`,
    ...(split
      ? [
          '# The GitHub gateway, its only way to GitHub, the Clerk API and the',
          '# instance role.',
          `Environment=${GITHUB_GATEWAY_SOCKET_ENV}=${GITHUB_GATEWAY_SOCKET_PATH}`,
        ]
      : []),
    '# Sandbox. Writable: the workspace, the state dir (StateDirectory=) and a',
    '# private /tmp.',
    '# ProtectHome=tmpfs, not yes: every git call reads per-user files under',
    '# $HOME (~/.config/git/attributes, ignore), and an inaccessible /home',
    '# makes each read warn "Permission denied"; an empty one is a silent',
    '# ENOENT. It also hides /run/user, so the worker cannot reach a user',
    '# manager of an operator logged in as its user.',
    ...(split
      ? [
          '# Then the cut: no network but lo, no route to the instance metadata',
          '# service, only unix sockets, the journal and /dev/shm hidden, and no',
          '# core dumps. The worker checks at boot that each layer took effect.',
          ...WORKER_SPLIT_SANDBOX,
        ]
      : [...WORKER_SANDBOX_DIRECTIVES, `ReadWritePaths=${EFS_MOUNT_PATH}`]),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]
}

/** `canopy-github.service`: every secret, the network, no view of EFS. */
export function gatewayUnit(): string[] {
  return [
    '[Unit]',
    'Description=CanopyCMS GitHub gateway',
    'After=network.target canopy-github.socket',
    'Requires=canopy-github.socket',
    '# Mounted before this unit sets up its namespace, so the mount is what',
    '# InaccessiblePaths= hides, and a later mount cannot propagate over it.',
    `RequiresMountsFor=${EFS_MOUNT_PATH}`,
    '# A boot or prepare() that fails holds its cause for the worker for 60s,',
    '# then exits 1. Restarting it is how a transient cause recovers, so',
    '# systemd never gives up on it. systemd 252 has no growing RestartSec',
    '# (RestartSteps= came in 254); the hold paces it to about once a minute.',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `User=${GATEWAY_USER}`,
    `Group=${GATEWAY_USER}`,
    `WorkingDirectory=${WORKER_INSTALL_DIR}`,
    'ExecStart=/usr/bin/node-22 index.js gateway',
    '# Descriptor 3, owned by the worker user, so only it and root connect.',
    'Sockets=canopy-github.socket',
    'Restart=always',
    'RestartSec=5',
    '# Stopping drains: answers new requests "stopping", lets those under way',
    '# finish for up to 60s, then exits. SIGTERM reaches node only (mixed);',
    '# a running fetch job is SIGKILLed with the cgroup when node exits.',
    'KillMode=mixed',
    'TimeoutStopSec=150',
    ...LOG_RULE,
    `StandardOutput=append:${GATEWAY_LOG}`,
    `StandardError=append:${GATEWAY_LOG}`,
    '# The private GitHub mirror and the per-command credential files. 0700:',
    "# the default 0755 would let the worker's user read both.",
    'StateDirectory=canopy-github',
    'StateDirectoryMode=0700',
    '# 0640 root:canopy-github: the secrets, unreadable to the worker.',
    `EnvironmentFile=${WORKER_INSTALL_DIR}/gateway.env`,
    '# What this unit provides; a bundle needing more refuses to start.',
    `Environment=${WORKER_CONTRACT_ENV}=${WORKER_CONTRACT_VERSION}`,
    '# Sandbox. Writable: the state dir and a private /tmp. No view of EFS,',
    '# which the gateway checks at boot, as it checks that cores are not',
    '# piped to a helper and that its core limit is zero.',
    ...GATEWAY_SANDBOX,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]
}

/** `canopy-github.socket`: the worker's only way to the gateway. */
export function gatewaySocketUnit(): string[] {
  return [
    '[Unit]',
    'Description=CanopyCMS GitHub gateway socket',
    '',
    '[Socket]',
    `ListenStream=${GITHUB_GATEWAY_SOCKET_PATH}`,
    '# Only the worker user (and root) can connect. The gateway refuses to',
    "# run as this socket's owner, or with group or other access to it.",
    `SocketUser=${WORKER_USER}`,
    `SocketGroup=${WORKER_USER}`,
    'SocketMode=0600',
    '# Root-owned: systemd chowns the socket by name, following symlinks,',
    '# which is safe only in a directory nobody else can write.',
    'DirectoryMode=0755',
    '',
    '[Install]',
    'WantedBy=sockets.target',
  ]
}

/** The `canopy-inspect` scripts' paths. */
export const CANOPY_INSPECT = `${WORKER_INSTALL_DIR}/canopy-inspect`
export const INSPECT_CHECKS = `${WORKER_INSTALL_DIR}/inspect-checks`
export const INSPECT_RC = `${WORKER_INSTALL_DIR}/inspect.rc`

/** A shell word for `value`: single-quoted, so the shell expands nothing in it. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `canopy-inspect`: run one command (or, with `--interactive`, a shell) as the worker's user,
 * inside exactly the worker's sandbox, so a hostile repository on EFS can do no more to an
 * operator than it can to the worker. Run as root. Nothing after `--` is composed by a shell
 * outside the sandbox: inspect-checks runs its assertions, then execs the command.
 */
export function canopyInspectScript(): string[] {
  return [
    '#!/bin/bash',
    '# canopy-inspect: run a command on EFS as the worker does, never as root.',
    '#   canopy-inspect <command> [args...]',
    '#   canopy-inspect --interactive',
    "# Run as root. Each command runs as uid 1000 inside the worker unit's",
    '# sandbox (no network, no secret), after inspect-checks has proved it.',
    'set -euo pipefail',
    'props=(',
    ...WORKER_SPLIT_SANDBOX.map((directive) => `  -p ${shellWord(directive)}`),
    ')',
    'run=(/usr/bin/systemd-run --quiet --wait --collect',
    `  --uid=${WORKER_USER} --gid=${WORKER_USER} "\${props[@]}")`,
    'usage() {',
    '  echo "usage: canopy-inspect <command> [args...] | canopy-inspect --interactive" >&2',
    '  exit 2',
    '}',
    '[ "$#" -ge 1 ] || usage',
    'if [ "$1" = --interactive ]; then',
    '  [ "$#" -eq 1 ] || usage',
    "  echo 'canopy-inspect: this terminal relays escape sequences both ways;' >&2",
    "  echo 'paste nothing from it into a root shell.' >&2",
    `  exec "\${run[@]}" --pty -- ${INSPECT_CHECKS} /bin/bash --noprofile --rcfile ${INSPECT_RC} -i`,
    'fi',
    '# stdin from /dev/null, stderr into stdout, and both through cat -v: the',
    "# sandbox's output never reaches the terminal raw, and it reads nothing",
    "# from the operator's.",
    `"\${run[@]}" --pipe -- ${INSPECT_CHECKS} "$@" </dev/null 2>&1 | cat -v`,
  ]
}

/**
 * `inspect-checks`: inside the sandbox, prove it (the worker's own boot self-checks, then what a
 * shell can see), then exec the operator's command in the same process.
 */
export function inspectChecksScript(): string[] {
  return [
    '#!/bin/bash',
    "# inspect-checks: canopy-inspect's sandbox proves itself, then runs the",
    '# command. Any failure refuses, and the command never runs.',
    'set -euo pipefail',
    'refuse() {',
    '  echo "canopy-inspect: refusing to run: $*" >&2',
    '  exit 1',
    '}',
    `/usr/bin/node-22 ${WORKER_INSTALL_DIR}/index.js self-check ||`,
    '  refuse "the worker\'s self-checks failed"',
    '[ "$(id -u)" = 1000 ] || refuse "not running as uid 1000"',
    "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status ||",
    '  refuse "NoNewPrivileges is not in effect"',
    'grep -Eq \'^Seccomp:[[:space:]]+2$\' /proc/self/status || refuse "no seccomp filter"',
    "# ProtectHome=tmpfs: /run/user is a tmpfs of the sandbox's own, empty, so no",
    "# operator's user manager is reachable. (systemd 252 mounts it writable.)",
    'awk \'$5 == "/run/user" { for (i = 7; i < NF; i++) if ($i == "-") t = $(i + 1) }',
    '  END { exit t != "tmpfs" }\' /proc/self/mountinfo && [ -z "$(ls -A /run/user)" ] ||',
    '  refuse "/run/user is not an empty tmpfs of its own"',
    'for hidden in /dev/shm /var/log/journal /run/log/journal; do',
    '  if ls "$hidden" >/dev/null 2>&1; then refuse "$hidden is accessible"; fi',
    'done',
    'if sudo -n true >/dev/null 2>&1; then refuse "sudo works"; fi',
    'exec -- "$@"',
  ]
}

/** The interactive shell's rc file: a prompt that says where it is. */
export function inspectRc(): string[] {
  return [
    "# canopy-inspect --interactive's shell. Root-owned, like everything here.",
    "PS1='canopy-inspect:\\w\\$ '",
    `cd ${EFS_MOUNT_PATH}`,
  ]
}

/**
 * Where user-data unpacks the instance files (root-only), before installing those its layout
 * needs.
 */
export const INSTANCE_FILES_DIR = '/run/canopy-instance-files'

/** The instance files, by their name in {@link INSTANCE_FILES_DIR}. */
export function instanceFiles(): Record<string, string[]> {
  return {
    'canopy-worker.service': workerUnit('split'),
    'canopy-worker-single-process.service': workerUnit('single-process'),
    'canopy-github.service': gatewayUnit(),
    'canopy-github.socket': gatewaySocketUnit(),
    'canopy-inspect': canopyInspectScript(),
    'inspect-checks': inspectChecksScript(),
    'inspect.rc': inspectRc(),
  }
}

const INSTANCE_FILE_DELIMITER = 'CANOPYFILEEOF'

/**
 * A script that writes {@link instanceFiles} into its working directory. `build:worker` writes it
 * beside the bundle as `worker/dist/instance-files.sh`, and the construct ships it as an asset
 * checked against its sha256, as the bundle is: EC2 caps user data at 16 KiB, which the files
 * alone would nearly fill.
 */
export function instanceFilesScript(): string {
  return `set -eu\n${Object.entries(instanceFiles())
    .flatMap(([name, lines]) => {
      if (lines.includes(INSTANCE_FILE_DELIMITER)) {
        throw new Error(`${name} holds the line ${INSTANCE_FILE_DELIMITER}`)
      }
      return [`cat > ${name} << '${INSTANCE_FILE_DELIMITER}'`, ...lines, INSTANCE_FILE_DELIMITER]
    })
    .join('\n')}\n`
}
