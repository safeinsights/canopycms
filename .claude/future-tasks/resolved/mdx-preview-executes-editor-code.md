---
summary: >-
  RESOLVED 2026-10-09, fix/mdx-preview-trust-model. JP chose a save-time policy, secure by default.
  An `mdx` field and the body of an `mdx` entry refuse anything that runs code as it renders:
  `{…}` expressions other than comments and literals, `import`/`export`, HTML tags and tag attributes
  outside a safe set, event-handler, `srcdoc` and `dangerouslySetInnerHTML` attributes, and unsafe URL schemes.
  `markdown` fields and `md` bodies have their URLs checked. A field opts out with
  `executable: true`. The API enforces it at the write boundary. Code the stored entry already
  held is kept with a warning in a field saved unchanged, and a production build lists every
  entry holding some. The README states the trust model. The non-executing renderer is deferred to
  [mdx-non-executing-preview-renderer.md](../mdx-non-executing-preview-renderer.md)
---
# MDX bodies are code: rendering a draft in the preview runs an editor's JavaScript

## Status: RESOLVED 2026-10-09: a save-time policy (`validation/markdown-safety.ts`)

## Priority: P1 [MKT]

Filed 2026-10-05, out of scope for the `previewView` loader PR (`feat/preview-page-loader`).

## The problem

MDX compiles `{expressions}` and `import`/`export` into JavaScript. A preview view that renders
a draft MDX body with `@mdx-js/mdx`'s `evaluate` (or `run` on `compile` output) executes whatever
the editor typed. The preview route is served from the CMS build, on the same origin as `/edit`
and the catch-all API, so that code runs with the session of whoever opens the preview.

An editor whose path rules limit them to one tree can write
`{fetch('/api/canopycms/…', { method: 'POST', … })}` into a post body. When an admin opens that
branch, the iframe makes admin-authorized calls. A server-side render of draft MDX on the CMS
Lambda is worse: the same expression runs in the server process.

The marketing site's log (item 67) plans exactly this for its article and case-study bodies.
The README's "Reporting draft errors" example compiles a draft body, and it does not say that
rendering the compiled output executes it.

## Proposed solution

1. Decide the trust model and say it in the README: either an MDX-body field makes every editor
   of it a code author (equivalent to repo write access), or CanopyCMS supports MDX previews only
   through a renderer that does not execute expressions.
2. Recommend a non-executing preview path, for example rendering the body as Markdown plus a fixed
   allowlist of components (`react-markdown` + `rehype-react`, or an MDX AST walk that maps known
   JSX elements and rejects expressions and ESM). Check that the draft-error example in the
   README does not imply `run`.
3. Consider rejecting `{expressions}` and ESM in MDX fields at save time, as a schema option.
4. Tell the marketing site before it ships an `evaluate`-based preview.

## Related

- [preview-page-followups.md](../preview-page-followups.md): item 4, the loader's raw `services`.
- [mdx-registered-components.md](../mdx-registered-components.md): an adopter component registry for
  the editor, deferred to be designed with this task; its list would be the allowlist in item 2.
