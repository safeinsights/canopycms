#!/usr/bin/env node

/**
 * Screen text bound for a PUBLIC GitHub issue for anything that identifies an
 * adopter or private infrastructure. An issue's edit history is public, so a
 * body has to pass before it is created: redacting afterwards leaves the
 * original in the history. `tasks-import.mjs` refuses every body that fails.
 *
 * Two layers:
 *
 * - Generic patterns, in this file: AWS account ids (the matcher of
 *   check-account-ids.mjs), ARNs, S3 buckets, AWS resource ids, hostnames not
 *   on the public allowlist, emails outside reserved example domains, home
 *   directories, private IPs, Clerk ids and keys, credential prefixes,
 *   `safeinsights/<repo>` other than this one, and adopter request-log numbers.
 * - Private terms -- adopter site and repo names, environment names, people's
 *   names -- which cannot be listed in a public repo. They are read from the
 *   file `$CANOPY_PRIVATE_TERMS` names, else ~/.config/canopycms/private-terms.txt:
 *   one term per line, matched case-insensitively between non-alphanumerics,
 *   or `/regex/flags`; `#` starts a comment. Findings name a private term by
 *   its line number in that file unless `--show` is passed, so a report never
 *   copies a term.
 *
 * A false positive on a public host is fixed by adding the host to
 * PUBLIC_HOSTS. Anything else is fixed by rewording the text: there is no
 * per-finding allowlist.
 *
 *   node scripts/tasks-privacy-screen.mjs [--show] [--require-terms] [file...]
 *   node scripts/tasks-privacy-screen.mjs --self-test
 *
 * With no files it screens every open task file in .claude/future-tasks/.
 */

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
    rx: /\bsafeinsights\/([A-Za-z0-9._-]+)/gi,
    ok: (m) => m[1].toLowerCase() === 'canopycms',
  },
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

/** One private term from its file line: `/regex/flags` or a literal. */
function compileTerm(raw) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(raw)
  // Terms come from the operator's own private file, never from screened text.
  // eslint-disable-next-line security/detect-non-literal-regexp
  if (re) return new RegExp(re[1], re[2].includes('g') ? re[2] : `${re[2]}g`)
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // eslint-disable-next-line security/detect-non-literal-regexp -- escaped literal
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi')
}

export function privateTermsPath() {
  return (
    process.env.CANOPY_PRIVATE_TERMS ||
    path.join(homedir(), '.config', 'canopycms', 'private-terms.txt')
  )
}

/**
 * The private terms, as `{ line, rx }`. Missing file: [] unless `required`,
 * which throws, since screening without them would pass a body that names an
 * adopter.
 */
export function loadPrivateTerms({ required = false } = {}) {
  const file = privateTermsPath()
  if (!existsSync(file)) {
    if (required)
      throw new Error(`private terms file not found: ${file} (set CANOPY_PRIVATE_TERMS)`)
    return []
  }
  const terms = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.replace(/(^|\s)#.*$/, '').trim()
      if (line) terms.push({ line: i + 1, rx: compileTerm(line) })
    })
  if (required && terms.length === 0) throw new Error(`private terms file is empty: ${file}`)
  return terms
}

/**
 * Every finding in `text`, as `{ kind, line, column, match }` with 1-based
 * positions. A private-term finding's `match` is `term #<line>`; pass
 * `show: true` to get the matched text instead.
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
          kind: 'private-term',
          line: i + 1,
          column: m.index + 1,
          match: show ? m[0] : `term #${term.line}`,
        })
      }
    }
  })
  return findings
}

/** Open task files: .claude/future-tasks/*.md, not resolved/. */
export function openTaskFiles() {
  const dir = path.join(ROOT, '.claude', 'future-tasks')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f))
}

function selfTest() {
  // Assembled at runtime so this file holds no unexempted twelve-digit literal.
  const fakeAccount = ['2109', '8765', '4321'].join('')
  const terms = [
    { line: 1, rx: compileTerm('acme-site') },
    { line: 2, rx: compileTerm('/\\bstg-[a-z]+\\b/i') },
  ]
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
    ['see safeinsights/website for it', ['private-repo']],
    ['safeinsights/canopycms#12', []],
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
    ['the ACME-Site repo', ['private-term']],
    ['the acme-sites repo', []],
    ['tier stg-blue', ['private-term']],
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
  if (hidden !== 'term #1') failures.push(`  private term shown as ${hidden}, expected "term #1"`)
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
  const files = argv.filter((a) => !a.startsWith('--'))
  let terms
  try {
    terms = loadPrivateTerms({ required: argv.includes('--require-terms') })
  } catch (err) {
    console.error(`tasks-privacy-screen: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  if (terms.length === 0) {
    console.warn(
      `tasks-privacy-screen: no private terms loaded from ${privateTermsPath()}; generic patterns only.`,
    )
  }
  const targets = files.length > 0 ? files.map((f) => path.resolve(f)) : openTaskFiles()
  let total = 0
  for (const file of targets) {
    for (const f of screenText(readFileSync(file, 'utf8'), terms, { show })) {
      total++
      console.log(`${path.relative(ROOT, file)}:${f.line}:${f.column}  ${f.kind}  ${f.match}`)
    }
  }
  if (total > 0) {
    console.error(`\ntasks-privacy-screen: ${total} finding(s) in ${targets.length} file(s).`)
    process.exit(1)
  }
  console.log(`tasks-privacy-screen: ${targets.length} file(s) clean.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2))
}
