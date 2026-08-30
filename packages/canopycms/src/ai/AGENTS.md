# `ai/` — AI-ready content

Markdown conversion, the generation engine, and the route handler.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
172 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

AI-ready content generation (markdown converter, engine, route handler); transforms (field/component/body) + entry transforms with traversal-guarded `readSibling` for folding in colocated sibling artifacts

`to-plain-text.ts`'s `toPlainText` (exported from `canopycms/ai`) is a _different_ transform from `strip-mdx.ts`'s `stripMdxImports` (which it uses internally as one pipeline step) — it strips ALL markup down to prose for a search index, rather than preserving JSX for AI/RAG consumption, and specifically keeps a paired custom component's inner text while dropping only its tags. `toPlainText` also strips HTML/MDX comments and their contents (`TAG_RE` cannot — its tag-name group is `[A-Za-z]`-initial, so `<!--` matched nothing and authoring notes reached search indexes verbatim); that strip is an `indexOf` scan, NOT a lazy `<!--[\s\S]*?-->`, which would reintroduce the same polynomial-ReDoS shape `TAG_RE` and the fence scanner are hand-rolled to avoid, and an unterminated `<!--` is deliberately left as literal text rather than swallowing the rest of the document. `json-to-markdown.ts` emits Prettier-stable markdown (`_…_` emphasis, no bare `key: ` with a trailing space), so a regenerated bundle stays diff-free under an adopter's own formatting pass

`generateAIContent` is shared by the runtime route handler and the static build, so it takes its
manifest stamp (`generatedAt`, `buildId`) as ARGUMENTS and reads no environment itself: **the
build path stamps, the handler clocks.** A live timestamp is right when serving a response on
demand and wrong when baked into an artifact that gets promoted months later, and only the caller
knows which it is. `AIManifest.generated` is therefore optional — supplying a `buildId` with no
`generatedAt` omits it rather than recording a date the artifact cannot support.
