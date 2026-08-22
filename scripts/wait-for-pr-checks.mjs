#!/usr/bin/env node

/**
 * Waits for a pull request's CI checks to reach a definite state, then says
 * what that state is -- always, including when it gives up.
 *
 * Usage: node scripts/wait-for-pr-checks.mjs [<pr-number>] [options]
 *
 * See DEVELOPING.md ("Waiting on PR Checks") for the narrative version. The
 * short story: the obvious `while gh pr checks | grep -c pending` loop has six
 * failure modes that all look identical from the outside -- like waiting -- and
 * every one of them was hit in a single working day:
 *
 *   1. Silence on timeout. A loop that runs out of iterations and exits 0 with
 *      no output is indistinguishable from a loop still waiting. Everything
 *      below exists to serve one rule: this script NEVER exits without printing
 *      a verdict line.
 *   2. Conflicts are invisible. When a PR is CONFLICTING/DIRTY, CI may never
 *      run at all, so there is nothing to poll and the loop spins to timeout.
 *      This is checked FIRST, before check state, and reported immediately.
 *   3. "No checks yet" and "no checks ever" look the same. Immediately after a
 *      push no checks have registered; on a branch no workflow triggers for,
 *      none ever will. A bounded grace period separates them (--grace).
 *   4. A `gh` failure reads as pending. `2>/dev/null` plus an empty-output
 *      guard turns an expired token or a rate limit into "still waiting",
 *      forever. gh's stderr is classified here: permanent errors stop
 *      immediately, unclassified ones get a bounded retry, and exhausting that
 *      budget is its own verdict.
 *   5. Green can be stale. Re-running a check replays it against the base it
 *      originally ran against, so a PR whose base has since moved can report
 *      green from a run that never saw the current base. A pass verdict is
 *      annotated when the base has advanced.
 *   6. Tab-delimited output is not a data format. `gh pr checks --json` is, and
 *      it carries a `bucket` field that pre-classifies each check.
 *
 * Exit codes are the verdict, for scripting:
 *   0 PASSED       every check concluded, none failed
 *   1 FAILED       at least one check failed or was cancelled (named in output)
 *   2 BLOCKED      merge conflicts -- CI may never run
 *   3 NO_CHECKS    grace period elapsed with zero checks registered
 *   4 TIMED_OUT    poll budget exhausted (current state printed)
 *   5 ERROR        gh failed, bad arguments, or the PR could not be read
 *
 * Dependency-free on purpose: this is reached for when CI is confusing, which
 * is exactly when `pnpm install` should not be a prerequisite.
 */

import { spawnSync } from 'node:child_process'

const VERDICTS = {
  PASSED: 0,
  FAILED: 1,
  BLOCKED: 2,
  NO_CHECKS: 3,
  TIMED_OUT: 4,
  ERROR: 5,
}

const DEFAULTS = {
  intervalSeconds: 30,
  timeoutMinutes: 25,
  graceSeconds: 120,
  maxConsecutiveErrors: 3,
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    pr: null,
    repo: null,
    interval: DEFAULTS.intervalSeconds,
    timeout: DEFAULTS.timeoutMinutes,
    grace: DEFAULTS.graceSeconds,
    maxErrors: DEFAULTS.maxConsecutiveErrors,
    requiredOnly: false,
    failFast: false,
    verbose: false,
  }

  const numeric = (raw, flag) => {
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${flag} expects a positive number, got: ${String(raw)}`)
    }
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--interval') {
      opts.interval = numeric(argv[(i += 1)], '--interval')
    } else if (arg === '--timeout') {
      opts.timeout = numeric(argv[(i += 1)], '--timeout')
    } else if (arg === '--grace') {
      opts.grace = numeric(argv[(i += 1)], '--grace')
    } else if (arg === '--max-errors') {
      opts.maxErrors = numeric(argv[(i += 1)], '--max-errors')
    } else if (arg === '--repo' || arg === '-R') {
      opts.repo = argv[(i += 1)]
      if (!opts.repo) throw new Error('--repo expects OWNER/REPO')
    } else if (arg === '--required') {
      opts.requiredOnly = true
    } else if (arg === '--fail-fast') {
      opts.failFast = true
    } else if (arg === '--verbose') {
      opts.verbose = true
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    } else if (opts.pr === null) {
      if (!/^\d+$/.test(arg)) {
        throw new Error(`PR argument must be a number, got: ${arg}`)
      }
      opts.pr = arg
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }

  return opts
}

const USAGE = `wait-for-pr-checks -- wait for a PR's checks and always report a verdict

Usage: node scripts/wait-for-pr-checks.mjs [<pr-number>] [options]

  <pr-number>          PR to watch. Defaults to the PR for the current branch.

  --interval <sec>     Poll interval           (default ${DEFAULTS.intervalSeconds})
  --timeout <min>      Give-up budget          (default ${DEFAULTS.timeoutMinutes})
  --grace <sec>        How long to wait for checks to first appear
                       before reporting NO_CHECKS (default ${DEFAULTS.graceSeconds})
  --max-errors <n>     Consecutive gh failures tolerated (default ${DEFAULTS.maxConsecutiveErrors})
  --repo OWNER/REPO    Target another repository
  --required           Only consider required checks
  --fail-fast          Report as soon as one check fails, instead of waiting
                       for the rest to conclude and listing them all
  --verbose            Print a line every poll, not just on state change
  -h, --help           Show this message

Exit codes: 0 PASSED  1 FAILED  2 BLOCKED  3 NO_CHECKS  4 TIMED_OUT  5 ERROR`

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const say = (message) => process.stdout.write(`[${stamp()}] ${message}\n`)

/**
 * The terminal report. Every exit path in this script funnels through here --
 * that is the whole point of the file, so there is deliberately no other
 * `process.exit` anywhere below.
 */
function verdict(name, summary, details = []) {
  const lines = [`VERDICT ${name} :: ${summary}`, ...details.map((d) => `  ${d}`)]
  process.stdout.write(`\n[${stamp()}] ${lines.join('\n')}\n`)
  process.exit(VERDICTS[name])
}

// ---------------------------------------------------------------------------
// gh plumbing
// ---------------------------------------------------------------------------

/**
 * Errors gh will keep producing no matter how many times we ask. Retrying these
 * only delays the report, so they short-circuit the retry budget. Anything not
 * matched here is treated as possibly-transient and retried, so a novel network
 * blip still gets a second chance -- failure mode 4 is about never CONFUSING an
 * error with pending, not about never retrying.
 */
const PERMANENT_ERROR_PATTERNS = [
  /could not resolve to a (pullrequest|repository)/i,
  /no pull requests found/i,
  /could not determine/i,
  /not found \(http 404\)/i,
  /bad credentials/i,
  /gh auth login/i,
  /authentication (failed|required)/i,
  /must be authenticated/i,
  /unknown (flag|command)/i,
  /executable file not found/i,
]

const isPermanentGhError = (stderr) => PERMANENT_ERROR_PATTERNS.some((re) => re.test(stderr))

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

  if (result.error) {
    const message =
      result.error.code === 'ENOENT'
        ? 'gh executable not found on PATH'
        : String(result.error.message)
    return { ok: false, code: null, stdout: '', stderr: message, permanent: true }
  }

  const stderr = (result.stderr || '').trim()
  // Exit 8 is gh's documented "checks pending" code, not a failure.
  const ok = result.status === 0 || result.status === 8
  return {
    ok,
    code: result.status,
    stdout: result.stdout || '',
    stderr,
    permanent: ok ? false : isPermanentGhError(stderr),
  }
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

const repoFlag = (opts) => (opts.repo ? ['--repo', opts.repo] : [])
const prArg = (opts) => (opts.pr ? [opts.pr] : [])

const PR_VIEW_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'baseRefName',
  'baseRefOid',
  'headRefOid',
].join(',')

function fetchPr(opts) {
  const res = runGh(['pr', 'view', ...prArg(opts), ...repoFlag(opts), '--json', PR_VIEW_FIELDS])
  if (!res.ok) return { ok: false, stderr: res.stderr, permanent: res.permanent }

  const parsed = parseJson(res.stdout)
  // A malformed body is usually a proxy error page or a truncated response --
  // transient, so it spends the retry budget rather than stopping outright.
  if (!parsed.ok)
    return {
      ok: false,
      stderr: `could not parse gh pr view JSON: ${parsed.message}`,
      permanent: false,
    }
  return { ok: true, pr: parsed.value }
}

/**
 * gh reports "no checks reported" as a nonzero exit with that phrase on stderr,
 * which is the same shape as a real failure. Separating the two here is what
 * keeps failure modes 3 and 4 apart.
 */
function fetchChecks(opts) {
  const args = ['pr', 'checks', ...prArg(opts), ...repoFlag(opts)]
  if (opts.requiredOnly) args.push('--required')
  args.push('--json', 'name,state,bucket,workflow,event,startedAt,completedAt,link')

  const res = runGh(args)

  if (!res.ok) {
    if (/no checks reported/i.test(res.stderr)) return { ok: true, checks: [] }
    return { ok: false, stderr: res.stderr, permanent: res.permanent }
  }

  const body = res.stdout.trim()
  if (body === '') return { ok: true, checks: [] }

  const parsed = parseJson(body)
  if (!parsed.ok)
    return {
      ok: false,
      stderr: `could not parse gh pr checks JSON: ${parsed.message}`,
      permanent: false,
    }
  if (!Array.isArray(parsed.value))
    return { ok: false, stderr: 'gh pr checks did not return an array', permanent: false }

  return { ok: true, checks: parsed.value }
}

// ---------------------------------------------------------------------------
// Check interpretation
// ---------------------------------------------------------------------------

// gh's own bucketing: pass | fail | pending | skipping | cancel.
const BUCKET_ORDER = ['fail', 'cancel', 'pending', 'pass', 'skipping']

function summarize(checks) {
  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]))
  let unknown = 0
  for (const check of checks) {
    const bucket = typeof check?.bucket === 'string' ? check.bucket : ''
    if (bucket in counts) counts[bucket] += 1
    else unknown += 1
  }
  // A bucket gh grows later must not be silently counted as passing.
  return { counts, unknown }
}

const nameOf = (check) => {
  const name = typeof check?.name === 'string' && check.name !== '' ? check.name : '(unnamed check)'
  const workflow =
    typeof check?.workflow === 'string' && check.workflow !== '' ? check.workflow : null
  return workflow ? `${workflow} / ${name}` : name
}

const ZERO_TIME = '0001-01-01T00:00:00Z'

/** gh emits Go's zero time rather than null for a check that has not finished. */
function completionMs(check) {
  const raw = check?.completedAt
  if (typeof raw !== 'string' || raw === '' || raw === ZERO_TIME) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/**
 * One line per state change, not per poll (failure mode: a Monitor command that
 * floods). The signature includes merge state because a PR going CONFLICTING
 * mid-run is exactly the transition worth printing.
 */
function signatureOf(pr, checks) {
  const perCheck = checks
    .map((c) => `${nameOf(c)}=${c?.bucket ?? '?'}`)
    .sort()
    .join(',')
  return `${pr.mergeable}|${pr.mergeStateStatus}|${pr.state}|${perCheck}`
}

function describe(pr, checks) {
  const { counts, unknown } = summarize(checks)
  const parts = BUCKET_ORDER.filter((b) => counts[b] > 0).map((b) => `${b}=${counts[b]}`)
  if (unknown > 0) parts.push(`unrecognized=${unknown}`)
  const checkText =
    checks.length === 0 ? 'checks=none-yet' : `checks[${checks.length}] ${parts.join(' ')}`
  return `${checkText} | mergeable=${pr.mergeable} mergeState=${pr.mergeStateStatus} prState=${pr.state}`
}

// ---------------------------------------------------------------------------
// Staleness (failure mode 5)
// ---------------------------------------------------------------------------

/**
 * `gh pr checks --json` exposes no head SHA -- verified against gh 2.97; its
 * only fields are bucket, completedAt, description, event, link, name,
 * startedAt, state, workflow. So "did these checks see the current base?" has
 * to be answered from the commit graph instead.
 *
 * In GitHub's compare API, `compare/A...B` reports `ahead_by` as the number of
 * commits B has that A does not. Asking it for head...base therefore yields the
 * count of base commits the PR head has never contained. Any run that produced
 * the current green result necessarily predates them, because a `pull_request`
 * workflow is not re-triggered when the base moves.
 *
 * The base tip is resolved from `git/ref/heads/{baseRefName}` rather than taken
 * from `gh pr view --json baseRefOid`, and that distinction is the whole check.
 * `baseRefOid` is a SNAPSHOT of where the base pointed when the PR was last
 * synced, not where it points now -- measured 2026-08-22, a PR whose base had
 * just advanced still reported the pre-advance SHA, and comparing against it
 * returned ahead_by 0 for every PR tried, silently reporting every stale green
 * as fresh. Using it here would make this function a no-op that always passes.
 *
 * Returns null when the question cannot be answered -- a staleness check that
 * fails must not turn a real pass into an error.
 */
function checkStaleness(opts, pr, checks) {
  // Only an OPEN PR can be merged on a stale green, which is the mistake this
  // warning exists to prevent. On a merged or closed PR the base has usually
  // moved on by definition, so the same warning is pure noise -- and its advice
  // ("update the branch to re-verify") is nonsense for something already merged.
  if (pr.state !== 'OPEN') return null

  const slug = opts.repo ?? repoSlugFromUrl(pr.url)
  if (!slug || typeof pr.headRefOid !== 'string' || typeof pr.baseRefName !== 'string') return null

  const baseTip = resolveBaseTip(slug, pr)
  if (!baseTip) return { unavailable: `could not resolve the current tip of ${pr.baseRefName}` }

  const res = runGh([
    'api',
    `repos/${slug}/compare/${pr.headRefOid}...${baseTip}`,
    '--jq',
    '{ahead_by: .ahead_by, dates: [.commits[].commit.committer.date]}',
  ])
  if (!res.ok) return { unavailable: res.stderr || 'compare API call failed' }

  const parsed = parseJson(res.stdout.trim() || '{}')
  if (!parsed.ok || typeof parsed.value?.ahead_by !== 'number')
    return { unavailable: 'could not read compare response' }

  const behindBy = parsed.value.ahead_by
  if (behindBy <= 0) return null

  const baseDates = Array.isArray(parsed.value.dates) ? parsed.value.dates : []
  const newestBase = baseDates.map((d) => Date.parse(d)).filter((ms) => Number.isFinite(ms))
  const newestCheck = checks.map(completionMs).filter((ms) => ms !== null)

  const detail = [
    `${behindBy} commit(s) have landed on ${pr.baseRefName} that this PR does not contain,`,
    `so a green result here was produced against an older base.`,
  ]
  if (
    newestBase.length > 0 &&
    newestCheck.length > 0 &&
    Math.max(...newestBase) > Math.max(...newestCheck)
  ) {
    detail.push(
      `The newest of those base commits (${new Date(Math.max(...newestBase)).toISOString()}) landed AFTER the last check finished (${new Date(Math.max(...newestCheck)).toISOString()}).`,
    )
  }
  return { behindBy, detail }
}

/**
 * The CURRENT tip of the base branch. See checkStaleness for why `baseRefOid`
 * cannot be used for this. Falls back to that snapshot only when the ref lookup
 * fails outright, which is strictly better than giving up on the check.
 */
function resolveBaseTip(slug, pr) {
  const res = runGh(['api', `repos/${slug}/git/ref/heads/${pr.baseRefName}`, '--jq', '.object.sha'])
  const sha = res.ok ? res.stdout.trim() : ''
  if (/^[0-9a-f]{40}$/.test(sha)) return sha
  return typeof pr.baseRefOid === 'string' && pr.baseRefOid !== '' ? pr.baseRefOid : null
}

function repoSlugFromUrl(url) {
  if (typeof url !== 'string') return null
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${USAGE}\n\n`)
    verdict('ERROR', error instanceof Error ? error.message : String(error))
  }

  if (opts.help) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }

  const startedAt = Date.now()
  const deadline = startedAt + opts.timeout * 60_000
  const graceDeadline = startedAt + opts.grace * 1000
  const target = opts.pr ? `PR #${opts.pr}` : 'the current branch’s PR'

  say(
    `watching ${target}${opts.repo ? ` in ${opts.repo}` : ''} -- poll ${opts.interval}s, timeout ${opts.timeout}m, grace ${opts.grace}s`,
  )

  let lastSignature = null
  let lastState = null
  let consecutiveErrors = 0

  for (;;) {
    const pr = fetchPr(opts)
    if (!pr.ok) {
      // Failure mode 4: this is reported, never mistaken for "still pending".
      if (pr.permanent) {
        verdict('ERROR', 'gh could not read the PR', [
          pr.stderr,
          'This error will not resolve by waiting.',
        ])
      }
      consecutiveErrors += 1
      say(`gh pr view failed (${consecutiveErrors}/${opts.maxErrors}): ${pr.stderr}`)
      if (consecutiveErrors >= opts.maxErrors) {
        verdict('ERROR', `gh failed ${consecutiveErrors} times in a row`, [pr.stderr])
      }
      await sleep(opts.interval * 1000 * consecutiveErrors)
      continue
    }

    const checksResult = fetchChecks(opts)
    if (!checksResult.ok) {
      if (checksResult.permanent) {
        verdict('ERROR', 'gh could not read the PR checks', [
          checksResult.stderr,
          'This error will not resolve by waiting.',
        ])
      }
      consecutiveErrors += 1
      say(`gh pr checks failed (${consecutiveErrors}/${opts.maxErrors}): ${checksResult.stderr}`)
      if (consecutiveErrors >= opts.maxErrors) {
        verdict('ERROR', `gh failed ${consecutiveErrors} times in a row`, [checksResult.stderr])
      }
      await sleep(opts.interval * 1000 * consecutiveErrors)
      continue
    }

    consecutiveErrors = 0
    const checks = checksResult.checks
    lastState = describe(pr.pr, checks)

    const signature = signatureOf(pr.pr, checks)
    if (opts.verbose || signature !== lastSignature) {
      say(lastState)
      lastSignature = signature
    }

    const decision = evaluate(opts, pr.pr, checks, { graceDeadline })
    if (decision) verdict(decision.name, decision.summary, decision.details)

    if (Date.now() >= deadline) {
      // Failure mode 1: the give-up path is the loudest one in the file.
      verdict('TIMED_OUT', `no definite result after ${opts.timeout}m`, [
        `Current state: ${lastState}`,
        `PR: ${pr.pr.url}`,
        'Checks were still running or unreported when the budget ran out; this is NOT a pass.',
      ])
    }

    await sleep(Math.min(opts.interval * 1000, Math.max(1000, deadline - Date.now())))
  }
}

/**
 * Returns a verdict when the situation is decided, or null to keep waiting.
 * Order matters: conflicts before check state, because a conflicted PR has
 * nothing to wait for (failure mode 2).
 */
function evaluate(opts, pr, checks, { graceDeadline }) {
  const conflicted = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'
  if (conflicted) {
    return {
      name: 'BLOCKED',
      summary: `${pr.baseRefName} conflicts with this PR -- CI may never run`,
      details: [
        `mergeable=${pr.mergeable} mergeState=${pr.mergeStateStatus}`,
        `Resolve by rebasing or merging ${pr.baseRefName} into the PR branch, then re-run this watcher.`,
        `Checks currently reported: ${checks.length}`,
        `PR: ${pr.url}`,
      ],
    }
  }

  // A closed or merged PR will never produce new check results, so evaluate
  // what exists once and stop rather than polling a corpse.
  const prSettled = pr.state !== 'OPEN'

  const { counts, unknown } = summarize(checks)

  if (checks.length === 0) {
    if (!prSettled && Date.now() < graceDeadline) return null
    return {
      name: 'NO_CHECKS',
      summary: 'no checks are registered on this PR',
      details: [
        prSettled
          ? `PR state is ${pr.state}; no checks were ever reported.`
          : 'The grace period elapsed with zero checks reported.',
        'Either no workflow triggers on this branch, checks are disabled, or the workflow file itself failed to parse.',
        `PR: ${pr.url}`,
      ],
    }
  }

  const stillRunning = counts.pending > 0
  const failed = checks.filter((c) => c?.bucket === 'fail')
  const cancelled = checks.filter((c) => c?.bucket === 'cancel')
  const pending = checks.filter((c) => c?.bucket === 'pending')

  // Default is to let every check conclude, so the failure list is complete --
  // a half-reported failure sends you back to the PR page anyway. --fail-fast
  // trades that completeness for an earlier answer.
  const decidedEarly = opts.failFast && (failed.length > 0 || cancelled.length > 0)
  if (stillRunning && !prSettled && !decidedEarly) return null

  if (failed.length > 0 || cancelled.length > 0) {
    const details = []
    for (const check of failed)
      details.push(`FAILED  ${nameOf(check)}  ${check?.link ?? ''}`.trimEnd())
    for (const check of cancelled)
      details.push(`CANCELLED ${nameOf(check)}  ${check?.link ?? ''}`.trimEnd())
    if (pending.length > 0)
      details.push(`${pending.length} check(s) still running; the PR is already not mergeable.`)
    details.push(`PR: ${pr.url}`)
    return {
      name: 'FAILED',
      summary: `${failed.length} failed, ${cancelled.length} cancelled of ${checks.length} checks`,
      details,
    }
  }

  if (stillRunning && prSettled) {
    return {
      name: 'TIMED_OUT',
      summary: `PR is ${pr.state} with ${pending.length} check(s) never concluded`,
      details: [`No further results will arrive on a ${pr.state} PR.`, `PR: ${pr.url}`],
    }
  }

  if (unknown > 0) {
    return {
      name: 'ERROR',
      summary: `${unknown} check(s) reported a bucket this script does not recognize`,
      details: [
        `Recognized buckets: ${BUCKET_ORDER.join(', ')}.`,
        'Refusing to call this a pass. Inspect with: gh pr checks --json name,bucket,state',
        `PR: ${pr.url}`,
      ],
    }
  }

  const details = [
    `${counts.pass} passed, ${counts.skipping} skipped, 0 failed.`,
    `mergeable=${pr.mergeable} mergeState=${pr.mergeStateStatus}`,
  ]
  if (prSettled) details.push(`PR state is ${pr.state}.`)

  const stale = checkStaleness(opts, pr, checks)
  if (stale?.unavailable) {
    details.push(`Could not verify base freshness: ${stale.unavailable}`)
  } else if (stale) {
    details.push(`STALE WARNING: ${stale.detail.join(' ')}`)
    details.push(
      `Green here means "green against an older ${pr.baseRefName}". Update the branch to re-verify.`,
    )
  }
  details.push(`PR: ${pr.url}`)

  return {
    name: 'PASSED',
    summary:
      stale && !stale.unavailable
        ? 'all checks passed (against an older base -- see below)'
        : 'all checks passed',
    details,
  }
}

main().catch((error) => {
  verdict('ERROR', 'watcher crashed', [
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  ])
})
