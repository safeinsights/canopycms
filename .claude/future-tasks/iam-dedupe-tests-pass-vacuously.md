# The IAM-dedupe tests in `cms-deploy.test.ts` cannot fail

**Priority:** P3
**Found:** 2026-09-12, by break-and-rerun while adding the GitHub App private-key ARN to
the same IAM union (PR B3 of adopter request #45)

## What

`CanopyCmsService` builds its `secretsmanager:GetSecretValue` grant as
`[...new Set([...])]` (`packages/canopycms-cdk/src/constructs/cms-service.ts`), and
`cms-deploy.test.ts`'s "does not list an ARN twice when it is passed both ways" reads as
though it pins that dedupe. It does not.

**Measured:** deleting the `new Set` entirely — so the array genuinely carries the ARN
twice — leaves the whole 480-test suite green. `aws-cdk-lib` 2.265's `PolicyStatement`
collapses a repeated `resources` entry itself; a probe passing `resources: [ARN, ARN]`
renders exactly one `Resource`.

So the construct's own dedupe is invisible in the emitted template, and that test has been
passing for reasons unrelated to the code it names.

## What was already done in B3

The construct's comment claimed the dedupe was what prevented double-listing; it now says
plainly that removing it changes no output and breaks no test. The new sibling test added
for the App private-key ARN ("grants the App private-key ARN exactly once when it is passed
in secretsArns too") was reworded to say it pins that the ARN is granted by ONE statement
rather than by a second `addToPolicy` call.

**That rewording was itself wrong, and is corrected (2026-09-13).** The worker-credential
epic's review swept for this shape and found the sibling test vacuous too, by a second
mechanism: `PolicyDocument` drops a statement that renders byte-identical to another. With
`secretsArns: [APP_KEY_ARN]` alone, a stray single-ARN grant rendered exactly like the union
and was collapsed, so the test stayed green with that bug reintroduced. Re-measured: adding
that second `addToPolicy` to `cms-service.ts` left it green. The test now adds an unrelated
ARN to `secretsArns`, so the union lists two ARNs and a stray single-ARN grant renders as a
distinct statement. The same mutation now turns it red, and it is green again on the real
code.

## What is left

The pre-existing "does not list an ARN twice when it is passed both ways" test was left
alone to keep that PR's diff focused. It should get the same treatment: either reword it to
the one-statement property, or delete it as a test that cannot go red. Worth a quick sweep
for the same shape elsewhere — an assertion whose subject is a property the framework
guarantees, not the code under test.
