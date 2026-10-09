#!/usr/bin/env node

/**
 * Fail when a tracked text file contains a twelve-digit run that could be an
 * AWS account id. This repository is public, and account ids -- ours or an
 * adopter's -- stay out of it: code reads them from the environment, and docs,
 * fixtures and backlog records name the account by its role ("the sandbox
 * account") or use a placeholder below.
 *
 * A match is exactly twelve digits with no letter or digit on either side, so
 * hex digests and longer numbers never match. Two exemptions, neither of which
 * can ever name a real account:
 *
 * - PLACEHOLDERS: AWS's own documentation placeholder and two repeated-digit
 *   values for multi-account examples. This set never grows to hold a real id;
 *   a false positive is fixed by rewriting the value, not by allowlisting it.
 * - The last group of a UUID (8-4-4-4-12), which is twelve hex characters that
 *   can happen to be all digits.
 *
 * Findings print as file:line:column only, so the check never copies a value
 * into a CI log.
 *
 *   node scripts/check-account-ids.mjs              # scan every tracked file
 *   node scripts/check-account-ids.mjs --self-test  # check the matcher itself
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PLACEHOLDERS = new Set(['123456789012', '111111111111', '222222222222'])

const TWELVE_DIGITS = /(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g
const UUID_HEAD = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-$/

/** Columns (1-based) of every non-exempt twelve-digit run in one line. */
function findAccountIds(line) {
  const columns = []
  for (const match of line.matchAll(TWELVE_DIGITS)) {
    if (PLACEHOLDERS.has(match[0])) continue
    if (UUID_HEAD.test(line.slice(Math.max(0, match.index - 24), match.index))) continue
    columns.push(match.index + 1)
  }
  return columns
}

function scanTree() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const findings = []
  for (const rel of files) {
    const abs = path.join(ROOT, rel)
    // A tracked file deleted in the working tree is still listed.
    if (!existsSync(abs)) continue
    const buffer = readFileSync(abs)
    if (buffer.includes(0)) continue
    buffer
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const column of findAccountIds(line)) findings.push(`${rel}:${i + 1}:${column}`)
      })
  }
  if (findings.length > 0) {
    console.error(
      `check-account-ids: ${findings.length} twelve-digit value(s) that could be an AWS account id:`,
    )
    for (const finding of findings) console.error(`  ${finding}`)
    console.error(
      '\nThis repository is public. Read the account from the environment, name it by role ' +
        '("the sandbox account"), or use a placeholder from scripts/check-account-ids.mjs.',
    )
    process.exit(1)
  }
  console.log(`check-account-ids: ${files.length} tracked files, no account ids.`)
}

function selfTest() {
  // Assembled at runtime so this file holds no unexempted twelve-digit literal.
  const fake = ['2109', '8765', '4321'].join('')
  const cases = [
    [`account: '${fake}'`, 1],
    [`arn:aws:iam::${fake}:role/deploy`, 1],
    [`(${fake} / us-east-1)`, 1],
    [`snake_${fake}_case`, 1],
    [`x-${fake}`, 1],
    [`${fake} and ${fake}`, 2],
    [`account: '123456789012'`, 0],
    [`account: '111111111111', other: '222222222222'`, 0],
    [`'00000000-0000-4000-8000-${fake}'`, 0],
    [`'asset-staging/99999999-9999-4999-8999-999999999999'`, 0],
    [`a${fake}b`, 0],
    [`${fake}3`, 0],
    [`${fake.slice(1)}`, 0],
  ]
  const failures = cases
    .filter(([line, expected]) => findAccountIds(line).length !== expected)
    .map(
      ([line, expected]) => `  expected ${expected} match(es) in: ${line.replace(fake, '<fake>')}`,
    )
  if (failures.length > 0) {
    console.error('check-account-ids self-test FAILED:')
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(`check-account-ids self-test passed (${cases.length} cases).`)
}

if (process.argv[2] === '--self-test') selfTest()
else scanTree()
