---
priority: P3
adopters: KB
summary: >-
  First-class FAQ and glossary content types for reuse across pages. Mostly an adopter's content modelling; the file **undersells what already works** — `listEntries`' filter/extract callbacks already receive `item.data`, so tag-filtered FAQ queries need no new Canopy code. Only cross-page embedding and glossary auto-linking are real package gaps
---
# Schema-Based FAQ and Glossary Collections

## Problem

An adopter's FAQ items and glossary terms can end up embedded directly in MDX content files. This works for single-page display but prevents reuse (e.g., surfacing relevant FAQs on topic pages, auto-linking glossary terms, or maintaining a single source of truth for definitions).

## Proposed Solution

Make FAQ and glossary first-class content types: dedicated collections with their own entry schemas, which an adopter defines with `defineEntrySchema`.

### FAQ Collection (`content/faqs/`)

```ts
export const faqSchema = defineEntrySchema([
  { name: 'question', type: 'string', label: 'Question', required: true },
  {
    name: 'tags',
    type: 'select',
    label: 'Tags',
    list: true,
    options: ['general', 'billing', 'setup', 'troubleshooting'],
  },
  // body (auto-injected) contains the answer as MDX
])
```

### Glossary Collection (`content/terms/`)

```ts
export const termSchema = defineEntrySchema([
  { name: 'term', type: 'string', label: 'Term', required: true },
  { name: 'aliases', type: 'string', label: 'Aliases', list: true }, // for auto-linking variants
  // body (auto-injected) contains the definition as MDX
])
```

## Canopy API Needs

- `listEntries` filtering by collection/content type — needed to query "all FAQ entries tagged 'billing'" or "all glossary terms"
- Ability to render an entry's body inline within another page's MDX (embedding)
- Optionally: a remark/rehype plugin that auto-links glossary terms found in prose text to their definition pages or shows tooltips

## Current State

An adopter can already show FAQs and glossary terms with MDX components (accordion-style FAQ items, styled definition lists). These work well for visual display but don't support cross-page reuse. The schema collections would complement (not replace) such display components.

## Context

The schema definitions would live in the adopter's own repo, not in the canopycms repo. The Canopy work is around querying/filtering entries by collection for embedding purposes.
