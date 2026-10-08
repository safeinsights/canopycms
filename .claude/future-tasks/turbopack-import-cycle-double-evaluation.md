# Report Turbopack's double evaluation of an import cycle entered mid-cycle

## Priority: P3 [BOTH]

## What happened

An adopter's Next 16.1.7 Turbopack production build of the editor crashed on the first
`MarkdownField` mount whenever a body held a JSX element. The errors were
`no lexical visitor found for jsx`, then `useNestedEditor must be used within a NestedEditorsProvider`.

MDXEditor 3.55.0's jsx plugin is an import cycle:
`plugins/jsx/index.js` → `LexicalJsxVisitor.js` → `./index.js`. Turbopack scope-hoisted the
cycle's members, among them `LexicalJsxNode`, `LexicalJsxVisitor`, the mdast visitors and
`core/NestedLexicalEditor`, into one factory registered under nine module ids. It left
`jsx/index.js` outside. The runtime caches per id. `mdx-jsx-support` imported `NestedLexicalEditor`
by name, which Turbopack resolved to one of the nine ids. When that module evaluated before the
package entry, the merged factory started, required `jsx/index.js`, and `jsx/index.js` required
another of the nine ids before the first run had registered it, so the factory ran again. The
page was left with two `LexicalJsxNode` classes and two nested-editor contexts. A live probe
that counted factory calls per id showed it.

The same build is fine when the package entry evaluates first, and a smaller app's graph never
formed the merged group. That is why only one adopter hit it, and only intermittently, except on
an in-app navigation to the page's first markdown body.

## Done in canopycms

`mdx-jsx-support` takes MDXEditor from `MarkdownField`'s import of the package entry and imports
only types. The `mdxeditor-entered-only-by-markdown-field` dependency-cruiser rule keeps every other
module from importing MDXEditor's runtime.

## Left

Build a minimal repro: a package whose two modules import each other, merged by scope hoisting,
plus an importer that names a member module first. Report it to vercel/next.js. Retire the
dependency-cruiser rule only once a fixed Turbopack is the floor every adopter builds with.
