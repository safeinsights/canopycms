# Partner data entries co-located with their content collections

## Problem

We have partner data (structured YAML entries with a `partnerSchema`) that needs to:

1. **Live inside each partner's collection directory** for permissions and co-location. Each partner has a collection under `data-catalog/` (e.g., `content/data-catalog/openstax/`, `content/data-catalog/assistments/`). The partner YAML should be the index entry of that collection so it appears in the sidebar as "Overview" and is editable by people with access to that collection.

2. **Be referenced from other pages**. The home page and data catalog index page both display partner cards. Currently they use a `reference` field (`type: 'reference', collections: ['partners'], list: true, resolvedSchema: partnerSchema`) that points to a dedicated `content/partners/` collection. When read via `readByUrlPath`, Canopy auto-resolves these references to full partner objects.

## The tension

If we move partner YAML entries from `content/partners/` into each partner's sub-collection under `content/data-catalog/`, the `reference` field can no longer point to a single `partners` collection. The partner entries would be spread across 7 different sub-collections (`data-catalog/openstax`, `data-catalog/assistments`, etc.).

Canopy's `reference` field takes `collections: ['collectionName']` — it references entries within named collections. If partners are in sub-collections, we'd need either:

- A way to reference entries by `entryType` across multiple collections
- A way to reference entries from nested sub-collections
- Some other mechanism to aggregate entries of a given type regardless of where they live

## What we're trying to achieve

- Partner YAML data is the single source of truth for partner information (name, description, products, datasets, education levels, etc.)
- The partner YAML lives in the partner's own collection directory (for permissions, co-location, and nav)
- The home page and data catalog index can reference all partners and get the full resolved data
- Live preview works for all of these pages
- Adding a new partner means creating one YAML file in one place, and it shows up everywhere

## Current setup

- `content/partners.{id}/` — dedicated collection with 7 `partner.{slug}.{id}.yaml` files
- `content/data-catalog.{id}/` — has sub-collections for each partner (openstax, assistments, etc.) containing MDX doc pages
- Home page schema: `{ name: 'partners', type: 'reference', collections: ['partners'], list: true, resolvedSchema: partnerSchema }`
- Home page YAML: `partners: [contentId1, contentId2, ...]`
- `readByUrlPath('/')` returns the home entry with partners auto-resolved to full objects

## Desired end state

- Partner YAML lives at `content/data-catalog/{partner}/partner.index.{id}.yaml`
- It's the index entry for the partner collection, with `navText: Overview` in the sidebar
- The home page and data catalog index still reference all partners and get resolved data
- The `content/partners/` collection is eliminated
