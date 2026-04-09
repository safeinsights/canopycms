# Schema-Based FAQ and Glossary Collections

## Problem

The docs-site-proto currently has FAQ items and glossary terms embedded directly in MDX content files. This works for single-page display but prevents reuse (e.g., surfacing relevant FAQs on topic pages, auto-linking glossary terms, or maintaining a single source of truth for definitions).

## Proposed Solution

Create dedicated content collections in the docs site with their own schemas:

### FAQ Collection (`content/faqs/`)

```ts
// In docs-site schemas.ts
export const faqSchema = defineEntrySchema([
  { name: 'question', type: 'string', label: 'Question', required: true },
  {
    name: 'tags',
    type: 'select',
    label: 'Tags',
    list: true,
    options: ['about', 'privacy', 'process', 'technical', 'help'],
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

- `listEntries` filtering by collection/content type — needed to query "all FAQ entries tagged 'privacy'" or "all glossary terms"
- Ability to render an entry's body inline within another page's MDX (embedding)
- Optionally: a remark/rehype plugin that auto-links glossary terms found in prose text to their definition pages or shows tooltips

## Current State

The docs site currently has:

- `<FAQ>` / `<FAQItem>` MDX components for accordion-style FAQs (support page)
- `<DefinitionList>` / `<Definition>` MDX components for styled glossary terms

These work well for visual display but don't support cross-page reuse. The schema collections would complement (not replace) these display components.

## Context

The schema definitions would live in the docs-site repo (`src/app/schemas.ts`), not in the canopycms repo. The Canopy work is around querying/filtering entries by collection for embedding purposes.
