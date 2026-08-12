# Worker log lines carry no real timestamps in CloudWatch

> **RESOLVED 2026-08-12** — `packages/canopycms/src/worker/log.ts` exports
> `workerLog`/`workerLogWarn`/`workerLogError`, which prefix each line with an
> ISO-8601 UTC timestamp and a level tag. All 64 `cms-worker.ts` call sites and
> the 5 in `packages/canopycms-cdk/worker/index.ts` were converted; the latter
> reaches them through a re-export off the existing
> `canopycms/worker/cms-worker` entrypoint, so no new package entrypoint was
> added. The CloudWatch agent config in `cms-service.ts` gained
> `timestamp_format`, `timezone: UTC`, and
> `multi_line_start_pattern: "{timestamp_format}"`.
>
> Two things worth carrying forward:
>
> - **INVARIANT: every writer to `/var/log/canopy-worker/worker.log` must use
>   the helpers.** `multi_line_start_pattern` means an unprefixed line
>   *continues the previous event* rather than starting its own. New worker
>   code calling bare `console.*` will silently corrupt event boundaries.
> - **A level tag was added beyond this file's original spec**, because the
>   systemd unit sends stdout AND stderr to the same file — without the tag,
>   `console.log` and `console.error` are indistinguishable in CloudWatch.
> - Not covered: output Node prints itself on the way down (an uncaught
>   exception dump). It has no prefix and attaches to the preceding event —
>   still better than the per-line fragmentation it replaces.

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
