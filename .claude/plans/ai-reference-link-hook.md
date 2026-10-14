# Design: `AIContentConfig.referenceLink` (adopter request 112)

An adopter needs the AI export to stop linking a reference target that has no page (a `person`
with an empty bio body), the way their sitemap `exclude` already does. This note settles the API
before implementation.

## Signature

```ts
// ai/types.ts, exported from `canopycms/ai` beside the other transform types
export interface AIReferenceLinkContext {
  /** The target's MD/MDX body as stored; `undefined` for a data-only (JSON/YAML) entry. */
  body: string | undefined
  /** The URL the export links by default: `entryLinkUrl`'s result when set, else `urlPath`. */
  defaultUrl: string
}

export type AIReferenceLinkFn = (
  target: AIResolvedReference,
  context: AIReferenceLinkContext,
) => string | false | undefined | Promise<string | false | undefined>

interface AIContentConfig {
  // ...
  referenceLink?: AIReferenceLinkFn
}
```

- **string**: link here instead of `defaultUrl`.
- **`false`**: no page. The title renders as plain text with no link at all.
- **`undefined`**: keep `defaultUrl`.

`target` is the same `AIResolvedReference` that `fieldTransforms` already receive: the target's
front-matter data, with its own reference fields as bare ids, plus `id`, `slug`, `collection`
(logical path) and `urlPath`. It is a fresh copy for each call, so mutating it changes nothing.

The adopter's rule becomes `(target, { body }) => (hasProse(body) ? undefined : false)`, the same
predicate their sitemap `exclude` runs against `entry.data.body`.

## Body access: a second context argument, filled from memory

Every target the callback can see is an exported entry (see "Masked targets" below). The export
has already read every exported entry in full during its first pass, so `PendingEntry.body`
already holds the stored body. The context passes that string. This needs no extra read, no lazy
`readBody()`, and no new memo of file contents.

The body never enters an `AIReferenceValue`. It reaches only the callback, whose only output is a
URL string or `false`. `resolveReferenceTarget` still embeds no body, so `fieldTransforms`,
`entryTransforms` and the renderer see exactly what they see today.

## Sync or async: both, decided once per target before rendering

The decision is made in an async pre-pass in `generateAIContent`. It runs after the export set
settles (every entry read and filtered) and before the first render round. The pre-pass collects
every distinct id that some exported entry references, or links from its body with `entry:`, and
that is itself in the export set. It calls the callback once per id, sequentially, and awaits the
result. Results go in a `Map<contentId, string | false | undefined>` created inside that
`generateAIContent` call and dropped when it returns. That is the call-scoped memo
`docs/concurrency.md` describes: it is keyed by content id and never hoisted or reused.

Because of this:

- an `async` callback costs nothing extra, so the type allows a Promise, as `EntryTransformFn`
  does;
- the renderer (`formatReference`) and the body-link resolver stay synchronous, and only look up
  the Map;
- each target gets one answer per run, so every reference and every body link to it agrees,
  across every file, `all.md` and bundle.

When `referenceLink` is unset, the pre-pass is skipped and the output stays byte-identical to
today's.

## Body `entry:` links: same callback

References and body links keep agreeing, as `references.ts` already promises. In the render
rounds, `resolveEntryLinksInText` receives:

- `isLinkable: (id) => exported.has(id) && decision(id) !== false`. A `false` target therefore
  takes the existing withheld-target path: `[text](entry:ID)` becomes its bare text, and any other
  form becomes `#`. These are the same rules as for an excluded target.
- a `customResolver` that returns the string override when there is one, else `entryLinkUrl`, else
  `computeEntryUrl`. An `#anchor` is appended as today.

The first-pass resolution that `exclude.where` sees does not consult the callback, because the
export set is not settled at that point.

## The ` ([markdown version](...))` suffix

| return      | page link          | markdown-version suffix |
| ----------- | ------------------ | ----------------------- |
| `undefined` | `defaultUrl`       | kept                    |
| string      | the string         | kept                    |
| `false`     | none (plain title) | **dropped**             |

`false` means "do not advertise this target as a page". Keeping a "markdown version" link would
label a copy of a page that does not exist, and for a noindex or unpublished target it would still
advertise it. An adopter who wants the target's data out entirely already has `exclude`.
`ReferenceRendering.url` widens to `string | false | undefined`. `false` drops both links, while
`undefined` keeps today's meaning: no page URL, but the suffix stays when the export holds a copy.

## Edge cases

- **Masked targets never reach the callback.** The pre-pass considers only ids in the export set.
  Targets excluded by `exclude.*`, left out by `noindex`, and missing ids (`MissingReference`) are
  never passed. A restricted reference cannot arise here, because the AI export resolves without
  an ACL, and `formatReference` returns before `url()` for any `unavailable` value anyway. A target
  whose own render later fails is masked in the next round as it is today. Its decision goes
  unused, so nothing from it reaches the output.
- **`entryLinkUrl`.** This is unchanged and still site-wide. The callback sees its result as
  `defaultUrl`. `referenceLink` is AI-export-only and never touches the editor.
- **Throws, or returns anything but a non-empty string, `false` or `undefined`** (for example an
  empty string or a number). The export logs a `console.warn` naming the target id and treats the
  return as `false`. It fails closed because the hook exists to stop advertising pages that do not
  exist, and falling back to the default link would re-advertise exactly that. A bad return
  doesn't fail the whole run: other config errors (`entryTransforms`, a field render) also degrade
  per entry.
- **Override URL encoding** follows the existing rule for each surface. For references it goes
  through `encodeMarkdownLinkDestination`. For body links it is substituted raw, as `entryLinkUrl`
  is today.
- **`fieldTransforms`** that render a reference field themselves bypass the hook. Such a transform
  already owns that field's whole output. The README will say so.

## Files

- `ai/types.ts`: the two types and `AIContentConfig.referenceLink`.
- `ai/index.ts`: export `AIReferenceLinkFn` and `AIReferenceLinkContext`. This adds no new
  entrypoint.
- `ai/references.ts`: `createReferenceLinks()` (the pre-pass and Map, plus the id collection over
  `referenceSlots` and `extractEntryLinkIds`). `createReferenceRendering` takes its lookup.
- `ai/json-to-markdown.ts`: `ReferenceRendering.url` may return `false`, and `formatReference`
  drops both links on it.
- `ai/generate.ts`: run the pre-pass and wire `isLinkable` / `customResolver`.
- Tests: `ai/__tests__/reference-link.integration.test.ts` (string, `false` plus the suffix,
  `undefined`, a body-based predicate, body `entry:` links, masked targets never seen, throw and
  bad return failing closed, async), plus a `json-to-markdown.test.ts` case for `url() === false`.
- `README.md` (the AI Content Configuration example plus one paragraph), `ai/AGENTS.md` (one
  line), `.changeset/ai-reference-link-hook.md` (minor).
