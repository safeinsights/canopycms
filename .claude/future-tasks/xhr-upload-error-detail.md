# A failed direct upload reports a status code and nothing else

**Status:** Open. **Priority: P3.** Filed 2026-09-10 alongside the change that added
`media.uploadUrl` (adopter request #44).

## Problem

`editor/media/xhr-upload.ts` rejects with `Upload failed (HTTP ${xhr.status})` and deliberately
does not parse the response: *"S3 error bodies are XML and not parsed here - the status code is
enough to surface a 'something went wrong' message."*

That reasoning was sound when the POST went straight to S3. It is weaker now that `uploadUrl`
can route the upload through a CDN, for a reason the first adopter measured: **CloudFront's
`CustomErrorResponses` are distribution-wide**, so a site that maps 403 to its own 404 page has
that mapping applied to S3's upload errors too. An origin 403 came back as the site's error page
with status 404; an origin 400 passed through untouched. Uploads themselves are unaffected (204
is not rewritten), but the editor then reports a status that never came from S3 — so the one
signal the message carries can be the wrong one.

The underlying S3 errors are specific and actionable, and they are the ones an adopter hits
while wiring this up: `Policy Condition failed`, `SignatureDoesNotMatch`, `InvalidArgument —
Bucket POST must contain a field named 'key'` (field order), `InvalidArgument — Unsupported
Authorization Type` (a forwarded basic-auth header).

## Fix sketch

Include a bounded slice of `xhr.responseText` in the rejection when present. S3's XML carries
`<Code>` and `<Message>`; a small regex or `DOMParser` extraction is enough and needs no
dependency. Two things to be careful about: the body may be an adopter's HTML error page rather
than S3 XML (so do not assume a shape, and truncate), and the message reaches the editor UI, so
it must not leak signed URLs or credentials — the response body should not contain any, but
check rather than assume.

## Why it was not done in the same change

Changing adopter-visible error text is its own decision, and doing it needed thought about XML
parsing in a client bundle that the config change did not.

**Cheaper now than before**, though: `editor/media/xhr-upload.test.ts` now exists (it did not
when this was filed as an idea) and pins the current message and the 2xx boundary, so a change
here starts with a test that will notice.

## Related

- [asset-review-followups.md](asset-review-followups.md) holds the sibling item: `xhr-upload.ts`
  takes no `AbortSignal`, so an upload cannot be cancelled.
- [asset-support-upload-behavior.md](asset-support-upload-behavior.md) — the CDN wiring whose
  failures this message has to describe.
