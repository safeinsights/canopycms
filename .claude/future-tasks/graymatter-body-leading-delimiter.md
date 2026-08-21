# A body that starts with `---` loses that block on save

**Status:** Open. **Priority: P3.** Found 2026-08-21 by the independent review of
`fix/content-comment-preservation` (PR #254). **Pre-existing** — the data loss is not introduced
by that branch, which only changes what happens to the block's parsed keys.

## Problem

`gray-matter` decides where frontmatter ends by scanning for the closing delimiter, and
`matter.stringify(body, data)` re-parses the body string it is handed. So a body whose own text
begins with a `---` fenced block is read as frontmatter rather than as prose:

```
---
title: Real entry
---

---
sneaky: 1
---
real prose
```

Save that through the editor and the second `---…---` block is **removed from the body**. The
prose after it survives; the block does not. Nothing warns.

An editor can produce this by pasting a document that happens to start with a horizontal rule or
its own frontmatter, which is exactly what copying from another markdown file does.

## What the comment-preservation branch changed, and what it did not

Not the body loss — that is the same before and after. What changed is the fate of the block's
parsed **keys**:

- **Before:** `matter.stringify` did `data = Object.assign({}, file.data, data)`, so `sneaky: 1`
  was promoted into the entry's real frontmatter. Surprising, and it would then be reported by
  the new unknown-key scan as a stale key.
- **After:** `serializeFrontmatter`'s custom stringify engine builds the frontmatter from the
  payload only, so the keys are dropped rather than promoted.

Neither is right. Promoting body text into frontmatter is arguably the worse of the two, which is
why the branch was not changed to reproduce it. But note the branch's reconcile path and its own
fallback path (new file / unparseable / no frontmatter) now disagree on this one input, since the
fallback still goes through plain `matter.stringify`.

## Suggested fix

Decide the behaviour once and apply it on both paths. Options, roughly in order of preference:

1. **Refuse and report.** Detect a body whose first non-whitespace line is the delimiter and
   return a `level: 'error'` validation issue from the write boundary, so the editor says "a body
   cannot start with `---`" instead of silently eating it. Costs a rule editors must learn, but it
   is the only option with no silent loss.
2. **Escape on write.** Prefix the offending line so gray-matter cannot claim it, and unescape on
   read. Round-trips invisibly; adds an encoding layer to content files, which is exactly the kind
   of thing that later reads as corruption to anyone editing the file by hand.
3. **Stop using gray-matter for assembly** and write the delimiters directly, computing the body
   boundary ourselves. Largest change; removes the class of problem rather than one instance.

Whatever is chosen, make the fallback path agree with the reconcile path.

## Verification

Round-trip an entry whose body begins with a `---` block through `ContentStore.write` and assert
the body is intact (or the save was refused with a clear message). Cover both the
comment-preserving path and the fallback path — they currently differ.
