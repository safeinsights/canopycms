'use client'

/**
 * JSX support for MarkdownField's MDXEditor. Imported only from inside
 * MarkdownField's `React.lazy` loader, so `@mdxeditor/editor` stays out of the
 * initial editor chunk.
 *
 * MDXEditor parses JSX tags in every document, but without a visitor for a
 * tag it rejects the whole document and from then on suppresses `onChange`.
 * The catch-all descriptor here gives every tag a visitor; the guard plugin
 * turns the cases MDXEditor would otherwise lose without an error into the
 * `onError` that MarkdownField answers with its source editor.
 */

import React from 'react'

import {
  NestedLexicalEditor,
  UnrecognizedMarkdownConstructError,
  addImportVisitor$,
  importVisitors$,
  isMdastHTMLNode,
  isMdastJsxNode,
  jsxPlugin,
  realmPlugin,
  type JsxComponentDescriptor,
  type JsxEditorProps,
  type MdastImportVisitor,
  type MdastJsx,
} from '@mdxeditor/editor'

type MdastNode = Parameters<typeof isMdastJsxNode>[0]

function childrenOf(node: MdastNode): MdastNode[] {
  return 'children' in node && Array.isArray(node.children) ? node.children : []
}

/** Renders one JSX attribute as source text, e.g. `type="info"` or `count={…}`. */
function describeAttribute(attribute: MdastJsx['attributes'][number]): string {
  if (attribute.type === 'mdxJsxExpressionAttribute') return '{…}'
  if (attribute.value === null || attribute.value === undefined) return attribute.name
  if (typeof attribute.value === 'string') return `${attribute.name}="${attribute.value}"`
  return `${attribute.name}={…}`
}

/**
 * Edits the children of any JSX element, and shows its tag and attributes
 * read-only; attributes are edited in source mode.
 * Whether the nested editor is block or inline follows the parsed node, because
 * one `*` descriptor serves both, and a block editor rejects inline children.
 */
const CatchAllJsxEditor: React.FC<JsxEditorProps> = ({ mdastNode }) => {
  const inline = mdastNode.type === 'mdxJsxTextElement'
  const tag = [mdastNode.name ?? '', ...mdastNode.attributes.map(describeAttribute)]
    .join(' ')
    .trim()
  const Wrapper = inline ? 'span' : 'div'
  return (
    <Wrapper className={inline ? 'canopy-mdx-jsx canopy-mdx-jsx-inline' : 'canopy-mdx-jsx'}>
      <span className="canopy-mdx-jsx-tag" data-testid="mdx-jsx-tag" title={tag}>
        {`<${tag}>`}
      </span>
      {mdastNode.children.length > 0 ? (
        <NestedLexicalEditor<MdastJsx>
          block={!inline}
          getContent={(node) => node.children}
          getUpdatedMdastNode={(node, children) => ({ ...node, children }) as MdastJsx}
        />
      ) : null}
    </Wrapper>
  )
}

const catchAllJsxDescriptor: JsxComponentDescriptor = {
  name: '*',
  kind: 'flow',
  props: [],
  hasChildren: true,
  Editor: CatchAllJsxEditor,
}

type JsxAttribute = MdastJsx['attributes'][number]

const isStringAttribute = (attribute: JsxAttribute, name: string) =>
  attribute.type === 'mdxJsxAttribute' &&
  attribute.name === name &&
  typeof attribute.value === 'string'

/**
 * Whether MDXEditor's export throws on this element: it merges an HTML
 * element's only child, when that is a `span`, into the element, splitting
 * `className` and `style` values it assumes are strings on both.
 */
function breaksSpanCollapse(node: MdastJsx): boolean {
  const [onlyChild, ...rest] = node.children
  if (rest.length > 0 || onlyChild === undefined) return false
  if (onlyChild.type !== 'mdxJsxTextElement' || onlyChild.name !== 'span') return false
  return ['className', 'style'].some((name) => {
    const own = node.attributes.find((a) => a.type === 'mdxJsxAttribute' && a.name === name)
    const child = onlyChild.attributes.find((a) => a.type === 'mdxJsxAttribute' && a.name === name)
    return (
      own !== undefined &&
      child !== undefined &&
      !(isStringAttribute(own, name) && isStringAttribute(child, name))
    )
  })
}

/**
 * Whether MDXEditor's image plugin writes this `<img>` back unchanged. It drops
 * an `<img>` with no `src`, keeps only string attribute values, sets the
 * attributes it does not model through the DOM (which lowercases their names),
 * and parses `width` and `height` as integers.
 */
function roundTripsImage(node: MdastJsx): boolean {
  return (
    node.attributes.some((a) => isStringAttribute(a, 'src') && a.value !== '') &&
    node.attributes.every((attribute) => {
      if (attribute.type !== 'mdxJsxAttribute' || typeof attribute.value !== 'string') return false
      if (attribute.name === 'width' || attribute.name === 'height') {
        return /^\d+$/.test(attribute.value)
      }
      return attribute.name === attribute.name.toLowerCase()
    })
  )
}

/**
 * Why MDXEditor cannot round-trip this JSX element itself, or null if it can.
 * A fragment has no name, and MDXEditor's HTML handling throws a `TypeError` on
 * a nameless element.
 */
function unsupportedJsx(node: MdastNode): string | null {
  if (!isMdastJsxNode(node)) return null
  if (node.name === null) return 'fragments (<>…</>)'
  // `img` is the image plugin's, not in MDXEditor's HTML tag list.
  if (node.name === 'img') return roundTripsImage(node) ? null : 'this <img>'
  if (isMdastHTMLNode(node) && breaksSpanCollapse(node)) {
    return `<${node.name}> wrapping a <span>, with an {expression} class or style`
  }
  return null
}

/** Typed `string` because the mdast node union this package resolves omits the ESM node. */
const ESM_NODE_TYPE: string = 'mdxjsEsm'

/** Node types the table visitor imports itself, so they have no visitor of their own. */
const CONSUMED_BY_PARENT_VISITOR = new Set(['tableRow', 'tableCell'])

/**
 * Raises, at document import, what MDXEditor would otherwise lose, corrupt or
 * crash on without reporting it:
 *
 * - `import`/`export` lines: the JSX plugin's visitor for them is a no-op, so
 *   the next edit drops them.
 * - Content with no import visitor inside a JSX element or a table: their
 *   children are imported later, by nested editors, whose failures go to
 *   `console.error` and leave the element partly imported; editing it then
 *   writes the partial children back.
 * - JSX elements `unsupportedJsx` rejects, wherever it looks.
 *
 * It throws MDXEditor's own `UnrecognizedMarkdownConstructError`, one of the
 * two error classes its import catches and reports through `onError`; any other
 * error escapes the import and crashes the editor.
 */
const roundTripGuardPlugin = realmPlugin({
  init(realm) {
    const guard: MdastImportVisitor<MdastNode> = {
      priority: 100,
      testNode: (node) =>
        node.type === ESM_NODE_TYPE || node.type === 'table' || isMdastJsxNode(node),
      visitNode({ mdastNode, descriptors, actions }) {
        if (mdastNode.type === ESM_NODE_TYPE) {
          throw new UnrecognizedMarkdownConstructError(
            'import/export statements cannot be edited in the rich-text editor',
          )
        }
        const reject = (node: MdastNode) => {
          const reason = unsupportedJsx(node)
          if (reason !== null) {
            throw new UnrecognizedMarkdownConstructError(
              `${reason} cannot be edited in the rich-text editor`,
            )
          }
        }
        reject(mdastNode)
        const visitors = realm.getValue(importVisitors$).filter((visitor) => visitor !== guard)
        const hasVisitor = (node: MdastNode) =>
          visitors.some((visitor) =>
            typeof visitor.testNode === 'string'
              ? visitor.testNode === node.type
              : visitor.testNode(node, descriptors),
          )
        const check = (node: MdastNode) => {
          for (const child of childrenOf(node)) {
            reject(child)
            if (!CONSUMED_BY_PARENT_VISITOR.has(child.type) && !hasVisitor(child)) {
              const where = isMdastJsxNode(mdastNode) ? `<${mdastNode.name ?? ''}>` : 'A table'
              throw new UnrecognizedMarkdownConstructError(
                `${where} contains ${child.type} content the rich-text editor cannot edit`,
              )
            }
            check(child)
          }
        }
        check(mdastNode)
        actions.nextVisitor()
      },
    }
    realm.pub(addImportVisitor$, guard)
  },
})

/** The plugins that let MarkdownField's MDXEditor load and edit any JSX element. */
export function mdxJsxPlugins() {
  return [jsxPlugin({ jsxComponentDescriptors: [catchAllJsxDescriptor] }), roundTripGuardPlugin()]
}
