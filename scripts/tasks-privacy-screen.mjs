#!/usr/bin/env node

/**
 * Screen text bound for a PUBLIC GitHub issue for anything that identifies an
 * adopter or private infrastructure. An issue's edit history is public, so a
 * body or comment has to pass before it is posted: redacting afterwards leaves
 * the original in the history. Two layers:
 *
 * - Generic patterns, in this file: AWS account ids (the matcher of
 *   check-account-ids.mjs), ARNs, S3 buckets, AWS resource ids, hostnames not
 *   on the public allowlist, emails outside reserved example domains, home
 *   directories, private IPs, Clerk ids and keys, credential prefixes,
 *   `safeinsights/<repo>` other than this one, and adopter request-log numbers.
 * - Private names, gathered from the environment on every run and never
 *   written anywhere (see collectRuntimeTerms): the org's other repos and the
 *   private repos of the viewer's other orgs, the org members' logins and
 *   display names, the branches and environments of the org repos checked out
 *   beside this one, those checkouts' names, and local AWS profile names. There
 *   is deliberately no curated list: one would have to live outside the repo
 *   and would go stale. Findings show only which source matched unless `--show`
 *   is passed, so a report never copies a name.
 *
 * A false positive on a public host is fixed by adding the host to
 * PUBLIC_HOSTS. Anything else is fixed by rewording the text: there is no
 * per-finding allowlist.
 *
 *   pnpm tasks:screen [--show] [--require-gh] [--repo owner/name] <file>...
 *
 * Without `--require-gh`, an unreachable gh degrades to the generic rules with
 * a loud warning. `--self-test` checks the matchers.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAccountIds } from './check-account-ids.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Hosts (and their subdomains) that are public and name nothing private. */
const PUBLIC_HOSTS = [
  'github.com',
  'githubusercontent.com',
  'github.io',
  'github.blog',
  'npmjs.com',
  'npmjs.org',
  'nodejs.org',
  'nextjs.org',
  'vercel.com',
  'react.dev',
  'reactjs.org',
  'mantine.dev',
  'clerk.com',
  'aws.amazon.com',
  'public.ecr.aws',
  'mozilla.org',
  'w3.org',
  'whatwg.org',
  'ietf.org',
  'owasp.org',
  'mitre.org',
  'typescriptlang.org',
  'vitest.dev',
  'playwright.dev',
  'pnpm.io',
  'yarnpkg.com',
  'git-scm.com',
  'kernel.org',
  'stackoverflow.com',
  'wikipedia.org',
  'docker.com',
  'mdxjs.com',
  'lexical.dev',
  'mdxeditor.dev',
  'pixelplumbing.com',
  'libvips.org',
  'schema.org',
  'json-schema.org',
  'unicode.org',
  'opensource.org',
  'semver.org',
  'example.com',
  'example.org',
  'example.net',
]

/** Reserved for documentation (RFC 2606/6761): never a real host. */
const RESERVED_SUFFIXES = ['.example', '.test', '.invalid', '.localhost']

const isPublicHost = (host) => {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (RESERVED_SUFFIXES.some((s) => h.endsWith(s))) return true
  return PUBLIC_HOSTS.some((p) => h === p || h.endsWith(`.${p}`))
}

// TLDs that read as hosts in prose. `.sh`, `.so`, `.site`, `.ts` and similar
// are file extensions far more often than hosts here, so they are left out.
// Each label ends in a dot its own class excludes, so the repetition cannot
// split one input two ways: linear despite the nesting safe-regex counts.
const HOST =
  // eslint-disable-next-line security/detect-unsafe-regex
  /(?<![\w.-])(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|aws|ai|co|edu|gov|us|cloud|xyz|info|biz|me|tech|online)(?![\w-])/gi
// eslint-disable-next-line security/detect-unsafe-regex -- dot-terminated labels, as HOST
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g
/** An address at a reserved example domain, or GitHub's own git and noreply users. */
const EMAIL_OK = (domain) =>
  /^(?:example\.(?:com|org|net)|github\.com|ssh\.github\.com|users\.noreply\.github\.com)$/i.test(
    domain,
  ) || RESERVED_SUFFIXES.some((s) => domain.toLowerCase().endsWith(s))

/** Placeholder-looking text in an identifier slot: `<x>`, `${x}`, `{x}`, `*`, `x`, `...`. */
const PLACEHOLDER = /^(?:<[^>]*>?|\$\{[^}]*\}?|\{[^}]*\}?|\*|x+|\.\.\.|…|my-[\w-]*|example[\w-]*)$/i

/** @type {Array<{ kind: string, rx: RegExp, ok?: (m: RegExpMatchArray) => boolean }>} */
const RULES = [
  {
    kind: 'arn',
    // The account slot of `arn:partition:service:region:account:resource`.
    rx: /\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:([^:\s`'")]*):[^\s`'")]*/gi,
    ok: (m) => m[1] === '' || PLACEHOLDER.test(m[1]) || m[1] === '123456789012',
  },
  {
    kind: 's3-bucket',
    rx: /\bs3:\/\/([^/\s`'")]*)/gi,
    ok: (m) => m[1] === '' || PLACEHOLDER.test(m[1]) || /^(?:bucket|example)/i.test(m[1]),
  },
  {
    kind: 'aws-resource-id',
    rx: /\b(?:fs|fsap|sg|vpc|subnet|eni|vol|ami|igw|rtb|nat|i|lt|snap|acm)-(?:[0-9a-f]{17}|[0-9a-f]{8})\b/g,
  },
  { kind: 'aws-access-key', rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: 'credential',
    rx: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|[ps]k_(?:live|test)_[A-Za-z0-9]{8,})/g,
  },
  {
    kind: 'clerk-id',
    rx: /\b(?:user|org|sess|ins|app|client|idn|inv|orginv|sms|email|phone)_[A-Za-z0-9]{24,}\b/g,
  },
  {
    kind: 'home-path',
    rx: /(?:\/Users|\/home)\/([A-Za-z0-9._-]+)/g,
    ok: (m) =>
      ['runner', 'me', 'you', 'user', 'username', 'node', 'ubuntu', 'ec2-user'].includes(m[1]),
  },
  {
    kind: 'private-ip',
    rx: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
  },
  {
    kind: 'private-repo',
    // An org URL (`github.com/orgs/safeinsights/projects/5`) names no repo.
    rx: /(?<!orgs\/)\bsafeinsights\/([A-Za-z0-9._-]+)/gi,
    ok: (m) => m[1].toLowerCase() === 'canopycms',
  },
  {
    // Ruleset, App and installation ids are org configuration, not public.
    kind: 'github-id',
    rx: /\b(?:rulesets?|apps?|installations?)\b[^\n.;]{0,40}?\b\d{6,10}\b|\(\d{7,10}\)/gi,
  },
  // A CDK bootstrap qualifier names one account's deployment.
  { kind: 'cdk-qualifier', rx: /\bCDKToolkit-[\w-]+/g },
  {
    // An adopter's request log lives in its own private repo; its numbers mean
    // nothing publicly and point at it.
    kind: 'request-log-ref',
    rx: /\b(?:(?:adopter|marketing[- ]site|knowledge[- ]base|KB|MKT) )?requests?[ #-]{1,3}\d+[a-z]?\b/gi,
  },
  {
    kind: 'host',
    rx: HOST,
    ok: (m) => isPublicHost(m[0]),
  },
  {
    kind: 'email',
    rx: EMAIL,
    ok: (m) => EMAIL_OK(m[1]),
  },
]

/**
 * Names that are generic enough to appear in any repo's prose, so a repo,
 * branch or environment with one of them identifies nothing.
 */
const GENERIC_NAMES = new Set([
  'main',
  'master',
  'dev',
  'develop',
  'development',
  'staging',
  'stage',
  'production',
  'prod',
  'preview',
  'test',
  'testing',
  'release',
  'gh-pages',
])

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `name`, escaped, between characters that are neither word characters nor
 * hyphens. Names come from the environment, never from screened text.
 */
function bounded(name, flags) {
  // eslint-disable-next-line security/detect-non-literal-regexp -- escaped
  return new RegExp(`(?<![\\w-])${escapeRx(name)}(?![\\w-])`, flags)
}

/**
 * Matchers for one name, as `{ rx, review }`. A name with a separator, digit
 * or inner capital (`acme-site`, `site2`, `acmeSite`) is refused anywhere. A
 * plain word (`website`) is ordinary prose and often a path segment here
 * (`docs/`, `utils/`), so it is refused only where it reads as a repo:
 * `<known owner>/name`, `../name`, `name@`, `name v2`, or "the name repo /
 * adopter / checkout". In backticks it is only
 * flagged for review.
 */
export function nameMatcher(name, owners = []) {
  if (/[-_./\d]|[a-z][A-Z]/.test(name)) return [{ rx: bounded(name, 'gi'), review: false }]
  const e = escapeRx(name)
  const own = owners.map(escapeRx).join('|')
  /* eslint-disable security/detect-non-literal-regexp -- escaped */
  const strong = new RegExp(
    `${own ? `(?<![\\w.-])(?:${own})/${e}(?![\\w-])|` : ''}(?<![./])\\.\\./${e}\\b|(?<![\\w/.-])${e}@|\\b${e}(?:'s)? (?:repo|repository|adopter|checkout|clone)\\b|\\b${e}[- ]v\\d+\\b`,
    'gi',
  )
  const weak = new RegExp(`\`${e}\``, 'gi')
  /* eslint-enable security/detect-non-literal-regexp */
  return [
    { rx: strong, review: false },
    { rx: weak, review: true },
  ]
}

/**
 * A person's display name, whole, plus each alphabetic part of two or more
 * letters case-sensitively (`Jane` but not `jane`, which is a word too often).
 */
export function personMatchers(displayName) {
  const out = []
  const full = displayName.trim()
  if (!full) return out
  if (full.includes(' ')) out.push(bounded(full, 'gi'))
  for (const part of full.split(/\s+/)) {
    if (/^[A-Za-z][A-Za-z'-]+$/.test(part)) out.push(bounded(part, 'g'))
  }
  return out
}

/**
 * Turns gathered names into `{ source, rx }` terms. `self` names (this
 * repo's own branches and environments, which are public) and GENERIC_NAMES
 * are dropped.
 */
export function termsFromNames({
  owners = [],
  repos = [],
  dirs = [],
  logins = [],
  people = [],
  refs = [],
  profiles = [],
  self = [],
}) {
  const skip = new Set([...self, ...GENERIC_NAMES].map((n) => n.toLowerCase()))
  const terms = []
  const add = (source, names) => {
    for (const name of new Set(names)) {
      if (!name || skip.has(name.toLowerCase()) || name.startsWith('dependabot/')) continue
      for (const m of nameMatcher(name, owners)) terms.push({ source, ...m })
    }
  }
  add('org repo', repos)
  add('sibling checkout', dirs)
  add('branch or environment', refs)
  // Prose drops a profile's org prefix (`acme-sandbox-admin` → `sandbox-admin`).
  const unprefixed = profiles.map((p) => p.slice(p.indexOf('-') + 1)).filter((p) => p.includes('-'))
  add('aws profile', [...profiles, ...unprefixed])
  for (const login of new Set(logins)) {
    terms.push({ source: 'person', rx: bounded(login, 'gi') })
  }
  for (const name of new Set(people)) {
    for (const rx of personMatchers(name)) terms.push({ source: 'person', rx })
  }
  return terms
}

const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })

/**
 * Every node of a paginated GraphQL connection. `root` is the query's selection
 * down to the connection, `$after` included; `pick` reads it from `data`.
 */
function allNodes(root, vars, pick) {
  const nodes = []
  let after = null
  do {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=query($after: String, $login: String!) { ${root} }`,
    ]
    for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`)
    if (after) args.push('-f', `after=${after}`)
    const conn = pick(JSON.parse(gh(args)).data)
    nodes.push(...conn.nodes)
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null
  } while (after)
  return nodes
}

const PAGE = 'pageInfo { hasNextPage endCursor }'

/** The names of every repo in org `login`, or only its private ones. */
const orgRepos = (login, privateOnly) =>
  allNodes(
    `organization(login: $login) { repositories(first: 100, after: $after${privateOnly ? ', privacy: PRIVATE' : ''}) { ${PAGE} nodes { name } } }`,
    { login },
    (d) => d.organization.repositories,
  ).map((n) => n.name)

/**
 * Private repo names the token can see outside the owner org: the viewer's
 * own, and those of every other org they belong to. A sibling org can hold an
 * adopter's or a deployment's repo just as well.
 */
function otherPrivateRepos(owner) {
  const viewer = JSON.parse(gh(['api', 'graphql', '-f', 'query={ viewer { login } }'])).data.viewer
    .login
  const own = allNodes(
    `user(login: $login) { repositories(first: 100, after: $after, privacy: PRIVATE, ownerAffiliations: [OWNER]) { ${PAGE} nodes { name } } }`,
    { login: viewer },
    (d) => d.user.repositories,
  ).map((n) => n.name)
  const orgs = allNodes(
    `user(login: $login) { organizations(first: 100, after: $after) { ${PAGE} nodes { login } } }`,
    { login: viewer },
    (d) => d.user.organizations,
  ).map((n) => n.login)
  return {
    owners: [viewer, ...orgs],
    repos: [...own, ...orgs.filter((o) => o !== owner).flatMap((o) => orgRepos(o, true))],
  }
}

/** Branch and environment names of `repos` (first 100 of each), batched into aliased queries. */
function refsOf(owner, repos) {
  const names = []
  for (let i = 0; i < repos.length; i += 20) {
    const batch = repos.slice(i, i + 20)
    const fields = batch
      .map(
        (r, j) => `r${j}: repository(owner: $owner, name: ${JSON.stringify(r)}) {
          refs(refPrefix: "refs/heads/", first: 100) { nodes { name } }
          environments(first: 100) { nodes { name } } }`,
      )
      .join('\n')
    const data = JSON.parse(
      gh([
        'api',
        'graphql',
        '-f',
        `query=query($owner: String!) { ${fields} }`,
        '-f',
        `owner=${owner}`,
      ]),
    ).data
    for (const repo of Object.values(data)) {
      if (!repo) continue
      names.push(
        ...repo.refs.nodes.map((n) => n.name),
        ...repo.environments.nodes.map((n) => n.name),
      )
    }
  }
  return names
}

/** Directories beside the main checkout: other repos the maintainer works in. */
function siblingDirs(selfName) {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    ).trim()
    const parent = path.dirname(path.dirname(common))
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== selfName)
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Profile names in the local AWS config and credentials files. */
function awsProfiles() {
  const names = []
  for (const file of ['config', 'credentials']) {
    const p = path.join(homedir(), '.aws', file)
    if (!existsSync(p)) continue
    for (const m of readFileSync(p, 'utf8').matchAll(/^\[(?:profile )?([^\]\s]+)\]/gm)) {
      if (m[1] !== 'default') names.push(m[1])
    }
  }
  return names
}

/**
 * The private-name terms, gathered from the environment on every run and
 * never written anywhere: the org's other repos, the private repos of the
 * viewer and of their other orgs, the org members' logins and display names, the branches and environments of the org repos checked out
 * beside this one, those sibling checkouts' names, and local AWS profile
 * names.
 *
 * `requireGh`: throw when the GitHub half cannot be gathered, since a bulk
 * import screened without it would pass bodies that name an adopter's repo.
 * Otherwise that half is skipped with a warning.
 */
export function collectRuntimeTerms({ repo, requireGh = false }) {
  const [owner, selfName] = repo.split('/')
  const dirs = siblingDirs(selfName)
  const profiles = awsProfiles()
  try {
    const repos = orgRepos(owner, false).filter((n) => n !== selfName)
    if (repos.length === 0) throw new Error(`no repositories visible in ${owner}`)
    const members = allNodes(
      `organization(login: $login) { membersWithRole(first: 100, after: $after) { ${PAGE} nodes { login name } } }`,
      { login: owner },
      (d) => d.organization.membersWithRole,
    )
    const checkedOut = repos.filter((r) => dirs.includes(r) && /^[\w.-]+$/.test(r))
    const self = refsOf(owner, [selfName])
    const others = otherPrivateRepos(owner)
    return termsFromNames({
      // An org named like this repo reads as this repo's own path segment.
      owners: [owner, ...others.owners].filter((o) => o !== selfName),
      repos: [...repos, ...others.repos],
      dirs,
      logins: members.map((m) => m.login),
      people: members.map((m) => m.name ?? ''),
      refs: refsOf(owner, checkedOut),
      profiles,
      self: [selfName, ...self],
    })
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err)
    if (requireGh) throw new Error(`cannot gather org names through gh: ${why}`)
    console.warn(
      `\n*** tasks-privacy-screen: WARNING: gh failed (${why}).\n` +
        '*** Org repos, members, branches and environments are NOT screened; only generic rules,\n' +
        '*** sibling checkouts and AWS profiles are. Read the text yourself before filing.\n',
    )
    return termsFromNames({ owners: [owner], dirs, profiles, self: [selfName] })
  }
}

/**
 * Every finding in `text`, as `{ kind, line, column, match }` with 1-based
 * positions. A private name's `match` is `<source>` only; pass `show: true`
 * to see the text, so a report never copies a name by default.
 */
export function screenText(text, privateTerms = [], { show = false } = {}) {
  const findings = []
  text.split('\n').forEach((line, i) => {
    for (const column of findAccountIds(line)) {
      findings.push({ kind: 'account-id', line: i + 1, column, match: '<twelve digits>' })
    }
    for (const { kind, rx, ok } of RULES) {
      for (const m of line.matchAll(rx)) {
        if (ok && ok(m)) continue
        findings.push({ kind, line: i + 1, column: m.index + 1, match: m[0].trim() })
      }
    }
    for (const term of privateTerms) {
      for (const m of line.matchAll(term.rx)) {
        findings.push({
          kind: term.review ? 'review-name' : 'private-name',
          review: Boolean(term.review),
          line: i + 1,
          column: m.index + 1,
          match: show ? `${term.source}: ${m[0]}` : `<${term.source}>`,
        })
      }
    }
  })
  return findings
}

function selfTest() {
  // Assembled at runtime so this file holds no unexempted twelve-digit literal.
  const fakeAccount = ['2109', '8765', '4321'].join('')
  const terms = termsFromNames({
    owners: ['acme', 'safeinsights'],
    repos: ['acme-site', 'website', 'main'],
    logins: ['octo-dev'],
    people: ['Jane Q Doe', ''],
    refs: ['stg-blue', 'feature-x', 'dependabot/npm/x'],
    profiles: ['acme-admin', 'ac-stage-admin'],
    self: ['feature-x'],
  })
  const cases = [
    [`account ${fakeAccount}`, ['account-id']],
    [`arn:aws:iam::${fakeAccount}:role/deploy`, ['account-id', 'arn']],
    ['arn:aws:iam::123456789012:role/deploy', []],
    ['arn:aws:s3:::<bucket>/x', []],
    ['arn:aws:iam::<account>:role/x', []],
    ['s3://acme-assets-prod/x', ['s3-bucket']],
    ['s3://<bucket>/key', []],
    ['mounted fs-0a1b2c3d', ['aws-resource-id']],
    ['the key AKIAABCDEFGHIJKLMNOP', ['aws-access-key']],
    [`token ghp_${'a'.repeat(30)}`, ['credential']],
    [`pk_live_${'b'.repeat(20)}`, ['credential']],
    [`user_${'C'.repeat(27)}`, ['clerk-id']],
    ['/Users/alice/dev/x', ['home-path']],
    ['/home/runner/work', []],
    ['host 10.0.12.7', ['private-ip']],
    ['see safeinsights/website for it', ['private-name', 'private-repo']],
    ['safeinsights/canopycms#12', []],
    ['https://github.com/orgs/safeinsights/projects/5', []],
    ['from marketing-site request 66', ['request-log-ref']],
    ['adopter request #39', ['request-log-ref']],
    ['reverses a request-100 decision', ['request-log-ref']],
    ['every request is checked', []],
    ['rich-text from adopter request 87b', ['request-log-ref']],
    ['const request2 = 1', []],
    ['https://dev-docs.sandbox.acme.org/x', ['host']],
    ['https://github.com/vercel/next.js/issues/1', []],
    ['https://cdn.example.com/x and docs.example', []],
    ['http://localhost:3000/x and api.canopy.test', []],
    ['run heavy-agent-guard.sh on next.config.ts', []],
    ['mail ops@acme.io', ['host', 'email']],
    ['alice@example.com and git@github.com', []],
    ['react@18.3.1 and @mantine/core@7.1.0', []],
    ['the ACME-Site repo', ['private-name']],
    ['the acme-sites repo', []],
    ['tier stg-blue', ['private-name']],
    ['our website shows it', []],
    [
      'the website repo and `website` and ../website/x',
      ['private-name', 'private-name', 'review-name'],
    ],
    ['website/docs/a.md and acme/website', ['private-name']],
    ['src/website and ../../website/x and mode (120000)', []],
    ['the main branch, and feature-x', []],
    ['reviewed by octo-dev and Jane Doe', ['private-name', 'private-name', 'private-name']],
    ['jane said doe', []],
    ['profile acme-admin', ['private-name']],
    ['the stage-admin profile', ['private-name']],
    ['the website v2 topology and the website adopter', ['private-name', 'private-name']],
    ['GitHub ruleset `require-pr` (7484436) and app 4038189', ['github-id', 'github-id']],
    ['issue (#4038) and run 30586482757', []],
    ['the CDKToolkit-acme stack', ['cdk-qualifier']],
  ]
  const failures = []
  for (const [text, expected] of cases) {
    const kinds = screenText(text, terms)
      .map((f) => f.kind)
      .sort()
    if (kinds.join() !== [...expected].sort().join()) {
      failures.push(
        `  ${JSON.stringify(text.replaceAll(fakeAccount, '<fake>'))}: expected [${expected}] got [${kinds}]`,
      )
    }
  }
  const hidden = screenText('the acme-site repo', terms)[0]?.match
  if (hidden !== '<org repo>')
    failures.push(`  private name shown as ${hidden}, expected "<org repo>"`)
  if (failures.length > 0) {
    console.error('tasks-privacy-screen self-test FAILED:')
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(`tasks-privacy-screen self-test passed (${cases.length + 1} cases).`)
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest()
  const show = argv.includes('--show')
  const repoAt = argv.indexOf('--repo')
  const repo = repoAt === -1 ? 'safeinsights/canopycms' : argv[repoAt + 1]
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--repo')
  let terms
  try {
    terms = collectRuntimeTerms({ repo, requireGh: argv.includes('--require-gh') })
  } catch (err) {
    console.error(`tasks-privacy-screen: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  if (files.length === 0) {
    console.error('usage: pnpm tasks:screen [--show] [--require-gh] [--repo owner/name] <file>...')
    process.exit(2)
  }
  const targets = files.map((f) => path.resolve(f))
  let refused = 0
  let review = 0
  for (const file of targets) {
    for (const f of screenText(readFileSync(file, 'utf8'), terms, { show })) {
      if (f.review) review++
      else refused++
      console.log(`${path.relative(ROOT, file)}:${f.line}:${f.column}  ${f.kind}  ${f.match}`)
    }
  }
  if (review > 0) console.error(`\ntasks-privacy-screen: ${review} finding(s) to review by hand.`)
  if (refused > 0) {
    console.error(`tasks-privacy-screen: ${refused} finding(s) in ${targets.length} file(s).`)
    process.exit(1)
  }
  console.log(`tasks-privacy-screen: ${targets.length} file(s) pass.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2))
}
