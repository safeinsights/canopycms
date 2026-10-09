'use client'

/**
 * MarkdownField's MDXEditor visitors for markdown its own import and export would change the
 * meaning of: an ordered list's `start`, a link inside a formatted span, an auto-link inside code,
 * and the code spans either side of one. MDXEditor is passed in, as `mdx-jsx-support.tsx`
 * explains.
 */

import type * as MdxEditor from '@mdxeditor/editor'
import type { MdastImportVisitor } from '@mdxeditor/editor'

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
    lexical: { $isElementNode, $isTextNode },
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
   * see text, not formats, so a URL inside a code span becomes a link markdown never meant.
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
        url: lexicalNode.getURL(),
        title: lexicalNode.getTitle(),
        children: [],
      }
      actions.appendToParent(parent, link)
      actions.visitChildren(lexicalNode, link)
      if (carried.size > 0) link.children = withoutContainers(link.children, carried)
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
      realm.pub(addImportVisitor$, listStartImportVisitor)
      realm.pub(addExportVisitor$, [
        listStartExportVisitor,
        linkExportVisitor,
        inlineCodeJoinVisitor,
      ])
    },
  })
}
