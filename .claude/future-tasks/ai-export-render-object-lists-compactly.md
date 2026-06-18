# Render array-of-object fields compactly in AI export (not nested ordinal headings)

## Status: SHIPPED

Implemented in `packages/canopycms/src/ai/json-to-markdown.ts` (`renderListField` + `isFlatObjectList`
/ `renderObjectListTable`). Decisions made during implementation:

- **Table is the default**, not gated behind a config flag (strictly more readable; `/ai/` files
  regenerate each build). No `.changeset` workflow in this repo, so no changeset entry.
- **No content-length heuristic** — a flat-object list always renders as a table, deterministically.
  The schema-driven predicate `isFlatObjectList` qualifies an `object` list field only when every
  subfield is a single-line scalar (string/number/boolean/datetime/select/reference/image), has no
  `list: true`, and is not itself an object/block/markdown/mdx/rich-text/code. Anything else keeps the
  heading-per-item fallback (e.g. `dataset.tables[].columns[]`).
- Columns are the subfields in schema order; absent values are empty cells; pipes are escaped (`\|`)
  and newlines collapsed to spaces. `fieldTransforms` still wins over the default for any field.

The list-form alternative for description-heavy records (e.g. `resources: [{title, description}]`) was
deliberately deferred to a possible future **explicit per-field hint** rather than a fuzzy heuristic.

## Summary

The AI exporter's generic schema-driven serializer renders an **array-of-objects** field as deeply
nested, one-datum-per-heading markdown: a `### <FieldLabel> N` heading per item, then a `#### <subfield>`
heading per key, then the value on its own line. For a list of flat records this is verbose, hard to
scan, token-heavy, and the `### … 1 / ### … 2` ordinals carry no information.

Render arrays of **flat** objects as a markdown **table** (or a compact `- **key:** value` list)
instead.

## Motivation

In docs-site-proto's `/ai/` output this pattern hits at least six field types across entry types
(occurrence counts from one partner's catalog):

```
84 × ### Key Features      (partner.keyFeatures)
64 × ### Query functions   (dataset.queryFunctions)
54 × ### Quick Facts       (partner.quickFacts)
42 × ### Getting Started
33 × ### Education Levels
21 × ### Resources          (partner/source.resources)
```

Current output (a `quickFacts: [{label, value}]` field):

```
## Quick Facts

### Quick Facts 1

#### Label

Students

#### Value

~10,000

### Quick Facts 2

#### Label

Time span

#### Value

Spring 2051 – Spring 2053
```

Desired (table — or the `- **Students:** ~10,000` list form):

```
## Quick Facts

| Label | Value |
| --- | --- |
| Students | ~10,000 |
| Time span | Spring 2051 – Spring 2053 |
```

For a `resources: [{title, description, link, buttonText}]` list, a link-oriented list reads best:

```
- [Querying Mars Data in R](/data-catalog/mars-university/research-tools/r-guide/) — How to query Mars tables in R inside the enclave.
```

An AI (and a human) can scan a table/list in one pass; the nested-heading form forces a scroll per
record and buries the values.

## Where

The list rendering lives in the schema-driven path in `packages/canopycms/src/ai/json-to-markdown.ts`
(`renderJsonEntry` / the nested field renderer). This is the same code that motivated docs-site-proto to
write a `fieldTransforms.dataset.tables` override — a better default would remove the need for those
per-field workarounds.

## Proposed shape (Canopy's call on the mechanics)

- When a field value is an array whose items are objects with **scalar leaves only** (string / number /
  boolean), render a markdown table: columns = the union of the items' keys in schema order, one row per
  item, cells escaped (pipes, newlines). Empty cells for absent keys.
- Items with a long free-text field (e.g. `description`) may read better as a `- **<title>** — <text>`
  list than a wide table; a heuristic (e.g. "any value > ~60 chars or contains a newline → list form")
  or a small per-field hint could choose. A plain table is an acceptable general default.
- **Keep the nested-heading fallback for arrays whose items themselves contain nested arrays/objects**
  (e.g. `dataset.tables[].columns[]` — genuinely 2-level; that one stays an adopter concern / custom
  transform). The win here is specifically the common *flat* list-of-records case.

## Considerations

- This changes existing adopters' AI output format. Likely fine (it's strictly more readable and these
  files are regenerated each build), but worth a changeset note; or gate behind a config flag if a
  conservative default is preferred. Snapshot/golden tests will need updating.
- Complements the per-field `fieldTransforms` (still useful for domain-specific rendering like the
  dataset schema table); this just makes the *default* good so adopters don't reach for a transform for
  every list field.

## Requested By

docs-site-proto — same `/ai/` quality pass that produced the `entryTransforms`/`readSibling` work
(`ai-export-sibling-profile-merge.md`). Reviewing the generated markdown as an AI consumer, the nested
ordinal-heading lists were the most-repeated friction after the column schema itself.
