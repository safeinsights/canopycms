#!/usr/bin/env node

/**
 * One-shot migration of the open .claude/future-tasks/ backlog into GitHub
 * issues. Every write goes through `gh` with argument arrays, never a shell
 * string, and every body passes tasks-privacy-screen.mjs first: an issue's edit
 * history is public, so a body is clean before it is created or it is not
 * created at all.
 *
 * Steps, each idempotent and resumable through the committed MAP_FILE:
 *
 *   --dry-run <dir>  render every title, label set and body into <dir> and
 *                    screen them; touches nothing on GitHub
 *   --labels         create the label set
 *   --create         first pass: one issue per task, links to other tasks as
 *                    permalinks, recording each number as soon as it exists
 *   --link           second pass: re-point task links at the issue numbers
 *   --project <n>    add every issue to org Project <n> and order it
 *
 * Options: --repo owner/name (default safeinsights/canopycms), --ref <sha>
 * (the commit permalinks point at; default: origin/int-202610-b's head, which
 * must be pushed), --interval <seconds> between writes (default 4), --limit <n>
 * writes per run.
 *
 * A create that dies before its number is recorded is found again by the
 * `<!-- canopycms-future-task: <file> -->` marker in its body, which every run
 * reconciles against the issues carrying MIGRATION_LABEL before writing.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectRuntimeTerms, screenText } from './tasks-privacy-screen.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_DIR = path.join(ROOT, '.claude', 'future-tasks')
const TASKS_REL = '.claude/future-tasks'
const MAP_FILE = path.join(TASKS_DIR, 'issue-map.json')
const MIGRATION_LABEL = 'from-future-tasks'
const MAX_BODY = 65536

/**
 * Open files that do not become issues, with the reason. Adopter-side work
 * belongs to the adopter's own repo, program records name private
 * infrastructure throughout, and the rest are documents rather than tasks.
 */
export const EXCLUDED = {
  'index.md': 'document: ranked lists become the Project order, prose its README',
  'adopter-base-branch-protection.md': 'adopter-side',
  'adopter-conditions-import-workaround-removal.md': 'adopter-side',
  'adopter-image-field-migration.md': 'adopter-side',
  'docs-site-assets-wiring.md': 'adopter-side',
  'draft-publish-lifecycle.md': 'adopter-side',
  'live-site-acl-migration.md': 'adopter-side (ranked as such in index.md)',
  'production-readiness-program.md': 'program record',
  'program-log.md': 'program record',
  'adopter-request-log-intake.md': "document: standing pointer to an adopter's private log",
  'public-repo-adopter-site-names.md':
    'superseded by this migration; a generic replacement is filed by hand',
}

export const LABELS = [
  { name: 'P0', color: 'b60205', description: 'Blocks launch; data loss, security, or crash' },
  { name: 'P1', color: 'd93f0b', description: 'Significant correctness issue under normal use' },
  {
    name: 'P2',
    color: 'fbca04',
    description: 'Enhancement, moderate quality improvement, or feature work',
  },
  { name: 'P3', color: 'c5def5', description: 'Nice-to-have; low impact' },
  { name: 'adopters:KB', color: 'bfd4f2', description: 'Serves the knowledge base adopter' },
  { name: 'adopters:MKT', color: 'bfd4f2', description: 'Serves the marketing site adopter' },
  { name: 'adopters:BOTH', color: 'bfd4f2', description: 'Serves both adopters' },
  {
    name: 'adopters:NEITHER',
    color: 'ededed',
    description: 'Package-internal; no adopter waits on it',
  },
  { name: MIGRATION_LABEL, color: 'ededed', description: 'Migrated from .claude/future-tasks/' },
]

/** Same strict YAML subset as check-future-tasks.mjs: `key: value`, and `summary: >-` with indented text. */
export function parseTask(text) {
  if (!text.startsWith('---\n')) return { error: 'missing frontmatter' }
  const end = text.indexOf('\n---\n', 3)
  if (end === -1) return { error: 'frontmatter has no closing ---' }
  const fields = {}
  let open = null
  for (const line of text.slice(4, end).split('\n')) {
    if (open && line.startsWith('  ')) {
      fields[open] = fields[open] ? `${fields[open]} ${line.trim()}` : line.trim()
      continue
    }
    open = null
    const m = /^([a-z]+): ?(.*)$/.exec(line)
    if (!m) return { error: `unparseable frontmatter line "${line}"` }
    if (m[2] === '>-') {
      open = m[1]
      fields[m[1]] = ''
    } else fields[m[1]] = m[2].trim()
  }
  return { fields, body: text.slice(end + 5).replace(/^\n+/, '') }
}

/** The H1, minus `Future Task:` and a `[P2]` prefix; else the file name as words. */
export function titleOf(body, file) {
  const h1 = /^# +(.+)$/m.exec(body)
  const raw = h1
    ? h1[1]
        .replace(/^\[P[0-3][^\]]{0,40}\]\s*/, '')
        .replace(/^Future Task[^:]{0,40}:\s*/i, '')
        .trim()
    : file.replace(/\.md$/, '').replaceAll('-', ' ')
  const title = raw.charAt(0).toUpperCase() + raw.slice(1)
  return title.length > 250 ? `${title.slice(0, 249)}…` : title
}

/** The body without its H1 line, which becomes the issue title. */
function withoutH1(body) {
  return body.replace(/^# +.+\n+/, '')
}

const permalink = (repo, ref, repoPath) => `https://github.com/${repo}/blob/${ref}/${repoPath}`
const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`

/**
 * Wraps each `@name` outside inline code in backticks: in an issue body it is
 * a mention, and it would notify whoever owns that GitHub login.
 */
export function neutralizeMentions(line) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : // The optional `/…` tail starts with a character the name class excludes: linear.
          // eslint-disable-next-line security/detect-unsafe-regex
          part.replace(/(^|[^\w`/.-])@([A-Za-z][\w-]*(?:\/[\w.-]+)?)/g, '$1`@$2`'),
    )
    .join('')
}

/**
 * Rewrites every relative link target, outside fenced code, and neutralizes
 * mentions there. A link to another
 * migrated task becomes `#N` (bare when the text is just its file name) once
 * `numbers` knows it, else a permalink; any other repo path, resolved/
 * included, becomes a permalink at `ref`.
 */
export function rewriteLinks(markdown, { file, repo, ref, numbers, migrated }) {
  let inFence = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return neutralizeMentions(line).replace(
        /\[([^\]]*)\]\(([^)\s]+)\)/g,
        (whole, text, target) => {
          if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return whole
          const [p, ...frag] = target.split('#')
          const abs = path.resolve(TASKS_DIR, path.dirname(file), p)
          const repoPath = path.relative(ROOT, abs).split(path.sep).join('/')
          if (repoPath.startsWith('..')) return whole
          const name = path.basename(abs)
          if (path.dirname(abs) === TASKS_DIR && migrated.has(name)) {
            const n = numbers.get(name)
            if (n !== undefined) {
              const bare = text.replace(/`/g, '') === name && frag.length === 0
              return bare ? `#${n}` : `[${text}](${issueUrl(repo, n)})`
            }
          }
          const anchor = frag.length > 0 ? `#${frag.join('#')}` : ''
          return `[${text}](${permalink(repo, ref, repoPath)}${anchor})`
        },
      )
    })
    .join('\n')
}

/** Everything one issue is made of; `numbers` empty on the first pass. */
export function render(file, { repo, ref, numbers, migrated }) {
  const { fields, body, error } = parseTask(readFileSync(path.join(TASKS_DIR, file), 'utf8'))
  if (error) throw new Error(`${file}: ${error}`)
  const labels = [fields.priority, MIGRATION_LABEL]
  if (fields.adopters) labels.splice(1, 0, `adopters:${fields.adopters}`)
  const summary = rewriteLinks(fields.summary ?? '', { file, repo, ref, numbers, migrated })
  const main = rewriteLinks(withoutH1(body), { file, repo, ref, numbers, migrated }).trimEnd()
  const source = `${TASKS_REL}/${file}`
  const text = [
    `> ${summary}`,
    '',
    main,
    '',
    '---',
    `<sub>Migrated from [\`${source}\`](${permalink(repo, ref, source)}), where its history is.</sub>`,
    `<!-- canopycms-future-task: ${file} -->`,
    '',
  ].join('\n')
  return { file, title: titleOf(body, file), labels, body: text }
}

/** Open task files that become issues. */
export function migratedFiles() {
  return readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.md') && !(f in EXCLUDED))
    .sort()
}

/** Every reason an issue must not be created as rendered. */
export function refusals(issue, privateTerms) {
  const out = []
  const text = `${issue.title}\n${issue.labels.join('\n')}\n${issue.body}`
  for (const f of screenText(text, privateTerms).filter((x) => !x.review))
    out.push(`${f.kind} at rendered line ${f.line}: ${f.match}`)
  if (issue.body.length > MAX_BODY)
    out.push(`body is ${issue.body.length} characters (limit ${MAX_BODY})`)
  if (!/^P[0-3]$/.test(issue.labels[0])) out.push(`priority "${issue.labels[0]}" is not P0-P3`)
  return out
}

function readMap() {
  return existsSync(MAP_FILE)
    ? JSON.parse(readFileSync(MAP_FILE, 'utf8'))
    : { repo: null, issues: {} }
}

/** Written through a rename, so a kill mid-write never leaves half a file. */
function writeMap(map) {
  const tmp = `${MAP_FILE}.tmp`
  const sorted = Object.fromEntries(
    Object.entries(map.issues).sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(tmp, `${JSON.stringify({ ...map, issues: sorted }, null, 2)}\n`)
  renameSync(tmp, MAP_FILE)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `gh api` with backoff on GitHub's secondary rate limits (403/429 that say
 * so, or carry Retry-After). Any other failure throws.
 */
async function ghApi(args, input) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync('gh', ['api', ...args], {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (err) {
      const stderr = String(err?.stderr ?? '')
      const limited = /HTTP 429|secondary rate limit|abuse|retry-after|HTTP 403.*rate limit/i.test(
        stderr,
      )
      if (!limited || attempt >= 6)
        throw new Error(`gh api ${args[0]} failed: ${stderr.trim() || err}`)
      const wait = Math.min(60_000 * 2 ** attempt, 15 * 60_000)
      console.warn(`  rate limited; waiting ${wait / 1000}s (attempt ${attempt + 1})`)
      await sleep(wait)
    }
  }
}

/** Numbers of already-created issues, by the marker in their bodies. */
async function existingByMarker(repo) {
  const found = new Map()
  const out = await ghApi([
    '--paginate',
    `repos/${repo}/issues?state=all&labels=${MIGRATION_LABEL}&per_page=100`,
    '--jq',
    '.[] | select(.pull_request == null) | {number, body}',
  ])
  for (const line of out.split('\n').filter(Boolean)) {
    const { number, body } = JSON.parse(line)
    const m = /<!-- canopycms-future-task: ([^ ]+) -->/.exec(body ?? '')
    if (m) found.set(m[1], number)
  }
  return found
}

function parseArgs(argv) {
  const opts = { repo: 'safeinsights/canopycms', interval: 4, limit: Infinity }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--dry-run') opts.dryRun = next()
    else if (a === '--labels') opts.labels = true
    else if (a === '--create') opts.create = true
    else if (a === '--link') opts.link = true
    else if (a === '--project') opts.project = Number(next())
    else if (a === '--repo') opts.repo = next()
    else if (a === '--ref') opts.ref = next()
    else if (a === '--interval') opts.interval = Number(next())
    else if (a === '--limit') opts.limit = Number(next())
    else throw new Error(`unknown argument ${a}`)
  }
  return opts
}

function defaultRef() {
  return execFileSync('git', ['rev-parse', 'origin/int-202610-b'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const ref = opts.ref ?? defaultRef()
  const files = migratedFiles()
  const migrated = new Set(files)
  const map = readMap()
  if (map.repo && map.repo !== opts.repo)
    throw new Error(`${MAP_FILE} is for ${map.repo}, not ${opts.repo}`)
  map.repo = opts.repo
  const numbers = new Map(Object.entries(map.issues).map(([f, v]) => [f, v.number]))
  const ctx = { repo: opts.repo, ref, numbers, migrated }

  // Screened up front, all of it: a run that would refuse one body creates none.
  const terms = collectRuntimeTerms({ repo: opts.repo, requireGh: !opts.dryRun })
  const rendered = files.map((f) => render(f, ctx))
  const refused = rendered
    .map((r) => ({ file: r.file, why: refusals(r, terms) }))
    .filter((r) => r.why.length > 0)

  if (opts.dryRun) {
    mkdirSync(opts.dryRun, { recursive: true })
    for (const r of rendered) {
      writeFileSync(
        path.join(opts.dryRun, r.file),
        `<!-- title: ${r.title} -->\n<!-- labels: ${r.labels.join(', ')} -->\n\n${r.body}`,
      )
    }
    const reviews = rendered.flatMap((r) =>
      screenText(`${r.title}\n${r.labels.join('\n')}\n${r.body}`, terms, { show: true })
        .filter((f) => f.review)
        .map((f) => `${r.file}:${f.line}  ${f.match}`),
    )
    writeFileSync(path.join(opts.dryRun, 'REVIEW.txt'), `${reviews.join('\n')}\n`)
    writeFileSync(
      path.join(opts.dryRun, 'REFUSED.txt'),
      refused.map((r) => `${r.file}\n${r.why.map((w) => `  ${w}`).join('\n')}`).join('\n'),
    )
    const byPriority = {}
    for (const r of rendered) byPriority[r.labels[0]] = (byPriority[r.labels[0]] ?? 0) + 1
    console.log(
      `rendered ${rendered.length} issue(s) into ${opts.dryRun} at ref ${ref.slice(0, 12)}`,
    )
    console.log(`  by priority: ${JSON.stringify(byPriority)}`)
    console.log(`  excluded: ${Object.keys(EXCLUDED).length} file(s)`)
    console.log(`  refused by the screen: ${refused.length} (see REFUSED.txt)`)
    console.log(`  flagged for review: ${reviews.length} (see REVIEW.txt)`)
    process.exit(refused.length > 0 ? 1 : 0)
  }

  if (refused.length > 0) {
    console.error(
      `refusing to write: ${refused.length} body(ies) fail the privacy screen. Run --dry-run for detail.`,
    )
    process.exit(1)
  }

  let writes = 0
  const pace = async () => {
    writes++
    if (writes >= opts.limit) {
      console.log(`write limit ${opts.limit} reached; rerun to continue`)
      process.exit(0)
    }
    await sleep(opts.interval * 1000)
  }

  if (opts.labels) {
    for (const label of LABELS) {
      try {
        await ghApi(
          ['--method', 'POST', `repos/${opts.repo}/labels`, '--input', '-'],
          JSON.stringify(label),
        )
        console.log(`label ${label.name} created`)
      } catch (err) {
        if (!/already_exists|HTTP 422/.test(String(err))) throw err
        console.log(`label ${label.name} exists`)
      }
      await pace()
    }
  }

  if (opts.create) {
    for (const [file, number] of await existingByMarker(opts.repo)) {
      if (!map.issues[file]) {
        map.issues[file] = {
          number,
          priority: rendered.find((r) => r.file === file)?.labels[0],
          linked: false,
        }
        numbers.set(file, number)
        console.log(`recovered ${file} -> #${number}`)
      }
    }
    writeMap(map)
    for (const r of rendered) {
      if (map.issues[r.file]) continue
      const out = await ghApi(
        ['--method', 'POST', `repos/${opts.repo}/issues`, '--input', '-', '--jq', '.number'],
        JSON.stringify({ title: r.title, body: r.body, labels: r.labels }),
      )
      const number = Number(out.trim())
      if (!Number.isInteger(number)) throw new Error(`no issue number for ${r.file}: ${out}`)
      map.issues[r.file] = { number, priority: r.labels[0], linked: false }
      numbers.set(r.file, number)
      writeMap(map)
      console.log(`#${number}  ${r.file}`)
      await pace()
    }
  }

  if (opts.link) {
    const missing = files.filter((f) => !map.issues[f])
    if (missing.length > 0)
      throw new Error(`--link needs every issue created first; missing ${missing.length}`)
    for (const file of files) {
      const entry = map.issues[file]
      if (entry.linked) continue
      const r = render(file, ctx)
      const why = refusals(r, terms)
      if (why.length > 0)
        throw new Error(`${file} fails the screen after linking: ${why.join('; ')}`)
      // Compared with the live body, not a re-render of pass one: issues
      // created later in pass one already linked the ones before them.
      const live = await ghApi([`repos/${opts.repo}/issues/${entry.number}`, '--jq', '.body'])
      if (live.replace(/\n$/, '') !== r.body.replace(/\n$/, '')) {
        await ghApi(
          [
            '--method',
            'PATCH',
            `repos/${opts.repo}/issues/${entry.number}`,
            '--input',
            '-',
            '--jq',
            '.number',
          ],
          JSON.stringify({ body: r.body }),
        )
        console.log(`linked #${entry.number}  ${file}`)
        await pace()
      }
      entry.linked = true
      writeMap(map)
    }
  }

  if (opts.project) {
    const { addToProject } = await import('./tasks-project.mjs')
    await addToProject({
      repo: opts.repo,
      project: opts.project,
      map,
      save: () => writeMap(map),
      ghApi,
      pace,
    })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`tasks-import: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
