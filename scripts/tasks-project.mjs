/**
 * The Project half of tasks-import.mjs: adds every migrated issue to an org
 * Project, sets its Status, and orders the items. The "Do next" ranking is
 * read from index.md's table, so the Project starts in the order the backlog
 * was ranked by hand; everything after it runs P0 to P3, then by file name.
 *
 * The Project's built-in Status field needs a "Do next" and a "Backlog"
 * option before this runs (the API cannot add options to it): rename its
 * options in the Project's settings first.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = path.join(ROOT, '.claude', 'future-tasks', 'index.md')

/** Task files linked from index.md's "Do next" table, in rank order, first mention only. */
export function doNextFiles() {
  const text = readFileSync(INDEX, 'utf8')
  const start = text.indexOf('## Do next')
  if (start === -1) return []
  const end = text.indexOf('\n## ', start + 1)
  const section = text.slice(start, end === -1 ? undefined : end)
  const out = []
  for (const line of section.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l))) {
    for (const m of line.matchAll(/\]\(([^)/\s]+\.md)\)/g)) if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

const gql = (ghApi, query, vars) =>
  ghApi([
    'graphql',
    '-f',
    `query=${query}`,
    ...Object.entries(vars).flatMap(([k, v]) => ['-F', `${k}=${v}`]),
  ])

export async function addToProject({ repo, project, map, save, ghApi, pace }) {
  const [owner] = repo.split('/')
  const meta = JSON.parse(
    await gql(
      ghApi,
      `query($owner: String!, $number: Int!) { organization(login: $owner) { projectV2(number: $number) {
        id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`,
      { owner, number: project },
    ),
  ).data.organization.projectV2
  const option = (name) => meta.field?.options.find((o) => o.name === name)?.id
  const doNextId = option('Do next')
  const backlogId = option('Backlog')
  if (!doNextId || !backlogId) {
    throw new Error(
      'the Project\'s Status field needs "Do next" and "Backlog" options; add them in its settings',
    )
  }

  const doNext = doNextFiles().filter((f) => map.issues[f])
  const rank = (f) => {
    const i = doNext.indexOf(f)
    return i !== -1 ? i : 1000
  }
  const priority = (f) => map.issues[f].priority ?? 'P9'
  const ordered = Object.keys(map.issues).sort(
    (a, b) => rank(a) - rank(b) || priority(a).localeCompare(priority(b)) || a.localeCompare(b),
  )

  let previous = null
  for (const file of ordered) {
    const entry = map.issues[file]
    if (!entry.item) {
      const nodeId = (
        await ghApi([`repos/${repo}/issues/${entry.number}`, '--jq', '.node_id'])
      ).trim()
      entry.item = JSON.parse(
        await gql(
          ghApi,
          `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: {projectId: $p, contentId: $c}) { item { id } } }`,
          { p: meta.id, c: nodeId },
        ),
      ).data.addProjectV2ItemById.item.id
      save()
      await pace()
    }
    if (!entry.placed) {
      const status = doNext.includes(file) ? doNextId : backlogId
      await gql(
        ghApi,
        `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input:
          {projectId: $p, itemId: $i, fieldId: $f, value: {singleSelectOptionId: $o}}) { clientMutationId } }`,
        { p: meta.id, i: entry.item, f: meta.field.id, o: status },
      )
      await pace()
      await gql(
        ghApi,
        previous
          ? `mutation($p: ID!, $i: ID!, $a: ID!) { updateProjectV2ItemPosition(input: {projectId: $p, itemId: $i, afterId: $a}) { clientMutationId } }`
          : `mutation($p: ID!, $i: ID!) { updateProjectV2ItemPosition(input: {projectId: $p, itemId: $i}) { clientMutationId } }`,
        previous ? { p: meta.id, i: entry.item, a: previous } : { p: meta.id, i: entry.item },
      )
      entry.placed = true
      save()
      console.log(`placed #${entry.number}  ${file}`)
      await pace()
    }
    previous = entry.item
  }
}
