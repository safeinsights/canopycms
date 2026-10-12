#!/usr/bin/env node
// Prepares a stable release in the working tree and commits nothing; the
// workflow commits and tags what it leaves. In order: plan the version from the
// pending changesets, refuse to go backwards, promote the entries into
// CHANGELOG.md (`migration-notes.mjs --promote`), consume the changesets
// (`changeset version`), set every version field (`bump-version.mjs`), and
// validate (`pnpm lint:docs`, `migration-notes.mjs --check`).
//
// stdout carries one JSON object and nothing else, since the workflow parses
// it: `{"release":false,"reason":"…"}` when nothing is release-worthy, else
// `{"release":true,"version":"X.Y.Z"}`. Every child process writes to stderr.
// A failure exits 1 with its reason on stderr.
//
// RELEASE_STABLE_NPM_LATEST, when set, stands in for npm's `latest` of
// canopycms, so the self-test runs offline.
//
// Usage: node scripts/release-stable.mjs --prepare [--allow-dirty]
//        node scripts/release-stable.mjs --self-test

import { spawnSync, execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = [
  'packages/canopycms',
  'packages/canopycms-next',
  'packages/canopycms-auth-clerk',
  'packages/canopycms-auth-dev',
  'packages/canopycms-cdk',
]
const PACKAGE_NAMES = PACKAGES.map((p) => p.slice('packages/'.length))
const VERSION_TS = 'packages/canopycms/src/version.ts'
const PLAIN_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** What @changesets/read@1.0.1 skips in `.changeset/`, besides dotfiles and non-`.md` files. */
const IGNORED_MD = [/^readme\.md$/i, 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']
const USAGE = 'usage: release-stable.mjs --prepare [--allow-dirty] | --self-test'

const errorMessage = (err) => (err instanceof Error ? err.message : String(err))

/** Plain `X.Y.Z` versions, compared numerically; > 0 when a is newer. */
function compareVersions(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

function isChangesetName(name) {
  return (
    name.endsWith('.md') &&
    !name.startsWith('.') &&
    !IGNORED_MD.some((p) => (typeof p === 'string' ? p === name : p.test(name)))
  )
}

/** Runs a command for its stdout; its stderr passes through to ours. */
function capture(root, cmd, args) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 2],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Runs one step with all of its output on stderr, keeping stdout for the result. */
function step(root, cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 2, 2] })
  } catch (err) {
    const name = cmd === process.execPath ? 'node' : cmd
    throw new Error(`\`${[name, ...args].join(' ')}\` failed (exit ${err.status ?? '?'})`)
  }
}

function pendingChangesets(root) {
  const dir = join(root, '.changeset')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => isChangesetName(name) && statSync(join(dir, name)).isFile())
    .map((name) => name.slice(0, -3))
    .sort()
}

/** The newest `vX.Y.Z` tag in the repository, ancestor of HEAD or not, or null. */
function latestStableTag(root) {
  let latest = null
  for (const name of capture(root, 'git', ['tag', '--list', 'v*']).split('\n')) {
    const version = name.trim().slice(1)
    if (!name.startsWith('v') || !PLAIN_VERSION_RE.test(version)) continue
    if (!latest || compareVersions(version, latest.version) > 0) latest = { name, version }
  }
  return latest
}

function isAncestor(root, ref) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
      cwd: root,
      stdio: 'ignore',
    })
    return true
  } catch (err) {
    if (err.status === 1) return false
    throw err
  }
}

/** `changeset status`'s release plan for the changesets added since `since`. */
function readPlan(root, since) {
  const tmp = mkdtempSync(join(tmpdir(), 'release-plan-'))
  try {
    const out = join(tmp, 'plan.json')
    step(root, 'pnpm', ['exec', 'changeset', 'status', `--since=${since}`, `--output=${out}`])
    return JSON.parse(readFileSync(out, 'utf8'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * The version a plan releases, or `{ reason }` when it releases nothing. The
 * five packages are one `fixed` group, so a plan releases all five at one
 * version or is refused; and every pending changeset must be in it, or
 * `changeset version` would consume one the plan never counted.
 */
function planVersion(plan, pending, since) {
  const counted = new Set((plan.changesets ?? []).map((c) => c.id))
  const missing = pending.filter((slug) => !counted.has(slug))
  if (missing.length > 0) {
    throw new Error(
      `the plan since ${since} leaves out ${missing.map((s) => `.changeset/${s}.md`).join(', ')}; a changeset older than the latest stable tag is never pending`,
    )
  }
  const releases = (plan.releases ?? []).filter((r) => r.type !== 'none')
  if (releases.length === 0) {
    return {
      reason: `only empty changesets are pending (${pending.length}); the next release consumes them`,
    }
  }
  const names = new Set(releases.map((r) => r.name))
  const versions = new Set(releases.map((r) => r.newVersion))
  if (versions.size !== 1 || !PACKAGE_NAMES.every((n) => names.has(n)) || names.size !== 5) {
    throw new Error(
      `the plan must release ${PACKAGE_NAMES.join(', ')} at one version, got ${releases.map((r) => `${r.name}@${r.newVersion}`).join(', ')}`,
    )
  }
  const [version] = versions
  if (!PLAIN_VERSION_RE.test(version ?? '')) {
    throw new Error(`the plan's version must be a plain X.Y.Z, got ${version}`)
  }
  return { version }
}

function npmLatest(root) {
  const value = (
    process.env.RELEASE_STABLE_NPM_LATEST ??
    capture(root, 'npm', ['view', 'canopycms', 'dist-tags.latest'])
  ).trim()
  if (!PLAIN_VERSION_RE.test(value)) {
    throw new Error(`npm's latest canopycms must be a plain X.Y.Z, got "${value}"`)
  }
  return value
}

/** Every manifest, the root's included, and version.ts must now say `version`. */
function verifyVersions(root, version) {
  const wrong = []
  for (const dir of ['.', ...PACKAGES]) {
    const file = join(dir, 'package.json')
    const found = JSON.parse(readFileSync(join(root, file), 'utf8')).version
    if (found !== version) wrong.push(`${file} is at ${found}`)
  }
  if (!readFileSync(join(root, VERSION_TS), 'utf8').includes(`= '${version}'`)) {
    wrong.push(`${VERSION_TS} does not say ${version}`)
  }
  const left = pendingChangesets(root)
  if (left.length > 0) wrong.push(`changesets remain: ${left.join(', ')}`)
  if (wrong.length > 0) throw new Error(`after the version bump to ${version}: ${wrong.join('; ')}`)
}

function prepare(root, { allowDirty }) {
  if (!allowDirty) {
    const dirty = capture(root, 'git', ['status', '--porcelain']).trim()
    if (dirty) {
      throw new Error(
        `the tree has uncommitted changes, which a release commit would carry:\n${dirty}\npass --allow-dirty to prepare anyway`,
      )
    }
  }
  const pending = pendingChangesets(root)
  if (pending.length === 0) return { release: false, reason: 'no changesets are pending' }
  const tag = latestStableTag(root)
  if (!tag) throw new Error('no stable vX.Y.Z tag; the plan counts changesets since the latest one')
  if (!isAncestor(root, `refs/tags/${tag.name}`)) {
    throw new Error(`HEAD does not contain ${tag.name}, the latest stable release; merge it first`)
  }
  const planned = planVersion(readPlan(root, tag.name), pending, tag.name)
  if (planned.reason) return { release: false, reason: planned.reason }
  const { version } = planned
  for (const [what, floor] of [
    [`the latest stable tag ${tag.name}`, tag.version],
    ["npm's latest", npmLatest(root)],
  ]) {
    if (compareVersions(version, floor) <= 0) {
      throw new Error(
        `the changesets plan ${version}, which is not newer than ${what} (${floor}); a release never goes backwards, so fix the manifests or the changesets rather than picking another version`,
      )
    }
  }
  const node = process.execPath
  step(root, node, ['scripts/migration-notes.mjs', '--promote', version])
  step(root, 'pnpm', ['exec', 'changeset', 'version'])
  step(root, node, ['scripts/bump-version.mjs', version])
  verifyVersions(root, version)
  step(root, 'pnpm', ['lint:docs'])
  step(root, node, ['scripts/migration-notes.mjs', '--check'])
  return { release: true, version }
}

// ---------------------------------------------------------------------------
// Self-test

function selfTest() {
  const failures = []
  const expect = (label, ok) => {
    if (!ok) failures.push(`  ${label}`)
  }
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key]
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  })
  const g = (dir, ...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  const write = (dir, rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  const read = (dir, rel) =>
    existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : ''
  const json = (value) => JSON.stringify(value, null, 2) + '\n'
  const versionTs = (v) =>
    [
      '// Generated by scripts/bump-version.mjs, its only writer. The package builds with plain',
      '// tsc (rootDir: src), so src/ cannot import ../package.json; version.test.ts keeps the two equal.',
      `export const CANOPYCMS_VERSION = '${v}'`,
      '',
    ].join('\n')

  const CHANGELOG = [
    '# Changelog',
    '',
    'Intro.',
    '',
    '## How to use',
    '',
    'Read it.',
    '',
    '---',
    '',
    '## Unreleased',
    '',
    'Generic intro.',
    '',
    '<!-- legacy:start -->',
    '',
    'The entries below predate changesets.',
    '',
    '| int | Area | Change | Action |',
    '| --- | --- | --- | --- |',
    '| 93 | Worker | [Legacy thing](#legacy-thing) | None |',
    '',
    '### Legacy thing',
    '',
    '**What changed.** (int.93) Old.',
    '',
    '<!-- legacy:end -->',
    '',
    '---',
    '',
    '## Released',
    '',
    '### 0.0.67',
    '',
    '#### Released thing',
    '',
    'Body.',
    '',
  ].join('\n')
  const fm = (bump) => (bump ? `---\n"canopycms": ${bump}\n---\n\n` : '---\n---\n')
  const entry = (bump, title, meta, body) =>
    fm(bump) +
    [`### ${title}`, ['<!-- migration', ...meta, '-->'].join('\n'), ...body].join('\n\n') +
    '\n'
  const minorEntry = (title, ...extra) =>
    entry(
      'minor',
      title,
      ['area: Worker', 'action: Required', `row: ${title} row`],
      ['**What changed.** Something.', '**To adopt.** Do it.', ...extra],
    )
  const patchEntry = (title) =>
    entry(
      'patch',
      title,
      ['area: Ops', 'action: None', `row: ${title} row`],
      ['**What changed.** A fix.'],
    )
  const part = (target, bump = 'patch') =>
    fm(bump) +
    ['<!-- migration', `extends: ${target}`, 'action: None', '-->'].join('\n') +
    '\n\n**What changed.** More.\n'

  const tmp = mkdtempSync(join(tmpdir(), 'release-stable-selftest-'))
  /**
   * A throwaway repo with the release scripts, the five manifests at 0.0.67
   * and `v0.0.67`. `stages` are committed in order; a stage with `tag` is
   * tagged after its commit.
   */
  const fixture = (name, stages = []) => {
    const dir = join(tmp, name)
    mkdirSync(dir)
    for (const script of [
      'release-stable.mjs',
      'migration-notes.mjs',
      'bump-version.mjs',
      'check-docs.mjs',
    ]) {
      write(dir, `scripts/${script}`, '')
      copyFileSync(join(repoRoot, 'scripts', script), join(dir, 'scripts', script))
    }
    symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'))
    const docs = ['AGENTS.md', 'ARCHITECTURE.md', 'DEVELOPING.md', 'README.md', 'CODEBASE_GUIDE.md']
    const budgets = { 'CHANGELOG.md': { historyMarkers: null, maxEntryWords: 275 } }
    for (const doc of docs) {
      write(dir, doc, `# ${doc}\n\nText.\n`)
      budgets[doc] = { words: 1000, maxSectionWords: 1000, historyMarkers: 0 }
    }
    write(dir, 'scripts/docs-budgets.json', json({ files: budgets }))
    write(dir, '.gitignore', 'node_modules\n')
    // No install before `pnpm lint:docs`: node_modules is a link to this checkout's.
    write(dir, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\nverifyDepsBeforeRun: false\n")
    write(
      dir,
      'package.json',
      json({
        name: 'canopycms-monorepo',
        version: '0.0.67',
        private: true,
        scripts: {
          'lint:docs': 'node scripts/check-docs.mjs --self-test && node scripts/check-docs.mjs',
        },
      }),
    )
    for (const pkg of PACKAGES) {
      const manifest = { name: pkg.slice('packages/'.length), version: '0.0.67' }
      if (manifest.name !== 'canopycms') manifest.peerDependencies = { canopycms: 'workspace:*' }
      write(dir, `${pkg}/package.json`, json(manifest))
    }
    write(dir, VERSION_TS, versionTs('0.0.67'))
    write(dir, '.changeset/config.json', read(repoRoot, '.changeset/config.json'))
    write(dir, '.changeset/README.md', '# Changesets\n\nSee [the changelog](../CHANGELOG.md).\n')
    write(dir, 'CHANGELOG.md', CHANGELOG)
    g(dir, 'init', '-q')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-qm', 'base')
    g(dir, 'tag', 'v0.0.67')
    for (const stage of stages) {
      for (const [rel, content] of Object.entries(stage.files)) write(dir, rel, content)
      g(dir, 'add', '-A')
      g(dir, 'commit', '-qm', 'stage')
      if (stage.tag) g(dir, 'tag', stage.tag)
    }
    return dir
  }
  const run = (dir, { args = ['--prepare'], npm = '0.0.67' } = {}) => {
    const r = spawnSync(process.execPath, [join(dir, 'scripts/release-stable.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, RELEASE_STABLE_NPM_LATEST: npm },
    })
    let parsed = null
    try {
      parsed = JSON.parse(r.stdout)
    } catch {
      parsed = null
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parsed }
  }
  const status = (dir) => g(dir, 'status', '--porcelain')
  const show = (r) =>
    `exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr.slice(-800))}`
  const versionsOf = (dir) =>
    ['.', ...PACKAGES].map((p) => JSON.parse(read(dir, `${p}/package.json`)).version)

  try {
    {
      const dir = fixture('none')
      const r = run(dir)
      expect(
        `none: no changesets is no release, got ${show(r)}`,
        r.status === 0 && r.stdout === '{"release":false,"reason":"no changesets are pending"}\n',
      )
      expect('none: the tree is untouched', status(dir) === '')
    }
    {
      const dir = fixture('empty', [
        { files: { '.changeset/quiet-one.md': fm(null), '.changeset/quiet-two.md': fm(null) } },
      ])
      const r = run(dir)
      expect(
        `empty: only empty changesets is no release, got ${show(r)}`,
        r.status === 0 &&
          r.json?.release === false &&
          /^only empty changesets are pending \(2\)/.test(r.json.reason ?? '') &&
          Object.keys(r.json).length === 2,
      )
      expect(
        'empty: they stay for the next release, and nothing else changes',
        status(dir) === '' && existsSync(join(dir, '.changeset/quiet-one.md')),
      )
    }
    {
      const dir = fixture('patch', [{ files: { '.changeset/a-fix.md': patchEntry('A fix') } }])
      write(dir, 'notes.txt', 'untracked\n')
      const dirty = run(dir)
      expect(
        `patch: a dirty tree is refused, got ${show(dirty)}`,
        dirty.status === 1 &&
          dirty.stdout === '' &&
          /uncommitted changes[^]*notes\.txt[^]*--allow-dirty/.test(dirty.stderr),
      )
      const r = run(dir, { args: ['--prepare', '--allow-dirty'] })
      expect(
        `patch: --allow-dirty prepares 0.0.68, got ${show(r)}`,
        r.status === 0 && r.stdout === '{"release":true,"version":"0.0.68"}\n',
      )
      expect(
        `patch: every manifest is at 0.0.68, got ${versionsOf(dir)}`,
        versionsOf(dir).every((v) => v === '0.0.68'),
      )
      expect('patch: version.ts is at 0.0.68', read(dir, VERSION_TS) === versionTs('0.0.68'))
      expect(
        'patch: the changeset is consumed and promoted',
        !existsSync(join(dir, '.changeset/a-fix.md')) &&
          read(dir, 'CHANGELOG.md').includes(
            '## Released\n\n### 0.0.68\n\n#### Legacy thing\n\n**What changed.** (int.93) Old.\n\n#### A fix\n\n<!-- changeset: a-fix -->\n\n_First in 0.0.68._\n\n**What changed.** A fix.\n\n### 0.0.67\n',
          ),
      )
    }
    {
      const stages = [{ files: { '.changeset/a-change.md': minorEntry('A change') } }]
      const npm = run(fixture('npm-behind', stages), { npm: '0.1.0' })
      expect(
        `backwards: npm's latest at the planned version is refused, got ${show(npm)}`,
        npm.status === 1 &&
          npm.stdout === '' &&
          /plan 0\.1\.0, which is not newer than npm's latest \(0\.1\.0\)/.test(npm.stderr),
      )
      const dir = fixture('tag-behind')
      g(dir, 'tag', 'v0.1.0')
      write(dir, '.changeset/a-change.md', minorEntry('A change'))
      g(dir, 'add', '-A')
      g(dir, 'commit', '-qm', 'change')
      const tag = run(dir)
      expect(
        `backwards: a stable tag at the planned version is refused, got ${show(tag)}`,
        tag.status === 1 &&
          tag.stdout === '' &&
          /not newer than the latest stable tag v0\.1\.0 \(0\.1\.0\)/.test(tag.stderr),
      )
      expect('backwards: nothing is written', status(dir) === '')
    }
    {
      const dir = fixture('tag-aside')
      g(dir, 'checkout', '-qb', 'side')
      write(dir, 'side.txt', 'side\n')
      g(dir, 'add', '-A')
      g(dir, 'commit', '-qm', 'side')
      g(dir, 'tag', 'v0.2.0')
      g(dir, 'checkout', '-q', 'main')
      write(dir, '.changeset/a-change.md', minorEntry('A change'))
      g(dir, 'add', '-A')
      g(dir, 'commit', '-qm', 'change')
      const r = run(dir)
      expect(
        `tag: a latest stable tag that HEAD does not contain is refused, got ${show(r)}`,
        r.status === 1 &&
          r.stdout === '' &&
          /HEAD does not contain v0\.2\.0, the latest stable release/.test(r.stderr) &&
          status(dir) === '',
      )
    }
    {
      // A doc without a word budget fails check-docs, whatever the release wrote.
      const dir = fixture('docs-fail', [
        {
          files: {
            '.changeset/a-change.md': minorEntry('A change'),
            'docs/unbudgeted.md': '# Unbudgeted\n\nText.\n',
          },
        },
      ])
      const r = run(dir)
      expect(
        `validate: a lint:docs failure exits 1 with nothing on stdout, got ${show(r)}`,
        r.status === 1 &&
          r.stdout === '' &&
          /`pnpm lint:docs` failed/.test(r.stderr) &&
          /missing doc budget/.test(r.stderr),
      )
    }
    {
      // int.5 carries alpha, the legacy owner and an empty changeset; the rest is untagged.
      const dir = fixture('full', [
        {
          tag: 'v0.0.68-int.5',
          files: {
            '.changeset/legacy-unreleased.md': fm('minor') + '<!-- migration\nlegacy: true\n-->\n',
            '.changeset/alpha.md': minorEntry(
              'Alpha entry',
              'See [r](../README.md#top) and [b](./beta.md).',
            ),
            '.changeset/quiet.md': fm(null),
          },
        },
        {
          files: {
            '.changeset/beta.md': patchEntry('Beta entry'),
            '.changeset/alpha-more.md': part('alpha'),
            '.changeset/legacy-more.md': part('legacy#legacy-thing'),
            'README.md':
              '# README.md\n\nSee [alpha](.changeset/alpha.md) and [more](./.changeset/alpha-more.md#x).\n',
            'site/guide.md': '# Guide\n\nSee [beta](../.changeset/beta.md).\n',
          },
        },
      ])
      const r = run(dir)
      expect(
        `full: stdout is exactly the JSON result though the children print, got ${show(r)}`,
        r.status === 0 &&
          r.stdout === '{"release":true,"version":"0.1.0"}\n' &&
          /^0\.1\.0$/m.test(r.stderr),
      )
      expect(
        `full: every manifest is at 0.1.0, got ${versionsOf(dir)}`,
        versionsOf(dir).every((v) => v === '0.1.0'),
      )
      expect('full: version.ts is at 0.1.0', read(dir, VERSION_TS) === versionTs('0.1.0'))
      expect(
        `full: .changeset/ keeps only its README and config, got ${readdirSync(join(dir, '.changeset'))}`,
        readdirSync(join(dir, '.changeset')).sort().join(',') === 'README.md,config.json',
      )
      const expected = [
        '# Changelog',
        '',
        'Intro.',
        '',
        '## How to use',
        '',
        'Read it.',
        '',
        '---',
        '',
        '## Unreleased',
        '',
        'Generic intro.',
        '',
        '---',
        '',
        '## Released',
        '',
        '### 0.1.0',
        '',
        '<!-- changeset: legacy-unreleased -->',
        '<!-- changeset: quiet -->',
        '',
        '#### Legacy thing',
        '',
        '**What changed.** (int.93) Old.',
        '',
        '#### Alpha entry',
        '',
        '<!-- changeset: alpha -->',
        '',
        '_First in int.5._',
        '',
        '**What changed.** Something.',
        '',
        '**To adopt.** Do it.',
        '',
        'See [r](README.md#top) and [b](#beta-entry).',
        '',
        '##### Added in 0.1.0',
        '',
        '<!-- changeset: alpha-more -->',
        '',
        '**What changed.** More.',
        '',
        '#### Beta entry',
        '',
        '<!-- changeset: beta -->',
        '',
        '_First in 0.1.0._',
        '',
        '**What changed.** A fix.',
        '',
        '#### Legacy thing, continued',
        '',
        '<!-- changeset: legacy-more -->',
        '',
        '_First in 0.1.0._',
        '',
        'Continues [Legacy thing](#legacy-thing).',
        '',
        '**What changed.** More.',
        '',
        '### 0.0.67',
        '',
        '#### Released thing',
        '',
        'Body.',
        '',
      ].join('\n')
      expect(
        `full: CHANGELOG.md is the promoted document, got ${JSON.stringify(read(dir, 'CHANGELOG.md'))}`,
        read(dir, 'CHANGELOG.md') === expected,
      )
      expect(
        'full: links to a consumed changeset point at its entry',
        read(dir, 'README.md') ===
          '# README.md\n\nSee [alpha](CHANGELOG.md#alpha-entry) and [more](CHANGELOG.md#alpha-entry).\n' &&
          read(dir, 'site/guide.md') === '# Guide\n\nSee [beta](../CHANGELOG.md#beta-entry).\n',
      )
      expect(
        `full: nothing else changed, got ${JSON.stringify(status(dir))}`,
        status(dir)
          .split('\n')
          .filter(Boolean)
          .map((l) => l.slice(3))
          .sort()
          .join(',') ===
          [
            '.changeset/alpha-more.md',
            '.changeset/alpha.md',
            '.changeset/beta.md',
            '.changeset/legacy-more.md',
            '.changeset/legacy-unreleased.md',
            '.changeset/quiet.md',
            'CHANGELOG.md',
            'README.md',
            'site/guide.md',
            'package.json',
            ...PACKAGES.map((p) => `${p}/package.json`),
            VERSION_TS,
          ]
            .sort()
            .join(','),
      )
    }

    // The plan, without a repo.
    const plan = (releases, ids) => ({
      changesets: ids.map((id) => ({ id })),
      releases: releases.map(([name, newVersion, type = 'minor']) => ({ name, newVersion, type })),
    })
    const all = (v) => PACKAGE_NAMES.map((n) => [n, v])
    const throws = (fn, re) => {
      try {
        fn()
        return false
      } catch (err) {
        return re.test(errorMessage(err))
      }
    }
    const attempt = (fn) => {
      try {
        return fn()
      } catch (err) {
        return { error: errorMessage(err) }
      }
    }
    expect(
      'plan: one version for all five',
      attempt(() => planVersion(plan(all('0.1.0'), ['a']), ['a'], 'v0')).version === '0.1.0',
    )
    expect(
      'plan: a pending changeset missing from the plan is refused',
      throws(
        () => planVersion(plan(all('0.1.0'), ['a']), ['a', 'b'], 'v0.0.67'),
        /since v0\.0\.67 leaves out \.changeset\/b\.md/,
      ),
    )
    expect(
      'plan: two versions are refused',
      throws(
        () =>
          planVersion(
            plan([...all('0.1.0').slice(1), ['canopycms', '0.0.68']], ['a']),
            ['a'],
            'v0',
          ),
        /must release .* at one version/,
      ),
    )
    expect(
      'plan: a package left out is refused',
      throws(() => planVersion(plan(all('0.1.0').slice(1), ['a']), ['a'], 'v0'), /at one version/),
    )
    expect(
      'plan: none-type releases count as nothing',
      /^only empty/.test(
        attempt(() =>
          planVersion(
            plan(
              all('0.0.68').map(([n, v]) => [n, v, 'none']),
              ['a'],
            ),
            ['a'],
            'v0',
          ),
        ).reason ?? '',
      ),
    )

    // args
    for (const args of [
      [],
      ['--prepare', '--bogus'],
      ['--allow-dirty'],
      ['--prepare', '--self-test'],
    ]) {
      const r = run(join(tmp, 'none'), { args })
      expect(
        `args: ${JSON.stringify(args)} is refused with the usage, got ${show(r)}`,
        r.status === 1 && r.stdout === '' && r.stderr.includes('usage: release-stable.mjs'),
      )
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error('release-stable self-test FAILED:')
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.info('release-stable self-test passed.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a !== '--'))
  const known = ['--prepare', '--allow-dirty', '--self-test']
  const unknown = [...flags].find((a) => !known.includes(a))
  if (unknown) return { error: `unknown argument ${unknown}\n${USAGE}` }
  if (flags.has('--self-test')) {
    return flags.size === 1 ? { mode: 'self-test' } : { error: USAGE }
  }
  if (!flags.has('--prepare')) return { error: USAGE }
  return { mode: 'prepare', allowDirty: flags.has('--allow-dirty') }
}

const args = parseArgs(process.argv.slice(2))
if (args.error) {
  console.error(args.error)
  process.exit(1)
}
if (args.mode === 'self-test') selfTest()
try {
  const result = prepare(repoRoot, { allowDirty: args.allowDirty })
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (err) {
  console.error(`release-stable: ${errorMessage(err)}`)
  process.exitCode = 1
}
