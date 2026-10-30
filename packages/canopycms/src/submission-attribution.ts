import type { UserSearchResult } from './auth/types'
import { personName } from './auth/person-name'
import type { CanopyUser } from './user'
import { getErrorMessage } from './utils/error'
import { canopyLogWarn } from './utils/logger'
import { editorDeepLink } from './editor-url'
import type { CommentThread } from './comment-store'
import type { BranchReview } from './types'

/**
 * Who submitted (and edited) a branch, recorded in the submit commit's trailers
 * and the pull request body. The bot stays the commit author; these records are
 * the only place the editing user appears.
 *
 * Display names, ids and emails come from the auth provider and end up in git
 * history and in GitHub-rendered Markdown, so each passes through a sanitizer
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
/** How many changed paths the PR body lists. */
export const MAX_LISTED_ENTRIES = 100
/**
 * The section's own text, its comment block aside. With the block's MAX_COMMENTS_LENGTH the
 * section stays under 45,200, leaving over 20,000 of GitHub's 65,536 to the text a human adds.
 */
const MAX_SECTION_LENGTH = 30_000

/**
 * The PR body region canopycms owns. On update only the text between these
 * markers is replaced, so anything a human wrote around it survives.
 * @internal Exported for tests.
 */
export const PR_SECTION_START = '<!-- canopycms:submission:start -->'
/** @internal Exported for tests. */
export const PR_SECTION_END = '<!-- canopycms:submission:end -->'

/**
 * The editor-comment summary, nested in the section so a comment change can replace it alone:
 * the rest of the section is built from the submit (mergeCommentsBlock).
 * @internal Exported for tests.
 */
export const PR_COMMENTS_START = '<!-- canopycms:comments:start -->'
/** @internal Exported for tests. */
export const PR_COMMENTS_END = '<!-- canopycms:comments:end -->'

/**
 * The reviewer's verdict, nested in the section like the comment block so a review action can
 * replace it alone (mergeReviewBlock).
 * @internal Exported for tests.
 */
export const PR_REVIEW_START = '<!-- canopycms:review:start -->'
/** @internal Exported for tests. */
export const PR_REVIEW_END = '<!-- canopycms:review:end -->'

// Cc (C0/C1 controls incl. newlines), Cf (zero-width and bidi overrides), Zl/Zp
// (Unicode line/paragraph separators) can forge a trailer line or hide text; Cs
// (a lone surrogate) reaches git as U+FFFD, since Node encodes it so.
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu
// `<>` would end a Co-authored-by email or open HTML / a section marker, `()`
// would let a name forge the id that follows it, a backtick would close the
// code span names render in, and a backslash is Markdown's escape character.
const STRUCTURAL = /[<>()`\\]/g

function truncate(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value
}

/**
 * A changed path for a code span: only what could break out of the span or out
 * of the section is removed, so `app/(group)/page.mdx` stays distinct from
 * `app/page.mdx`. No NFKC, for the same reason.
 */
function cleanPath(raw: string): string | undefined {
  const cleaned = raw.replace(INVISIBLE_OR_CONTROL, ' ').replace(/[<>`]/g, '').trim()
  return cleaned ? truncate(cleaned, 300) : undefined
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
 * A display name safe for a single line of git trailer or Markdown, or undefined.
 * @internal Exported for tests.
 */
export function sanitizeDisplayName(raw: string | undefined): string | undefined {
  return cleanText(raw, MAX_NAME_LENGTH)
}

// Ids and emails are accepted as the provider issued them or rejected, never
// cleaned: cleaning could merge two users or attribute an edit to someone else.
// A trailer still swaps in look-alikes for display (trailerText).
const UNSAFE_VERBATIM_CHAR = /[\s\p{Cc}\p{Cf}\p{Cs}<>()`\\]/u

/**
 * The auth user id unchanged, or undefined if it holds characters unsafe to record.
 * @internal Exported for tests.
 */
export function sanitizeUserId(raw: string | undefined): string | undefined {
  if (!raw || Array.from(raw).length > MAX_ID_LENGTH || UNSAFE_VERBATIM_CHAR.test(raw))
    return undefined
  return raw
}

const EMAIL_SHAPE = /^[^\s@<>()"',;:\\[\]]+@[^\s@<>()"',;:\\[\]]+\.[^\s@<>()"',;:\\[\]]+$/

/**
 * The email as given if it is a plain single-address email, otherwise undefined.
 * @internal Exported for tests.
 */
export function sanitizeEmail(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  // `\s` misses most C0/C1 controls, and a NUL makes git's spawn throw. `#` is
  // legal in an address but GitHub links `#12` in a commit message.
  if (
    trimmed.length > MAX_EMAIL_LENGTH ||
    UNSAFE_VERBATIM_CHAR.test(trimmed) ||
    trimmed.includes('#')
  )
    return undefined
  return EMAIL_SHAPE.test(trimmed) ? trimmed : undefined
}

/** The submitter as a SubmissionEditor, or undefined for an anonymous user. */
export function submissionEditorFromUser(user: CanopyUser): SubmissionEditor | undefined {
  if (user.type !== 'authenticated') return undefined
  return { userId: user.userId, name: user.name, email: user.email }
}

/** Looks a user up by id, as `AuthPlugin.getUserMetadata` does. */
export type EditorLookup = (userId: string) => Promise<UserSearchResult | null>

/**
 * Recorded editor ids as SubmissionEditors, with the email and usable name (see personName) the
 * auth provider gives now. A user the lookup cannot find, or a lookup that throws, keeps just the id.
 */
export async function describeEditors(
  userIds: readonly string[],
  lookup: EditorLookup | undefined,
): Promise<SubmissionEditor[]> {
  return Promise.all(
    userIds.map(async (userId): Promise<SubmissionEditor> => {
      if (!lookup) return { userId }
      try {
        const found = await lookup(userId)
        return found
          ? { userId, name: personName(userId, found.name), email: found.email }
          : { userId }
      } catch (err: unknown) {
        canopyLogWarn(
          'CanopyCMS: Could not look up an editor; crediting them by id:',
          getErrorMessage(err),
        )
        return { userId }
      }
    }),
  )
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
    if (!userId) {
      // The id itself stays out of the log: it is the unsafe value.
      if (editor.userId) {
        canopyLogWarn('CanopyCMS: Not recording an editor whose user id is unsafe to write to git')
      }
      continue
    }
    if (seen.has(userId)) continue
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
 * GitHub autolinks commit messages: `@user` mentions, `scheme://` URLs, and `#12` /
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
  /** The submitted branch and the editor page URL (editor-url.ts); together they enable links. */
  branch?: string
  editorUrl?: string
  /** The entry logical path of each changed path that is an entry, for its deep link. */
  entryPaths?: ReadonlyMap<string, string>
  /** The branch's editor comment threads (comments.json), or null when they could not be read. */
  threads?: readonly CommentThread[] | null
}

/**
 * A URL safe as a Markdown link destination: the characters that could end the destination,
 * open a title or escape are percent-encoded, which a server reads as the same address.
 * Brackets are legal in a destination and are an IPv6 host's syntax, so they stay.
 */
function markdownHref(href: string): string {
  return href.replace(
    /[()<>\\\s'"`]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

const PR_COMMENTS_NOTICE =
  'Comments on this pull request do not reach the CanopyCMS editor, so the author will not see them.'

function editorLabel(editor: CleanEditor): string {
  return editor.name
    ? `${codeSpan(editor.name)} (${codeSpan(editor.userId)})`
    : codeSpan(editor.userId)
}

/** A Markdown-safe editor link for `branch` (and an entry), or undefined without a URL or branch. */
function editorLinker(branch: string | undefined, editorUrl: string | undefined) {
  return (entryPath?: string): string | undefined =>
    branch && editorUrl ? markdownHref(editorDeepLink(editorUrl, branch, entryPath)) : undefined
}

const REVIEW_NOT_A_GITHUB_REVIEW = 'Approval in CanopyCMS is not a GitHub review.'

/** The UTC minute as `date time UTC`, or undefined for a timestamp that is not a date. */
function reviewTime(at: unknown): string | undefined {
  const time = typeof at === 'string' ? new Date(at) : undefined
  return time && !Number.isNaN(time.getTime())
    ? `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : undefined
}

/**
 * The reviewer's verdict between its markers. The name is a cleaned code span, so it cannot
 * mention, reference an issue, carry HTML or spell a marker; the id is never written, and a
 * name that is only the id counts as none.
 */
export function buildReviewBlock(
  review: BranchReview | undefined,
  keptOverGitHub: readonly string[] = [],
): string {
  const verdict =
    review?.state === 'approved'
      ? 'Approved'
      : review?.state === 'changes-requested'
        ? 'Changes requested'
        : undefined
  let status = 'Not yet reviewed in CanopyCMS.'
  if (review && verdict) {
    // Cleaned first, so a name that becomes the id once cleaned still counts as none.
    const name = personName(review.by.userId, sanitizeDisplayName(review.by.name))
    const when = reviewTime(review.at)
    status = `${verdict} in CanopyCMS by ${name ? codeSpan(name) : 'a reviewer'}${when ? ` on ${when}` : ''}.`
  }
  const kept = keptOverGitHubNote(keptOverGitHub)
  return `${PR_REVIEW_START}\n${status}\n${REVIEW_NOT_A_GITHUB_REVIEW}\n${kept}${PR_REVIEW_END}`
}

const MAX_LISTED_KEPT_PATHS = 20
const MAX_KEPT_PATH_LENGTH = 120

/** The paths as code spans, one per line and bounded: a path comes from a commit on GitHub. */
function keptOverGitHubNote(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  const listed = paths
    .slice(0, MAX_LISTED_KEPT_PATHS)
    .flatMap((p) => {
      const clean = cleanPath(p)
      return clean ? [`- ${codeSpan(truncate(clean, MAX_KEPT_PATH_LENGTH))}`] : []
    })
    .join('\n')
  const more = paths.length - MAX_LISTED_KEPT_PATHS
  return (
    `\nA commit on GitHub changed these files too. The editor's version was kept, and that ` +
    `change is no longer in them:\n${listed}\n${more > 0 ? `...and ${more} more\n` : ''}`
  )
}

const MAX_LISTED_THREADS = 50
const MAX_EXCERPT_LENGTH = 80
const MAX_COMMENTS_LENGTH = 15_000
const LINE_BREAK = /\r\n?|\n|\u2028|\u2029/

/**
 * An entry path from comments.json, which is read without validation, if it is a plain
 * logical path: the editor's `entry` param matches it exactly, so anything else links nowhere.
 */
function threadEntryPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || cleanPath(raw) !== raw) return undefined
  return raw.split('/').every((s) => s !== '' && s !== '.' && s !== '..') ? raw : undefined
}

/**
 * One line per unresolved thread: where it is, the first line of its first comment and a link.
 * The excerpt is a code span of cleaned text, so a comment cannot mention, reference an issue
 * (or close one), autolink or carry HTML; it is visible to everyone who can read the PR.
 */
function threadLine(thread: CommentThread, link: (entryPath?: string) => string | undefined) {
  const entryPath = threadEntryPath(thread.entryPath)
  const field =
    thread.type === 'field' && typeof thread.canopyPath === 'string'
      ? cleanText(thread.canopyPath, MAX_NAME_LENGTH)
      : undefined
  const where = entryPath
    ? `${codeSpan(entryPath)}${field ? ` › ${codeSpan(field)}` : ''}`
    : thread.type === 'branch'
      ? 'Branch'
      : 'An entry'
  const [first] = Array.isArray(thread.comments) ? thread.comments : []
  const text = typeof first?.text === 'string' ? first.text.split(LINE_BREAK)[0] : undefined
  const excerpt = cleanText(text, MAX_EXCERPT_LENGTH)
  const href = entryPath ? link(entryPath) : thread.type === 'branch' ? link() : undefined
  return [
    `- ${where}`,
    excerpt ? ` — ${codeSpan(excerpt)}` : '',
    href ? ` ([open in editor](${href}))` : '',
  ].join('')
}

/**
 * The editor-comment summary between its markers: the unresolved threads, oldest first, or
 * that every thread is resolved, or that there are none, or that they could not be read.
 * comments.json is read without validation, so an entry that is not an object is skipped.
 */
export function buildCommentsBlock(
  threads: readonly CommentThread[] | null,
  branch?: string,
  editorUrl?: string,
): string {
  if (threads === null) {
    return `${PR_COMMENTS_START}\nThe editor comments could not be read.\n${PR_COMMENTS_END}`
  }
  const open = threads
    .filter((t) => typeof t === 'object' && t !== null && !t.resolved)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  let body: string
  if (open.length > 0) {
    const listed = open.slice(0, MAX_LISTED_THREADS)
    const linker = editorLinker(branch, editorUrl)
    let lines = listed.map((t) => threadLine(t, linker))
    // The PR body's 65,536-character limit is shared with the rest of the section: past the
    // budget the links go, then lines from the end.
    if (lines.join('\n').length > MAX_COMMENTS_LENGTH) {
      lines = listed.map((t) => threadLine(t, () => undefined))
    }
    let shown = lines.length
    while (shown > 0 && lines.slice(0, shown).join('\n').length > MAX_COMMENTS_LENGTH) shown--
    lines = lines.slice(0, shown)
    if (open.length > shown) lines.push(`- …and ${open.length - shown} more`)
    const noun = open.length === 1 ? 'comment thread' : 'comment threads'
    body = `**${open.length} unresolved editor ${noun}**\n\n${lines.join('\n')}`
  } else {
    body = threads.length > 0 ? 'All editor comments resolved.' : 'No editor comments.'
  }
  return `${PR_COMMENTS_START}\n${body}\n${PR_COMMENTS_END}`
}

interface SectionLayout {
  entryLinks: boolean
  /** How many changed paths to list. */
  listed: number
  /** The description as written into the body: already neutralized and cut. */
  description: string
}

function renderPrSection(
  input: PrSectionInput,
  layout: SectionLayout,
  commentsBlock: string,
  reviewBlock: string,
): string {
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

  parts.push(reviewBlock)

  const link = editorLinker(input.branch, input.editorUrl)
  const branchLink = link()
  if (branchLink) parts.push(`[Open this branch in the editor](${branchLink})`)
  parts.push(
    `> [!IMPORTANT]\n> ${PR_COMMENTS_NOTICE} ` +
      (branchLink
        ? `Comment in the [editor](${branchLink}) instead.`
        : 'Comment in the editor instead.'),
  )

  const paths = changedPathsOf(input)
  if (paths.length > 0) {
    const listed = paths.slice(0, layout.listed).map(({ raw, clean }) => {
      const entryPath = layout.entryLinks ? input.entryPaths?.get(raw) : undefined
      const entryLink = entryPath === undefined ? undefined : link(entryPath)
      return entryLink
        ? `- ${codeSpan(clean)} ([open in editor](${entryLink}))`
        : `- ${codeSpan(clean)}`
    })
    if (paths.length > layout.listed) listed.push(`- …and ${paths.length - layout.listed} more`)
    parts.push(`**Changed entries (${paths.length})**\n\n${listed.join('\n')}`)
  }

  parts.push(commentsBlock)

  // Last, so an unclosed fence or `<details>` in free Markdown cannot swallow
  // the attribution above it.
  if (layout.description) parts.push(layout.description)

  return `${PR_SECTION_START}\n${parts.join('\n\n')}\n${PR_SECTION_END}`
}

function changedPathsOf(input: PrSectionInput): { raw: string; clean: string }[] {
  return [...new Set(input.changedPaths)]
    .map((raw) => ({ raw, clean: cleanPath(raw) }))
    .filter((p): p is { raw: string; clean: string } => p.clean !== undefined)
}

/** `text` cut to at most `max` UTF-16 units, never inside a surrogate pair. */
function truncateUnits(text: string, max: number): string {
  if (text.length <= max) return text
  if (max < 1) return ''
  const cut = text.slice(0, max - 1)
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}

/**
 * The canopycms-owned PR body section, including its start and end markers. GitHub refuses a
 * body over 65,536 characters and the rest of the body is a human's, so a section whose text
 * apart from the comment block is over MAX_SECTION_LENGTH loses its entry links, then the
 * description's end, then entries from the end of the list. The attribution lines themselves
 * are never cut. The comment block, rendered now or re-rendered later, has MAX_COMMENTS_LENGTH.
 */
export function buildPrSection(input: PrSectionInput): string {
  const raw = input.description?.trim()
  const description = raw ? neutralizeComments(truncate(raw, MAX_DESCRIPTION_LENGTH)) : ''
  const block = buildCommentsBlock(
    input.threads === undefined ? [] : input.threads,
    input.branch,
    input.editorUrl,
  )
  // A submit clears the stored review, so a new section starts unreviewed.
  const reviewBlock = buildReviewBlock(undefined)
  const size = (l: SectionLayout) =>
    renderPrSection(input, l, block, reviewBlock).length - block.length
  const layout: SectionLayout = { entryLinks: true, listed: MAX_LISTED_ENTRIES, description }
  const fits = (l: SectionLayout) => size(l) <= MAX_SECTION_LENGTH

  if (fits(layout)) return renderPrSection(input, layout, block, reviewBlock)
  layout.entryLinks = false
  if (fits(layout)) return renderPrSection(input, layout, block, reviewBlock)
  // The description's separator is two newlines.
  const room = MAX_SECTION_LENGTH - size({ ...layout, description: '' }) - 2
  if (room > 0) {
    return renderPrSection(
      input,
      { ...layout, description: truncateUnits(description, room) },
      block,
      reviewBlock,
    )
  }
  layout.description = ''
  while (layout.listed > 0 && !fits(layout)) layout.listed = Math.max(0, layout.listed - 10)
  return renderPrSection(input, layout, block, reviewBlock)
}

/**
 * `existing` with its canopycms section replaced by `section`, keeping every
 * character outside the markers. The section is the first end marker together
 * with the nearest start marker before it, so a lone start marker a human quoted
 * earlier in the body is skipped. With no such pair, stray markers are
 * removed and `section` is appended after the human text.
 */
export function mergePrSection(existing: string | null | undefined, section: string): string {
  const body = existing ?? ''
  const found = findPrSection(body)
  if (found) {
    return body.slice(0, found.start) + section + body.slice(found.end + PR_SECTION_END.length)
  }
  const human = body.split(PR_SECTION_START).join('').split(PR_SECTION_END).join('').trimEnd()
  return human ? `${human}\n\n${section}` : section
}

/** The index pair of the canopycms section in `body` (see mergePrSection), or undefined. */
function findPrSection(body: string): { start: number; end: number } | undefined {
  for (let end = body.indexOf(PR_SECTION_END); end >= 0; ) {
    const start = body.lastIndexOf(PR_SECTION_START, end - PR_SECTION_START.length)
    if (start >= 0) return { start, end }
    end = body.indexOf(PR_SECTION_END, end + PR_SECTION_END.length)
  }
  return undefined
}

/**
 * `existing` with the comment block inside its canopycms section replaced by `block`, or
 * undefined when the section or its block is missing (a PR body written before the block
 * existed, or edited by hand): the next submit writes both. Only markers inside the section
 * count, and the description in it cannot spell one (neutralizeComments).
 */
export function mergeCommentsBlock(
  existing: string | null | undefined,
  block: string,
): string | undefined {
  const body = existing ?? ''
  const section = findPrSection(body)
  if (!section) return undefined
  const start = body.indexOf(PR_COMMENTS_START, section.start)
  const end = start < 0 ? -1 : body.indexOf(PR_COMMENTS_END, start)
  if (start < 0 || end < 0 || end > section.end) return undefined
  return body.slice(0, start) + block + body.slice(end + PR_COMMENTS_END.length)
}

/**
 * `existing` with the review block inside its canopycms section replaced by `block`, or
 * undefined when the section or its block is missing (a PR body written before the block
 * existed, or edited by hand): the next submit writes it. Markers are found as in
 * mergeCommentsBlock.
 */
export function mergeReviewBlock(
  existing: string | null | undefined,
  block: string,
): string | undefined {
  const body = existing ?? ''
  const section = findPrSection(body)
  if (!section) return undefined
  const start = body.indexOf(PR_REVIEW_START, section.start)
  const end = start < 0 ? -1 : body.indexOf(PR_REVIEW_END, start)
  if (start < 0 || end < 0 || end > section.end) return undefined
  return body.slice(0, start) + block + body.slice(end + PR_REVIEW_END.length)
}
