---
priority: P3
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09, branch `fix/dangling-reference-integrity`. `ReferenceField` adds an option for each set value the list omits, labelled "Restricted entry: <title>", "Missing entry (<id>)" or "Unavailable entry (<id>)". Mantine 7.17's `MultiSelect` already kept an unknown id when another pill was removed; `Select` showed it as empty
---
# The reference picker shows nothing for a value it does not offer

## Priority: P3 [BOTH] — reasoned from code, not reproduced

Noticed 2026-10-05 while fixing reference ACLs (`fix/reference-resolution-acl`).

`editor/fields/ReferenceField.tsx` renders a Mantine `Select`/`MultiSelect` whose `data` is the
options list from `/reference-options`. That list omits entries the user may not read (filtered
before read, by design, so their titles do not leak). A stored value pointing at such an entry,
or at a deleted one, therefore has no option, and the picker shows an empty field for a reference
that is in fact set. An editor who sees "empty" may pick something else and silently repoint it.

Pre-existing: options were filtered this way before the ACL fix. The fix made the value itself
renderable (a denied target resolves to `RestrictedReference`, with `id`, `title` and
`unavailable: true`), so the form now has what it needs to show the value honestly.

## Fix direction

When the current value has no matching option, render it as a disabled option or a badge:
"Restricted entry: <title>" when the form value is a `RestrictedReference`, "Missing entry" for an
id that resolves to nothing. Check first what Mantine actually renders for an unknown value, and
whether `MultiSelect` keeps unknown ids when another pill is removed.

## Related

- [reference-resolution-bypasses-path-acls.md](reference-resolution-bypasses-path-acls.md)
- [dangling-reference-null-overwrites-id.md](dangling-reference-null-overwrites-id.md)
