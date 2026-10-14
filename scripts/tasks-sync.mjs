#!/usr/bin/env node

/**
 * Mirror the open GitHub issues into CACHE_DIR (git-ignored) as markdown with
 * frontmatter, so the backlog can be grepped offline. The cache is replaced
 * whole on every run, so a closed issue drops out.
 *
 *   pnpm tasks:sync [--repo owner/name] [--project <n>]
 *
 * `--project` also records each issue's Project Status ("Do next", …) and
 * needs a `gh` token with the `project` scope.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(ROOT, '.claude', 'backlog-cache')

const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  })

function parseArgs(argv) {
  const opts = { repo: 'safeinsights/canopycms' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') opts.repo = argv[++i]
    else if (argv[i] === '--project') opts.project = Number(argv[++i])
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  return opts
}

function openIssues(repo) {
  const out = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues?state=open&per_page=100`,
    '--jq',
    '.[] | select(.pull_request == null) | {number, title, body, html_url, updated_at, labels: [.labels[].name]}',
  ])
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Issue number -> Status name, over every item of the org Project. */
function projectStatuses(repo, project) {
  const [owner] = repo.split('/')
  const statuses = new Map()
  let after = null
  do {
    const query = `query($owner: String!, $number: Int!, $after: String) { organization(login: $owner) {
      projectV2(number: $number) { items(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { content { ... on Issue { number } }
      fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }`
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-F',
      `number=${project}`,
    ]
    if (after) args.push('-f', `after=${after}`)
    const items = JSON.parse(gh(args)).data.organization.projectV2.items
    for (const node of items.nodes) {
      if (node.content?.number)
        statuses.set(node.content.number, node.fieldValueByName?.name ?? null)
    }
    after = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null
  } while (after)
  return statuses
}

const slug = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)

/** Frontmatter values are JSON-quoted, which YAML reads as strings. */
function toMarkdown(issue, status) {
  const label = (prefix) => issue.labels.find((l) => l.startsWith(prefix))
  const source = /<!-- canopycms-future-task: ([^ ]+) -->/.exec(issue.body ?? '')?.[1]
  const fields = {
    number: issue.number,
    title: JSON.stringify(issue.title),
    url: issue.html_url,
    priority: issue.labels.find((l) => /^P[0-3]$/.test(l)) ?? 'none',
    adopters: label('adopters:')?.slice('adopters:'.length),
    status: status === undefined ? undefined : JSON.stringify(status ?? 'none'),
    labels: JSON.stringify(issue.labels),
    updated: issue.updated_at,
    source: source ? `.claude/future-tasks/${source}` : undefined,
  }
  const front = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return `---\n${front}\n---\n\n# ${issue.title}\n\n${(issue.body ?? '').replace(/\r\n/g, '\n')}\n`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const issues = openIssues(opts.repo)
  const statuses = opts.project ? projectStatuses(opts.repo, opts.project) : null
  const staging = `${CACHE_DIR}.tmp-${process.pid}`
  mkdirSync(staging, { recursive: true })
  const rows = []
  for (const issue of issues) {
    const name = `${issue.number}-${slug(issue.title)}.md`
    const status = statuses ? statuses.get(issue.number) : undefined
    writeFileSync(path.join(staging, name), toMarkdown(issue, status))
    const priority = issue.labels.find((l) => /^P[0-3]$/.test(l)) ?? 'none'
    rows.push({ name, number: issue.number, title: issue.title, priority, status })
  }
  rows.sort((a, b) => a.priority.localeCompare(b.priority) || a.number - b.number)
  const doNext = rows.filter((r) => r.status === 'Do next')
  const line = (r) => `- [#${r.number}](${r.name}) ${r.priority} ${r.title.replaceAll('\n', ' ')}`
  writeFileSync(
    path.join(staging, 'index.md'),
    [
      `# Open issues in ${opts.repo}`,
      '',
      `Synced ${new Date().toISOString()} by \`pnpm tasks:sync\`; ${rows.length} open. Generated: do not edit.`,
      '',
      ...(statuses ? ['## Do next', '', ...doNext.map(line), ''] : []),
      '## By priority',
      '',
      ...rows.map(line),
      '',
    ].join('\n'),
  )
  if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true })
  renameSync(staging, CACHE_DIR)
  console.log(`tasks-sync: ${rows.length} open issue(s) in ${path.relative(ROOT, CACHE_DIR)}/`)
}

try {
  main()
} catch (err) {
  console.error(`tasks-sync: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
