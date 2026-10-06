'use client'

/**
 * MarkdownField's MDXEditor plugins: a catch-all JSX editor, and a guard that
 * turns what MDXEditor would lose without an error into `onError`. Imported only
 * from MarkdownField's lazy loader, keeping MDXEditor out of the first chunk.
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

function describeAttribute(attribute: MdastJsx['attributes'][number]): string {
  if (attribute.type === 'mdxJsxExpressionAttribute') return '{…}'
  if (attribute.value === null || attribute.value === undefined) return attribute.name
  if (typeof attribute.value === 'string') return `${attribute.name}="${attribute.value}"`
  return `${attribute.name}={…}`
}

/**
 * Shows an element's tag and attributes read-only (they are edited as source)
 * and edits its children, inline or block per the parsed node: one `*`
 * descriptor serves both, and a block editor rejects inline children.
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

// MDXEditor's export merges an HTML element's lone `span` child into it, and
// throws if either one's `className` or `style` is not a string.
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
 * MDXEditor's image plugin drops an `<img>` with no `src`, keeps only string
 * values, lowercases the attribute names it does not model, and parses width
 * and height as integers.
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

// Why MDXEditor cannot round-trip this JSX element, or null if it can. A
// fragment has no name, which MDXEditor's HTML handling throws on.
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
 * Reports through `onError`, at import, what MDXEditor would otherwise lose
 * silently: `import`/`export` lines (its visitor for them is a no-op), elements
 * `unsupportedJsx` rejects, and content with no visitor inside a JSX element or
 * table, whose children nested editors import later, only logging a failure and
 * writing partial children back on edit. It throws an error class MDXEditor's
 * import reports; any other error would crash the editor.
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

export function mdxJsxPlugins() {
  return [jsxPlugin({ jsxComponentDescriptors: [catchAllJsxDescriptor] }), roundTripGuardPlugin()]
}
