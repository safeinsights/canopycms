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
 *   pnpm tasks:screen [--show] [--generic-only] [--repo owner/name] <file>...
 *
 * It fails (exit 2) when gh cannot gather the private names; `--generic-only`
 * runs without them, with a loud warning. `--self-test` checks the matchers.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
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
  /(?<![\w.-])(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|aws|ai|co|edu|gov|us|cloud|xyz|info|biz|me|tech|online|ca|de|uk|eu|au|nz|ie|fr|nl|ch|se|dk|fi)(?![\w-])/gi
// eslint-disable-next-line security/detect-unsafe-regex -- dot-terminated labels, as HOST
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g
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
    ok: (m) =>
      m[1] === '' ||
      /^(?:<[^>]*>?|\$\{[^}]*\}?|\{[^}]*\}?|\*|x+|\.\.\.|…|(?:my-|example-)?bucket|example)$/i.test(
        m[1],
      ),
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
    ok: (m) => m[1].replace(/\.+$/, '').toLowerCase() === 'canopycms',
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
    rx: /\b(?:(?:adopter|marketing[- ]site|knowledge[- ]base|KB|MKT) )?(?<!pull )requests?[ #-]{1,3}\d+[a-z]?\b/gi,
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

/** A name that would match anywhere: a separator, a digit or an inner capital. */
const isDistinctive = (name) => /[-_./\d]|[a-z][A-Z]/.test(name)

/** `v2`, `1.4`, `2026`: a version or number identifies nothing. */
const isVersionLike = (name) => /^v?[\d.]+$/i.test(name) && /\d/.test(name)

/** An optional emphasis or quote mark around a name in prose. */
const MARK = '[`*_"\'’]?'

/**
 * Matchers for one repo, checkout, branch or profile name, as `{ rx, review }`.
 * A distinctive name (`acme-site`, `site2`, `acmeSite`) is refused anywhere. A
 * plain word (`website`) is ordinary prose and often a path segment here
 * (`docs/`, `utils/`), so it is refused only where it reads as a repo:
 * `<known owner>/name`, `../name`, `name@`, `name.git`, `name v2`, or "the
 * name repo / adopter / checkout", marks and line breaks included. Alone in
 * backticks it is only flagged for review. Every pattern runs over the whole
 * text, so `\s+` spans a wrapped line.
 */
export function nameMatcher(name, owners = []) {
  if (isDistinctive(name)) return [{ rx: bounded(name, 'gi'), review: false }]
  const e = escapeRx(name)
  const own = owners.map(escapeRx).join('|')
  const strong = [
    own && `(?<![\\w.-])(?:${own})/${e}(?![\\w-])`,
    `(?<![./])\\.\\./${e}\\b`,
    `(?<![\\w/.-])${e}@`,
    `(?<![\\w.-])${e}\\.git\\b`,
    `${MARK}\\b${e}\\b${MARK}(?:['’]s)?\\s+(?:repo|repository|adopter|checkout|clone)\\b`,
    `\\b${e}[-\\s]v\\d+\\b`,
  ].filter(Boolean)
  /* eslint-disable security/detect-non-literal-regexp -- escaped */
  return [
    { rx: new RegExp(strong.join('|'), 'gi'), review: false },
    { rx: new RegExp(`\`${e}\``, 'gi'), review: true },
  ]
  /* eslint-enable security/detect-non-literal-regexp */
}

/**
 * Matchers for an org or account login. A distinctive one is refused
 * anywhere; a plain word where it reads as an account: `github.com/login`,
 * `login.github.io`, `login/repo`, or "the login org".
 */
export function ownerMatcher(login) {
  if (isDistinctive(login)) return [{ rx: bounded(login, 'gi'), review: false }]
  const e = escapeRx(login)
  /* eslint-disable security/detect-non-literal-regexp -- escaped */
  return [
    {
      rx: new RegExp(
        `github\\.com/${e}(?![\\w-])|(?<![\\w.-])${e}(?:\\.github\\.io\\b|/[\\w.-])|${MARK}\\b${e}\\b${MARK}(?:['’]s)?\\s+org(?:anization)?\\b`,
        'gi',
      ),
      review: false,
    },
    { rx: new RegExp(`\`${e}\``, 'gi'), review: true },
  ]
  /* eslint-enable security/detect-non-literal-regexp */
}

/**
 * A person's display name, whole, plus each part of two or more letters, any
 * script, case-sensitively (`Jane` but not `jane`, which is a word too often).
 */
export function personMatchers(displayName) {
  const out = []
  const full = displayName.trim()
  if (!full) return out
  if (full.includes(' ')) out.push(bounded(full, 'giu'))
  for (const part of full.split(/\s+/)) {
    if (/^\p{L}[\p{L}'’-]+$/u.test(part)) out.push(bounded(part, 'gu'))
  }
  return out
}

/**
 * Turns gathered names into `{ source, rx, review? }` terms. `self` names
 * (this repo, its owner and its own branches and environments, which are
 * public), GENERIC_NAMES and version-like names are dropped.
 */
export function termsFromNames({
  owners = [],
  orgs = [],
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
      if (!name || skip.has(name.toLowerCase()) || isVersionLike(name)) continue
      if (name.startsWith('dependabot/')) continue
      for (const m of nameMatcher(name, owners)) terms.push({ source, ...m })
    }
  }
  add('org repo', repos)
  add('sibling checkout', dirs)
  add('branch or environment', refs)
  // Prose drops a profile's org prefix (`acme-sandbox-admin` → `sandbox-admin`).
  const unprefixed = profiles.map((p) => p.slice(p.indexOf('-') + 1)).filter((p) => p.includes('-'))
  add('aws profile', [...profiles, ...unprefixed])
  for (const login of new Set(orgs)) {
    if (skip.has(login.toLowerCase())) continue
    for (const m of ownerMatcher(login)) terms.push({ source: 'org', ...m })
  }
  for (const login of new Set(logins)) {
    if (skip.has(login.toLowerCase())) continue
    terms.push({ source: 'person', rx: bounded(login, 'gi') })
  }
  for (const name of new Set(people)) {
    for (const rx of personMatchers(name)) terms.push({ source: 'person', rx })
  }
  return terms
}

/**
 * `gh`, failing with gh's own first error line. Node's default message is the
 * whole command line, which would print gathered names into the report.
 */
function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : ''
    throw new Error(stderr.trim().split('\n')[0] || 'gh failed')
  }
}

/**
 * Without `repo` and `read:org`, GraphQL omits private repositories and
 * private org memberships instead of failing, so the screen would pass names
 * it never saw. A token without an `X-OAuth-Scopes` header (a fine-grained
 * one) cannot be checked, so it is refused as well.
 */
function assertScopes() {
  const head = gh(['api', '-i', 'user', '--jq', '.login'])
  const line = /^x-oauth-scopes:(.*)$/im.exec(head)
  if (!line)
    throw new Error('the gh token lists no OAuth scopes, so private names cannot be confirmed')
  const scopes = line[1].split(',').map((x) => x.trim())
  const missing = ['repo', 'read:org'].filter((x) => !scopes.includes(x))
  if (missing.length > 0) throw new Error(`the gh token lacks scope ${missing.join(', ')}`)
}

/**
 * Every node of a paginated GraphQL connection. `root` is the query's selection
 * down to the connection, `$after` included; `pick` reads it from `data`.
 */
function allNodes(root, vars, pick) {
  const nodes = []
  let after = vars.after ?? null
  do {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=query($after: String, $login: String!) { ${root} }`,
    ]
    for (const [k, v] of Object.entries(vars)) if (k !== 'after') args.push('-f', `${k}=${v}`)
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
 * Private repos the token can see outside the owner org, as names plus the
 * accounts that own them: the viewer's own, those it collaborates on, and
 * those of every org it belongs to. An adopter's or a deployment's repo can
 * sit in any of them.
 */
function otherPrivateRepos(owner) {
  const viewer = JSON.parse(gh(['api', 'graphql', '-f', 'query={ viewer { login } }'])).data.viewer
    .login
  const affiliations = '[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]'
  const visible = allNodes(
    `user(login: $login) { repositories(first: 100, after: $after, privacy: PRIVATE, affiliations: ${affiliations}, ownerAffiliations: ${affiliations}) { ${PAGE} nodes { name owner { login } } } }`,
    { login: viewer },
    (d) => d.user.repositories,
  )
  const orgs = allNodes(
    `user(login: $login) { organizations(first: 100, after: $after) { ${PAGE} nodes { login } } }`,
    { login: viewer },
    (d) => d.user.organizations,
  ).map((n) => n.login)
  return {
    owners: [...new Set([viewer, ...orgs, ...visible.map((r) => r.owner.login)])],
    repos: [
      ...visible.map((r) => r.name),
      ...orgs.filter((o) => o !== owner).flatMap((o) => orgRepos(o, true)),
    ],
  }
}

/** Every branch of one repo past the first page, which arrives alphabetically. */
const moreRefs = (owner, repo, after) =>
  allNodes(
    `repository(owner: $login, name: ${JSON.stringify(repo)}) { refs(refPrefix: "refs/heads/", first: 100, after: $after) { ${PAGE} nodes { name } } }`,
    { login: owner, after },
    (d) => d.repository.refs,
  ).map((n) => n.name)

/**
 * Branch and environment names of `repos`, batched into aliased queries. The
 * names are interpolated into the query, so only `[\w.-]` names are asked for.
 */
function refsOf(owner, repos) {
  const safe = repos.filter((r) => /^[\w.-]+$/.test(r))
  const names = []
  for (let i = 0; i < safe.length; i += 20) {
    const batch = safe.slice(i, i + 20)
    const fields = batch
      .map(
        (r, j) => `r${j}: repository(owner: $owner, name: ${JSON.stringify(r)}) {
          refs(refPrefix: "refs/heads/", first: 100) { ${PAGE} nodes { name } }
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
    batch.forEach((r, j) => {
      const repo = data[`r${j}`]
      if (!repo) return
      names.push(
        ...repo.refs.nodes.map((n) => n.name),
        ...repo.environments.nodes.map((n) => n.name),
      )
      if (repo.refs.pageInfo.hasNextPage) {
        names.push(...moreRefs(owner, r, repo.refs.pageInfo.endCursor))
      }
    })
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
 * never written anywhere: the org's other repos, the private repos the
 * viewer owns, collaborates on or sees through its other orgs, those repos'
 * owners, the org members' logins and display
 * names, the branches and environments of the org repos checked out beside
 * this one, those sibling checkouts' names, and local AWS profile names.
 *
 * `requireGh` (the default): throw when any GitHub source cannot be gathered,
 * since text screened without it would pass when it names an adopter's repo.
 * `false` skips the GitHub half entirely, with a loud warning.
 */
export function collectRuntimeTerms({ repo, requireGh = true }) {
  const [owner, selfName] = repo.split('/')
  const dirs = siblingDirs(selfName)
  const profiles = awsProfiles()
  /** One gathering step, named in its error so a failure says which source broke. */
  const step = (label, run) => {
    try {
      return run()
    } catch (err) {
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    if (!requireGh) throw new Error('--generic-only')
    step('token scopes', assertScopes)
    const repos = step('org repos', () => orgRepos(owner, false)).filter((n) => n !== selfName)
    if (repos.length === 0) throw new Error(`no repositories visible in ${owner}`)
    const members = step('org members', () =>
      allNodes(
        `organization(login: $login) { membersWithRole(first: 100, after: $after) { ${PAGE} nodes { login name } } }`,
        { login: owner },
        (d) => d.organization.membersWithRole,
      ),
    )
    const others = step('other private repos', () => otherPrivateRepos(owner))
    const self = step("this repo's branches", () => refsOf(owner, [selfName]))
    const refs = step('sibling branches', () =>
      refsOf(
        owner,
        repos.filter((r) => dirs.includes(r)),
      ),
    )
    return termsFromNames({
      // An org named like this repo reads as this repo's own path segment.
      owners: [owner, ...others.owners].filter((o) => o !== selfName),
      orgs: others.owners.filter((o) => o !== owner),
      repos: [...repos, ...others.repos],
      dirs,
      logins: members.map((m) => m.login),
      people: members.map((m) => m.name ?? ''),
      refs,
      profiles,
      self: [selfName, owner, ...self],
    })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    if (requireGh) throw new Error(`cannot gather private names through gh: ${why}`)
    console.warn(
      '\n*** tasks-privacy-screen: WARNING: --generic-only.\n' +
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
  })
  // Names run over the whole text, so a phrase wrapped across lines matches.
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  const position = (index) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: index - starts[lo] + 1 }
  }
  for (const term of privateTerms) {
    for (const m of text.matchAll(term.rx)) {
      findings.push({
        kind: term.review ? 'review-name' : 'private-name',
        review: Boolean(term.review),
        ...position(m.index),
        match: show ? `${term.source}: ${m[0].replace(/\s+/g, ' ')}` : `<${term.source}>`,
      })
    }
  }
  return findings
}

function selfTest() {
  // Assembled at runtime so this file holds no unexempted twelve-digit literal.
  const fakeAccount = ['2109', '8765', '4321'].join('')
  const terms = termsFromNames({
    owners: ['acme', 'safeinsights'],
    repos: ['acme-site', 'website', 'main'],
    logins: ['octo-dev'],
    people: ['Jane Q Doe', '', 'José Núñez'],
    orgs: ['acmeco', 'acme-org'],
    refs: ['stg-blue', 'feature-x', 'dependabot/npm/x', 'v2', '2026'],
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
    ['the `website` repo', ['private-name', 'review-name']],
    ['git clone git@github.com:other/website.git', ['private-name']],
    ['the website\nrepo is private', ['private-name']],
    ['the website  repo, the website’s repo', ['private-name', 'private-name']],
    ['see pull request #540', []],
    ['Filed in safeinsights/canopycms.', []],
    ['upgrade to v2 in 2026', []],
    [
      'github.com/acmeco and the acmeco org and acme-org',
      ['private-name', 'private-name', 'private-name'],
    ],
    ['https://acmeco.github.io/site', ['private-name']],
    ['José said so', ['private-name']],
    ['s3://bucket-prod-acme/x and s3://my-bucket/x', ['s3-bucket']],
    ['docs.acme.ca', ['host']],
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
  const wrapped = screenText('x\nthe website\nrepo', terms).find((f) => !f.review)
  if (wrapped?.line !== 2 || wrapped?.column !== 5) {
    failures.push(`  a wrapped name reported at ${wrapped?.line}:${wrapped?.column}, expected 2:5`)
  }
  const hidden = screenText('the acme-site repo', terms)[0]?.match
  if (hidden !== '<org repo>')
    failures.push(`  private name shown as ${hidden}, expected "<org repo>"`)
  if (failures.length > 0) {
    console.error('tasks-privacy-screen self-test FAILED:')
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(`tasks-privacy-screen self-test passed (${cases.length + 2} cases).`)
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest()
  const show = argv.includes('--show')
  const repoAt = argv.indexOf('--repo')
  const repo = repoAt === -1 ? 'safeinsights/canopycms' : argv[repoAt + 1]
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--repo')
  let terms
  try {
    terms = collectRuntimeTerms({ repo, requireGh: !argv.includes('--generic-only') })
  } catch (err) {
    console.error(`tasks-privacy-screen: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  if (files.length === 0) {
    console.error(
      'usage: pnpm tasks:screen [--show] [--generic-only] [--repo owner/name] <file>...',
    )
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

// import.meta.url is the real path; argv[1] may run through a symlink.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2))
}
