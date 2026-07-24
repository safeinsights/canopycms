# Worker log lines carry no real timestamps in CloudWatch

Found while implementing worker CloudWatch log shipping
([[worker-cloudwatch-logs]], 2026-07-24).

## Problem

The worker's `console.log`/`console.error` calls
(`packages/canopycms/src/worker/cms-worker.ts`) emit plain text with no
timestamp prefix. Under journald this didn't matter — journald stamps every
line with its own receive time. Now that the worker's stdout/stderr is
shipped to CloudWatch via the amazon-cloudwatch-agent (file-based tailing of
`/var/log/canopy-worker/worker.log`), CloudWatch only has the **ingestion**
timestamp to show — the moment the agent read and shipped the line, not the
moment the worker actually logged it. Under normal operation the skew is
small, but during an agent hiccup, a burst of buffered lines, or after an
instance restart, ingestion time can lag noticeably behind when the events
actually happened, which is exactly when accurate timestamps matter most for
debugging.

Multi-line output (e.g. an uncaught exception's stack trace) is worse: the
CloudWatch agent's default file collection treats each line as an
independent log event, so a single stack trace fragments into many separate
CloudWatch events instead of one coherent multi-line entry.

## Fix

Add a small timestamp-prefixing log helper in
`packages/canopycms/src/worker/cms-worker.ts` (e.g. an ISO-8601 prefix on
every line: `2026-07-24T18:03:11.482Z <message>`). This does two things:

1. Gives every log line a real, worker-emitted timestamp instead of relying
   on ingestion time.
2. Enables the CloudWatch agent's `multi_line_start_pattern` config (in the
   `canopy-worker-logs.json` config the worker's user-data writes — see
   `packages/canopycms-cdk/src/constructs/cms-service.ts`) keyed on that
   timestamp prefix, so multi-line stack traces collapse into a single
   CloudWatch event instead of fragmenting line-by-line.

Keep it lightweight — no new logging library dependency needed, just a
one-line wrapper around the existing `console.log`/`console.error` call
sites (or a tiny shared `log()`/`logError()` helper other worker modules
adopt).

## Related

[[worker-cloudwatch-logs]] — the log-shipping mechanism this improves on.
