'use client'

/**
 * MarkdownField's MDXEditor visitors for markdown its own import and export would change the
 * meaning of: an ordered list's `start`, a bare URL, a link inside a formatted span, an auto-link
 * inside code, and the code spans either side of one. MDXEditor is passed in (`mdx-jsx-support`).
 */

import type * as MdxEditor from '@mdxeditor/editor'
import type { MdastImportVisitor } from '@mdxeditor/editor'

import {
  autolinkLiteralAt,
  gfmAutolinkLiteral,
  gfmAutolinkLiteralFromMarkdown,
  type AutolinkLiteral,
} from './gfm-autolink-literal'

type MdxEditorModule = typeof MdxEditor

type ExportParams = Parameters<NonNullable<MdxEditor.LexicalVisitor['visitLexicalNode']>>[0]
type LexicalNode = ExportParams['lexicalNode']
type MdastParent = ExportParams['mdastParent']
type MdastNode = Parameters<MdxEditorModule['isMdastJsxNode']>[0]
type MdastList = Extract<MdastNode, { type: 'list' }>
type MdastListItem = Extract<MdastNode, { type: 'listItem' }>
type MdastLink = Extract<MdastNode, { type: 'link' }>
type MdastPhrasing = MdastLink['children'][number]

/** The lexical ListNode methods used here; MDXEditor does not export `@lexical/list`. */
interface ListLike {
  getListType(): string
  getStart(): number
  setStart(start: number): unknown
}

function isListLike(node: unknown): node is ListLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    'getListType' in node &&
    'getStart' in node &&
    'setStart' in node &&
    typeof node.setStart === 'function'
  )
}

function isListItem(node: MdastParent): node is MdastParent & MdastListItem {
  return node.type === 'listItem'
}

/** The lexical LinkNode methods used here; an AutoLinkNode is one too. */
interface LinkLike {
  getURL(): string
  getTitle(): string | null
}

function isLinkLike(node: LexicalNode): node is LexicalNode & LinkLike {
  return (node.getType() === 'link' || node.getType() === 'autolink') && 'getURL' in node
}

const FORMAT_CONTAINER_TYPES = ['emphasis', 'strong', 'delete'] as const
type FormatContainerType = (typeof FORMAT_CONTAINER_TYPES)[number]
type FormatContainer = Extract<MdastPhrasing, { type: FormatContainerType }>

function isFormatContainer(node: MdastNode): node is FormatContainer {
  return (FORMAT_CONTAINER_TYPES as readonly string[]).includes(node.type)
}

/** Cuts `tail` off `nodes`' last text at any depth, returned in the spans it was cut from. */
function cutTail(nodes: MdastPhrasing[], tail: string): MdastPhrasing | undefined {
  const last = nodes.at(-1)
  if (last?.type === 'text') {
    if (!last.value.endsWith(tail)) return undefined
    last.value = last.value.slice(0, last.value.length - tail.length)
    if (last.value === '') nodes.pop()
    return { type: 'text', value: tail }
  }
  if (last === undefined || !isFormatContainer(last)) return undefined
  const cut = cutTail(last.children, tail)
  if (cut === undefined) return undefined
  if (last.children.length === 0) nodes.pop()
  return { ...last, children: [cut] }
}

/** `nodes` with every container of a type in `types` replaced by its children, at any depth. */
function withoutContainers(
  nodes: readonly MdastPhrasing[],
  types: ReadonlySet<string>,
): MdastPhrasing[] {
  return nodes.flatMap((node): MdastPhrasing[] => {
    if (!isFormatContainer(node)) return [node]
    const children = withoutContainers(node.children, types)
    return types.has(node.type) ? children : [{ ...node, children }]
  })
}

/** Creates the plugin from MDXEditor's exports; call once per load of MDXEditor. */
export function createMarkdownFidelityPlugin(mdx: MdxEditorModule): () => MdxEditor.RealmPlugin {
  const {
    IS_BOLD,
    IS_CODE,
    IS_ITALIC,
    IS_STRIKETHROUGH,
    addExportVisitor$,
    addImportVisitor$,
    addMdastExtension$,
    addSyntaxExtension$,
    lexical: { $getState, $isElementNode, $isTextNode, $setState, createState },
    realmPlugin,
  } = mdx

  const FORMATS: ReadonlyArray<{ format: number; type: FormatContainerType }> = [
    { format: IS_ITALIC, type: 'emphasis' },
    { format: IS_BOLD, type: 'strong' },
    { format: IS_STRIKETHROUGH, type: 'delete' },
  ]

  /** The formats every text node in `node` carries, or 0 for one with no text. */
  const sharedFormat = (node: LexicalNode): number => {
    const texts = $isElementNode(node) ? node.getChildren().filter($isTextNode) : []
    return texts.length === 0 ? 0 : texts.reduce((all, text) => all & text.getFormat(), ~0)
  }

  /**
   * What GFM reads from an auto-link's text where it stands. Lexical's matcher is its own regex,
   * which keeps trailing punctuation GFM leaves out and prefixes `https://` where GFM gives `http://`.
   */
  const gfmLiteralOf = (autolink: LexicalNode): AutolinkLiteral | undefined => {
    const text = autolink.getTextContent()
    let context = ''
    let offset = 0
    for (const sibling of autolink.getParent()?.getChildren() ?? [autolink]) {
      if (sibling.is(autolink)) offset = context.length
      context += sibling.getTextContent()
    }
    const here = autolinkLiteralAt(context, offset)
    if (here === undefined) return undefined
    return here.length <= text.length ? here : autolinkLiteralAt(text, 0) // ran into a sibling
  }

  /**
   * The href a link was imported with when its text is a literal GFM reads as exactly that link
   * (a bare URL, or `[url](url)` and `<url>`). Lexical keeps an AutoLinkNode's href in step
   * with its text, but not an imported LinkNode's; while the href is still this one, the export
   * reads it from the text instead.
   */
  const literalHref = createState('canopyGfmLiteralHref', {
    parse: (value) => (typeof value === 'string' ? value : null),
  })

  const literalLinkImportVisitor: MdastImportVisitor<MdastLink> = {
    priority: 100,
    testNode: (node) => {
      if (node.type !== 'link') return false
      const [only, ...rest] = 'children' in node ? node.children : []
      if (rest.length > 0 || only?.type !== 'text') return false
      const literal = autolinkLiteralAt(only.value, 0)
      return literal?.url === node.url && literal.length === only.value.length
    },
    visitNode({ mdastNode, lexicalParent, actions }) {
      actions.nextVisitor()
      const link = $isElementNode(lexicalParent) ? lexicalParent.getLastChild() : null
      if (link !== null && isLinkLike(link)) $setState(link, literalHref, mdastNode.url)
    },
  }

  /** What GFM reads from a link's text when the text decides its href, else null. */
  const textLiteralOf = (link: LexicalNode & LinkLike): AutolinkLiteral | undefined | null => {
    if (link.getType() === 'autolink') return gfmLiteralOf(link)
    const imported = $getState(link, literalHref)
    if (imported === null || imported !== link.getURL()) return null
    return autolinkLiteralAt(link.getTextContent(), 0)
  }

  // MDXEditor imports a list without its `start`, and exports one without it.
  const listStartImportVisitor: MdastImportVisitor<MdastList> = {
    priority: 100,
    testNode: (node) =>
      node.type === 'list' &&
      'ordered' in node &&
      node.ordered === true &&
      typeof node.start === 'number' &&
      node.start !== 1,
    visitNode({ mdastNode, lexicalParent, actions }) {
      actions.nextVisitor()
      // MDXEditor appends the list, or for a nested one, a list item holding it after the parent.
      // Under an insert, `lexicalParent` is an import point that is no element node.
      const holder =
        lexicalParent.getType() === 'listitem' && $isElementNode(lexicalParent)
          ? lexicalParent.getNextSibling()
          : lexicalParent
      const list = $isElementNode(holder)
        ? lexicalParent === holder
          ? holder.getLastChild()
          : holder.getFirstChild()
        : null
      if (isListLike(list) && typeof mdastNode.start === 'number') list.setStart(mdastNode.start)
    },
  }

  const listStartExportVisitor: MdxEditor.LexicalVisitor = {
    priority: 100,
    testLexicalNode: (node): node is LexicalNode =>
      isListLike(node) && node.getListType() === 'number' && node.getStart() !== 1,
    visitLexicalNode({ lexicalNode, mdastParent, actions }) {
      actions.nextVisitor()
      const list = mdastParent.children.at(-1)
      if (list?.type === 'list' && isListLike(lexicalNode)) list.start = lexicalNode.getStart()
      // Only a list starting at 1 can interrupt a paragraph, so one right after a paragraph in a
      // list item needs the blank line a loose item writes, or it reads back as that paragraph.
      if (isListItem(mdastParent) && mdastParent.children.at(-2)?.type === 'paragraph') {
        mdastParent.spread = true
      }
    },
  }

  /**
   * A link inside a bold, italic or struck-through span is written inside that span, carrying it
   * on as MDXEditor's text visitor carries a format across text nodes, so
   * `**Read the [guide](/g) first.**` keeps its shape; MDXEditor's own visitor writes the link
   * beside the span, bolding its text. A link the span ends at is written that way still, since
   * lexical keeps no record of which was written: `**[guide](/g)**` saves as `[**guide**](/g)`.
   *
   * An auto-link holding code-formatted text is written as its text: lexical's auto-link matchers
   * see text, not formats, so a URL inside a code span becomes a link markdown never meant. A link
   * whose text decides its href (`textLiteralOf`) is written as text where GFM links nothing, else
   * as GFM's link and the punctuation GFM leaves out.
   */
  const linkExportVisitor: MdxEditor.LexicalVisitor = {
    priority: 100,
    testLexicalNode: (node): node is LexicalNode & LinkLike => isLinkLike(node),
    visitLexicalNode({ lexicalNode, mdastParent, actions }) {
      if (!isLinkLike(lexicalNode)) return
      if (
        lexicalNode.getType() === 'autolink' &&
        $isElementNode(lexicalNode) &&
        lexicalNode
          .getChildren()
          .some((child) => $isTextNode(child) && (child.getFormat() & IS_CODE) !== 0)
      ) {
        actions.visitChildren(lexicalNode, mdastParent)
        return
      }
      const literal = textLiteralOf(lexicalNode)
      if (literal === undefined) {
        actions.visitChildren(lexicalNode, mdastParent)
        return
      }

      const format = sharedFormat(lexicalNode)
      const next = lexicalNode.getNextSibling()
      const carried = new Set<string>()
      let parent: MdastParent = mdastParent
      for (;;) {
        const last = parent.children.at(-1)
        const container = FORMATS.find(
          ({ format: bit, type }) => format & bit && !carried.has(type) && last?.type === type,
        )
        if (container === undefined || last === undefined || !('children' in last)) break
        carried.add(container.type)
        parent = last
      }
      for (const { format: bit, type } of FORMATS) {
        if (!(format & bit) || carried.has(type)) continue
        if (!$isTextNode(next) || !(next.getFormat() & bit)) continue
        const opened = actions.appendToParent(parent, { type, children: [] })
        if (!('children' in opened)) break
        carried.add(type)
        parent = opened
      }

      const link: MdastLink = {
        type: 'link',
        url: literal?.url ?? lexicalNode.getURL(),
        title: lexicalNode.getTitle(),
        children: [],
      }
      actions.appendToParent(parent, link)
      actions.visitChildren(lexicalNode, link)
      if (carried.size > 0) link.children = withoutContainers(link.children, carried)
      const tail = literal ? lexicalNode.getTextContent().slice(literal.length) : ''
      const cut = tail === '' ? undefined : cutTail(link.children, tail)
      if (cut !== undefined) actions.appendToParent(parent, cut)
    },
  }

  // Markdown has no way to write two code spans side by side, and an auto-link written as its
  // text leaves the code either side of it as separate spans.
  const inlineCodeJoinVisitor: MdxEditor.LexicalVisitor = {
    shouldJoin: (prev, current) => prev.type === 'inlineCode' && current.type === 'inlineCode',
    join(prev, current) {
      if (prev.type === 'inlineCode' && current.type === 'inlineCode') prev.value += current.value
      return prev
    },
  }

  return realmPlugin({
    init(realm) {
      // Without autolink literals a bare URL imports as text, for lexical's matcher to re-link.
      realm.pub(addSyntaxExtension$, gfmAutolinkLiteral())
      realm.pub(addMdastExtension$, gfmAutolinkLiteralFromMarkdown())
      realm.pub(addImportVisitor$, [listStartImportVisitor, literalLinkImportVisitor])
      realm.pub(addExportVisitor$, [
        listStartExportVisitor,
        linkExportVisitor,
        inlineCodeJoinVisitor,
      ])
    },
  })
}
