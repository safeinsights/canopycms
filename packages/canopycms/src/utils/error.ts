/** Reading a `catch (err: unknown)` value as usable error information, without `any`. */

/** Message string for an unknown thrown value. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'string') {
    return err
  }
  return String(err)
}

/**
 * Redact sensitive material from an error message before it reaches an API client. Log the
 * ORIGINAL message server-side; send the sanitized one.
 *
 * Git/filesystem error text is unbounded (stderr varies by git version and locale, and hooks
 * print anything), so this redacts the known-sensitive SHAPES rather than enumerating safe
 * messages: credentials embedded in URLs (`https://x-access-token:tok@github.com/…`) and
 * absolute filesystem paths (workspace roots, EFS mounts, home directories). Paths under the
 * current working directory are shortened to relative form (CMS-internal layout like
 * `.canopy-dev/remote.git` helps debugging and is not sensitive); absolute paths outside it
 * become `<path>`.
 *
 * TAG: `[REDACT]` — grep it for every site that persists or surfaces raw error text on a path
 * reaching a browser (worker task errors folded into `worker-status.json`, `branch.json` parse
 * failures served by the admin branch-health endpoint, rebase-failure messages, and their
 * tests). A Node error embeds absolute paths and a git remote URL can embed a token, so
 * everything on such a path goes through this function. The tag is a grep aid; the rule itself
 * is stated at each site.
 */
export function sanitizeErrorMessage(message: string): string {
  let result = redactCredentials(message)
  // Paths under the project root become relative (split/join avoids regex-escaping issues with
  // arbitrary cwd values). The bare-cwd replacement is anchored to a token boundary so a sibling
  // directory that merely shares the cwd prefix (`${cwd}-other/…`) stays absolute and is fully
  // redacted below instead of leaking a mangled remainder.
  const cwd = process.cwd()
  if (cwd !== '/') {
    result = result.split(`${cwd}/`).join('')
    const cwdPattern = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // cwdPattern is process.cwd() (server-controlled, not attacker or entry-content data) with
    // regex metacharacters escaped by the literal regex above, so it cannot inject an
    // attacker-chosen pattern.
    // eslint-disable-next-line security/detect-non-literal-regexp
    result = result.replace(new RegExp(`${cwdPattern}(?=[\\s'"),:;]|$)`, 'g'), '.')
  }
  // Quoted absolute paths (git quotes most paths): redact the whole quoted span, spaces included.
  result = result.replace(/'\/[^']*'/g, "'<path>'").replace(/"\/[^"]*"/g, '"<path>"')
  // Remaining absolute POSIX paths (outside cwd, e.g. /mnt/efs/…). The leading boundary keeps
  // URL slashes (`https://host/…`) untouched. Known limitation: an UNQUOTED path containing
  // spaces is only redacted up to the first space — spaces are legal both inside paths and as
  // message separators, so that is not generally solvable here.
  //
  // The repeated group `(?:[^/\s'")]+\/)+` looks nested-quantifier-shaped, but its inner class
  // excludes `/`, so each repetition can only end at a literal `/`: a matched string has exactly
  // one decomposition, so it cannot backtrack catastrophically. Measured linear on adversarial
  // inputs up to 400k chars.
  // eslint-disable-next-line security/detect-unsafe-regex
  result = result.replace(/(^|[\s'"(=:,[])\/(?:[^/\s'")]+\/)+[^/\s'")]*/g, '$1<path>')
  // Windows drive paths
  result = result.replace(/[A-Za-z]:\\[^\s'")]+/g, '<path>')
  return result
}

/**
 * Redact only credential material, leaving filesystem paths intact — for server-side log lines
 * that deliberately keep full path detail for debugging but must never persist a live token.
 * Client-facing messages go through `sanitizeErrorMessage` instead, which calls this and then
 * also redacts paths.
 */
export function redactCredentials(message: string): string {
  let result = message
  // Credentials in URLs: scheme://user:token@host or scheme://token@host. Anchored on the
  // literal `://` (leaving the scheme untouched) — a `\w+` scheme prefix backtracks
  // polynomially on long word-character runs (CodeQL js/polynomial-redos).
  result = result.replace(/(:\/\/)[^/\s@]+@/g, '$1***@')
  // Bare token shapes, for messages embedding a token outside URL userinfo: GitHub token
  // prefixes and Bearer values.
  result = result.replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g, '***')
  result = result.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***')
  // PEM private-key blocks — a GitHub App's private key. Defense-in-depth like the bare-token
  // rules above: nothing today puts key material into an error, and none of those rules would
  // match one (a PEM has no URL userinfo, no `gh*_` prefix and no `Bearer`).
  //
  // Linear by construction. The label is bounded (`[A-Z]{0,9} ?`) rather than an open `[A-Z ]*`,
  // which would rescan a long run of capitals at every start position, and the lazy `[\s\S]*?`
  // stops at the END footer or at end-of-string — without that second alternative a key
  // truncated mid-message passes through in full. The footer is spelled out rather than
  // "`-----END` then anything up to the next dashes": greedy `[^\n]*` swallows the text after
  // the key, and lazy `[^\n]*?-----` stops on a label-less `-----END-----` and leaves a SECOND
  // key unredacted. Anything else falls through to `$`, which over-redacts — the safe direction.
  result = result.replace(
    /-----BEGIN [A-Z]{0,9} ?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z]{0,9} ?PRIVATE KEY-----|$)/g,
    '<private-key>',
  )
  // Bare JWTs (`eyJ…`) — three dot-separated base64url runs.
  //
  // The leading boundary is `(?<![\w-])`, NOT `\b`: `-` is in the run class but is not a word
  // character, so under `\b` every `-eyJ` inside one long `[\w-]` run starts a fresh match
  // attempt that rescans the rest of the run for a `.` that never comes — quadratic, measured in
  // seconds on a 160KB input where the lookbehind stays under a millisecond. It gives up exactly
  // one case: a JWT glued directly to a preceding hyphen (`x-eyJ…`); every real prefix —
  // whitespace, `"`, `=`, `(`, `Bearer ` — still matches.
  result = result.replace(/(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '***')
  return result
}

/** True for a Node system error — an `Error` carrying a `code` (ENOENT, EACCES, …). */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

/** True for ENOENT. */
export function isNotFoundError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ENOENT'
}

/** True for EACCES. */
export function isPermissionError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EACCES'
}

/** True for EEXIST. */
export function isFileExistsError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EEXIST'
}
