---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-10, parked by the editor UI/UX epic. The media library gets server-side search, sort, a kind filter, and "used in N entries" in the epic; organising hundreds of assets into folders or tags needs a storage-model change and is deferred until search plus usage proves insufficient
---
# Media library: folders or tags

The epic ([ui-epic-202610.md](ui-epic-202610.md), section G, WS7a) makes a large library
searchable and shows where each asset is used. Folders or tags were deferred because:

- assets are content-addressed, with no hierarchy, so folders would be a metadata overlay
  stored per asset, and branch-aware like every other edit;
- tags have the same storage question, plus a UI for managing the tag vocabulary.

Revisit when an adopter with a large library reports that search and the usage filter don't
find things.
