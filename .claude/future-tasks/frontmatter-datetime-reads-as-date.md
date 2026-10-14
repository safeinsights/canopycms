---
priority: P3
adopters: BOTH
summary: >-
  A `datetime` value the editor saves into markdown frontmatter is written unquoted, so a server-side read (gray-matter) hands adopters a JS `Date` although the field's type is a string; a `stampOnPublish` stamp is quoted and reads as a string. Decide one shape (quote datetimes, or normalize Dates on read) and fix the comment in `static/index.ts` that says CMS-authored entries round-trip as quoted strings
---
# Frontmatter datetimes read back as `Date` objects

## Priority: P3 [BOTH]

## Problem

`serializeFrontmatter` quotes a value only when gray-matter would read it as something the API
would not carry as the same text (`readsAsAnotherValue`, `utils/content-serialize.ts`). An ISO
timestamp from the editor's date field reads as a `Date`, which JSON carries as the same text, so
it stays plain. Over HTTP nothing changes, but a server-side read of an MD/MDX entry
(`ContentStore.read`, listings, build reads) gives adopter code a `Date` where `datetime`'s type
says string. `static/index.ts` normalizes Dates only inside its build guard, and its comment
("CMS-authored entries round-trip as quoted strings") is wrong for timestamps.

A `stampOnPublish` stamp is written quoted on purpose, so for the same field an adopter can get a
string or a `Date` depending on who set it. YAML and JSON entries are not affected the same way
(check YAML).

## Fix options

- Quote ISO timestamps for `datetime` fields on save (byte-stable for existing plain values only if
  left untouched when unchanged), or
- normalize `Date` to ISO string on every server-side read of frontmatter, the way the build guard
  already does (`normalizeDatesDeep`), so adopters always get the declared type.

Either way, correct the `static/index.ts` comment.

## Trigger

An adopter compares or formats a `datetime` and trips over the two shapes, or the next change to
frontmatter serialization.
