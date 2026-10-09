---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-08. Turbopack scope-hoisted MDXEditor's jsx-plugin import cycle into a multi-id factory and evaluated it twice when canopycms entered it by a member id first, crashing the editor. Fixed here by routing MDXEditor through MarkdownField; build a minimal repro and report it upstream
---
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
package entry, the merged factory started, registered four of its ids, then required
`jsx/index.js`. `jsx/index.js` required a fifth id, `MdastMdxJsEsmVisitor`'s, which the first
run had not registered yet, so the factory ran again. The
page was left with two `LexicalJsxNode` classes and two nested-editor contexts. A live probe
that counted factory calls per id showed it.

Through the package entry the cycle is reached at `jsx/index.js` first: `dist/index.js` imports
it at line 17 and `NestedLexicalEditor` at line 55, so the group is evaluated once. A smaller
app's graph never formed the merged group. That is why only one adopter hit it, and only intermittently, except on
an in-app navigation to the page's first markdown body.

## Done in canopycms

`mdx-jsx-support` takes MDXEditor from `MarkdownField`'s import of the package entry and imports
only types. ESLint's `no-restricted-imports` forbids a static value import of the package in any
file, and the `mdxeditor-entered-only-by-markdown-field` dependency-cruiser rule also catches a
dynamic import outside `MarkdownField`.

MDXEditor 4.3.2 keeps the cycle (`plugins/jsx/LexicalJsxVisitor.js` still imports `./index.js`),
and its `dist/index.js` still reaches `jsx/index.js` (line 17) before `NestedLexicalEditor` (line
51), so the workaround and both rules still apply; both pass on 4.3.2.

## Left

Build a minimal repro: a package whose two modules import each other, merged by scope hoisting,
plus an importer that names a member module first. Report it to vercel/next.js. Retire the
two lint rules only once a fixed Turbopack is the floor every adopter builds with.
