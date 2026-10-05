import type { CanopyUser } from './user'

/**
 * Who submitted (and edited) a branch, recorded in the submit commit's trailers
 * and the pull request body. The bot stays the commit author; these records are
 * the only place the editing user appears.
 *
 * Display names and ids come from the auth provider and end up in git history
 * and in GitHub-rendered Markdown, so every value passes through the sanitizers
 * below before it is written anywhere.
 */
export interface SubmissionEditor {
  userId: string
  name?: string
  email?: string
}

const MAX_NAME_LENGTH = 80
const MAX_ID_LENGTH = 128
const MAX_EMAIL_LENGTH = 254
const MAX_DESCRIPTION_LENGTH = 10_000
const MAX_LISTED_ENTRIES = 100

/**
 * The PR body region canopycms owns. On update only the text between these
 * markers is replaced, so anything a human wrote around it survives.
 * @internal Exported for tests.
 */
export const PR_SECTION_START = '<!-- canopycms:submission:start -->'
/** @internal Exported for tests. */
export const PR_SECTION_END = '<!-- canopycms:submission:end -->'

// Cc (C0/C1 controls incl. newlines), Cf (zero-width and bidi overrides), Zl/Zp
// (Unicode line/paragraph separators). Any of these can forge a trailer line or
// hide text.
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
// `<>` would end a Co-authored-by email or open HTML / a section marker, `()`
// would let a name forge the id that follows it, a backtick would close the
// code span names render in, and a backslash would escape the next character.
const STRUCTURAL = /[<>()`\\]/g

function truncate(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value
}

function cleanText(raw: string | undefined, max: number): string | undefined {
  if (raw === undefined) return undefined
  const cleaned = raw
    .normalize('NFKC')
    .replace(INVISIBLE_OR_CONTROL, ' ')
    .replace(STRUCTURAL, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? truncate(cleaned, max) : undefined
}

/**
 *A display name safe for a single line of git trailer or Markdown, or undefined.
 * @internal Exported for tests.
 */
export function sanitizeDisplayName(raw: string | undefined): string | undefined {
  return cleanText(raw, MAX_NAME_LENGTH)
}

// Ids and emails are recorded exactly as the provider issued them or not at
// all: rewriting one could merge two users or attribute an edit to someone else.
const UNSAFE_VERBATIM_CHAR = /[\s\p{Cc}\p{Cf}<>()`\\]/u

/**
 *The auth user id unchanged, or undefined if it holds characters unsafe to record.
 * @internal Exported for tests.
 */
export function sanitizeUserId(raw: string | undefined): string | undefined {
  if (!raw || Array.from(raw).length > MAX_ID_LENGTH || UNSAFE_VERBATIM_CHAR.test(raw))
    return undefined
  return raw
}

const EMAIL_SHAPE = /^[^\s@<>()"',;:\\[\]]+@[^\s@<>()"',;:\\[\]]+\.[^\s@<>()"',;:\\[\]]+$/

/**
 *The email as given if it is a plain single-address email, otherwise undefined.
 * @internal Exported for tests.
 */
export function sanitizeEmail(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  // `\s` misses most C0/C1 controls, and a NUL makes git's spawn throw.
  if (trimmed.length > MAX_EMAIL_LENGTH || UNSAFE_VERBATIM_CHAR.test(trimmed)) return undefined
  return EMAIL_SHAPE.test(trimmed) ? trimmed : undefined
}

/** The submitter as a SubmissionEditor, or undefined for an anonymous user. */
export function submissionEditorFromUser(user: CanopyUser): SubmissionEditor | undefined {
  if (user.type !== 'authenticated') return undefined
  return { userId: user.userId, name: user.name, email: user.email }
}

interface CleanEditor {
  userId: string
  name?: string
  email?: string
}

function cleanEditors(editors: readonly SubmissionEditor[]): CleanEditor[] {
  const seen = new Set<string>()
  const result: CleanEditor[] = []
  for (const editor of editors) {
    const userId = sanitizeUserId(editor.userId)
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    result.push({
      userId,
      name: sanitizeDisplayName(editor.name),
      email: sanitizeEmail(editor.email),
    })
  }
  return result
}

/**
 * GitHub autolinks commit messages: `@user` mentions, bare URLs, and `#12` /
 * `GH-12` issue references, which a closing keyword ("Closes #12") turns into an
 * issue close once the commit reaches the default branch. A trailer value gets
 * `@` and `#` swapped for look-alikes and the other two patterns broken. Its
 * input is already single-line and structure-free.
 */
function trailerText(value: string): string {
  return value
    .replace(/@/g, '＠')
    .replace(/#/g, '＃')
    .replace(/:\/\//g, ': //')
    .replace(/\bGH-(?=\d)/gi, (m) => `${m.slice(0, 2)}‐`)
}

export interface CommitTrailerOptions {
  /** One `Edited-by: Name (id)` per editor. */
  editedBy: boolean
  /** One `Co-authored-by: Name <email>` per editor whose email is valid. */
  coAuthoredBy: boolean
}

/** Git trailer lines for the given editors, deduplicated by user id. */
export function buildEditorTrailers(
  editors: readonly SubmissionEditor[],
  options: CommitTrailerOptions,
): string[] {
  const trailers: string[] = []
  const clean = cleanEditors(editors)
  if (options.editedBy) {
    for (const editor of clean) {
      trailers.push(
        editor.name
          ? `Edited-by: ${trailerText(editor.name)} (${trailerText(editor.userId)})`
          : `Edited-by: ${trailerText(editor.userId)}`,
      )
    }
  }
  if (options.coAuthoredBy) {
    for (const editor of clean) {
      if (!editor.email) continue
      trailers.push(
        `Co-authored-by: ${trailerText(editor.name ?? editor.userId)} <${editor.email}>`,
      )
    }
  }
  return trailers
}

/**
 * `subject`, then a blank line and the trailer block when there are trailers.
 * Git reads trailers only from the last paragraph, so the blank line is what
 * makes them trailers rather than part of the subject.
 */
export function appendTrailers(subject: string, trailers: readonly string[]): string {
  return trailers.length > 0 ? `${subject.trimEnd()}\n\n${trailers.join('\n')}` : subject
}

/**
 * Renders as inline code: GitHub neither autolinks, mentions nor interprets HTML
 * inside a code span. The input is already free of backticks.
 */
function codeSpan(value: string): string {
  return `\`${value}\``
}

/**
 * Free Markdown with every HTML comment opener and closer escaped, so the text
 * can neither close the canopycms section early nor open a comment that hides
 * the rest of the body. Escaped comments render as their literal text.
 */
function neutralizeComments(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/--!?>/g, '--&gt;')
}

export interface PrSectionInput {
  /** The branch description the editor wrote; free Markdown. */
  description?: string
  submitter?: SubmissionEditor
  /** Editors other than the submitter, when known. */
  editors?: readonly SubmissionEditor[]
  /** Repo-relative paths changed on the branch. */
  changedPaths: readonly string[]
}

function editorLabel(editor: CleanEditor): string {
  return editor.name
    ? `${codeSpan(editor.name)} (${codeSpan(editor.userId)})`
    : codeSpan(editor.userId)
}

/** The canopycms-owned PR body section, including its start and end markers. */
export function buildPrSection(input: PrSectionInput): string {
  const parts: string[] = []

  const [submitter] = input.submitter ? cleanEditors([input.submitter]) : []
  parts.push(
    submitter
      ? `Submitted by ${editorLabel(submitter)} via CanopyCMS.`
      : 'Submitted via CanopyCMS.',
  )

  const others = cleanEditors(input.editors ?? []).filter((e) => e.userId !== submitter?.userId)
  if (others.length > 0) {
    parts.push(`Also edited by: ${others.map(editorLabel).join(', ')}`)
  }

  const paths = [...new Set(input.changedPaths)]
    .map((p) => cleanText(p, 300))
    .filter((p): p is string => p !== undefined)
  if (paths.length > 0) {
    const listed = paths.slice(0, MAX_LISTED_ENTRIES).map((p) => `- ${codeSpan(p)}`)
    if (paths.length > MAX_LISTED_ENTRIES) {
      listed.push(`- …and ${paths.length - MAX_LISTED_ENTRIES} more`)
    }
    parts.push(`**Changed entries (${paths.length})**\n\n${listed.join('\n')}`)
  }

  // Last, so an unclosed fence or `<details>` in free Markdown cannot swallow
  // the attribution above it.
  const description = input.description?.trim()
  if (description) parts.push(neutralizeComments(truncate(description, MAX_DESCRIPTION_LENGTH)))

  return `${PR_SECTION_START}\n${parts.join('\n\n')}\n${PR_SECTION_END}`
}

/**
 * `existing` with its canopycms section replaced by `section`, keeping every
 * character outside the markers. The section is the first end marker together
 * with the nearest start marker before it, so a marker a human quoted earlier in
 * the body is never taken as the start. With no such pair, stray markers are
 * removed and `section` is appended after the human text.
 */
export function mergePrSection(existing: string | null | undefined, section: string): string {
  const body = existing ?? ''
  for (let end = body.indexOf(PR_SECTION_END); end >= 0; ) {
    const start = body.lastIndexOf(PR_SECTION_START, end - PR_SECTION_START.length)
    if (start >= 0) {
      return body.slice(0, start) + section + body.slice(end + PR_SECTION_END.length)
    }
    end = body.indexOf(PR_SECTION_END, end + PR_SECTION_END.length)
  }
  const human = body.split(PR_SECTION_START).join('').split(PR_SECTION_END).join('').trimEnd()
  return human ? `${human}\n\n${section}` : section
}
