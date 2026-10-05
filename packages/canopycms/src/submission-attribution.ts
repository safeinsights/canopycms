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
 */
export const PR_SECTION_START = '<!-- canopycms:submission:start -->'
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

/** A display name safe for a single line of git trailer or Markdown, or undefined. */
export function sanitizeDisplayName(raw: string | undefined): string | undefined {
  return cleanText(raw, MAX_NAME_LENGTH)
}

/** An auth user id with no whitespace or structural characters, or undefined. */
export function sanitizeUserId(raw: string | undefined): string | undefined {
  const cleaned = cleanText(raw, MAX_ID_LENGTH)
  return cleaned?.replace(/\s/g, '') || undefined
}

const EMAIL_SHAPE = /^[^\s@<>()"',;:\\[\]]+@[^\s@<>()"',;:\\[\]]+\.[^\s@<>()"',;:\\[\]]+$/

/** The email as given if it is a plain single-address email, otherwise undefined. */
export function sanitizeEmail(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(trimmed)) return undefined
  return trimmed
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
 * Commit messages render on GitHub with @mentions and bare URLs autolinked, so a
 * trailer name gets its `@` swapped for a look-alike and its scheme separator
 * broken. The name is otherwise already single-line and structure-free.
 */
function trailerName(name: string): string {
  return name.replace(/@/g, '＠').replace(/:\/\//g, ': //')
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
          ? `Edited-by: ${trailerName(editor.name)} (${editor.userId})`
          : `Edited-by: ${editor.userId}`,
      )
    }
  }
  if (options.coAuthoredBy) {
    for (const editor of clean) {
      if (!editor.email) continue
      trailers.push(
        `Co-authored-by: ${trailerName(editor.name ?? editor.userId)} <${editor.email}>`,
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

  const description = input.description?.trim()
  if (description) parts.push(neutralizeComments(truncate(description, MAX_DESCRIPTION_LENGTH)))

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

  return `${PR_SECTION_START}\n${parts.join('\n\n')}\n${PR_SECTION_END}`
}

/**
 * `existing` with its canopycms section replaced by `section`, keeping every
 * character outside the markers. With no well-formed section in `existing`,
 * stray markers are removed and `section` is appended after the human text.
 */
export function mergePrSection(existing: string | null | undefined, section: string): string {
  const body = existing ?? ''
  const start = body.indexOf(PR_SECTION_START)
  const end = start >= 0 ? body.indexOf(PR_SECTION_END, start + PR_SECTION_START.length) : -1
  if (start >= 0 && end >= 0) {
    return body.slice(0, start) + section + body.slice(end + PR_SECTION_END.length)
  }
  const human = body.split(PR_SECTION_START).join('').split(PR_SECTION_END).join('').trimEnd()
  return human ? `${human}\n\n${section}` : section
}
