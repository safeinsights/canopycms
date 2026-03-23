# Content Store Schema Validation

Enforce schema validation at the API boundary for content write/create operations.

## Problem

ContentStore currently accepts any data without validating it against the entry schema. Multiple TODOs in integration tests confirm this:

- `__integration__/errors/invalid-content.test.ts:52` — "Once schema validation is enforced, this should be 400"
- `__integration__/errors/invalid-content.test.ts:94` — "Once validation is enforced, this should be 400"
- `__integration__/errors/invalid-content.test.ts:187` — "Once format validation is enforced, this should be 400"
- `__integration__/errors/invalid-content.test.ts:234` — "Once type validation is enforced, this should be 400"

## Recommended approach

Validate at the API boundary (in `src/api/content.ts` write handler and `src/api/entries.ts` create handler), NOT deep in ContentStore. This keeps ContentStore as a simple read/write layer and puts validation where input enters the system.

1. After resolving the entry type from the schema, validate `body.data` against the entry type's field definitions
2. Use the existing field traversal utilities in `src/validation/field-traversal.ts`
3. Return 400 with structured validation errors on failure
4. Update the integration test TODOs to expect 400 responses

## Files

- `src/api/content.ts` — writeContentHandler
- `src/api/entries.ts` — create entry handler (if exists)
- `src/validation/` — existing field traversal and reference validation utilities
- `src/__integration__/errors/invalid-content.test.ts` — tests to update
