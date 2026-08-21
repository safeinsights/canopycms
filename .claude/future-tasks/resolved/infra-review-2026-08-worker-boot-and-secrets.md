# [P2] Worker boot and secret-handling defects on the EC2 side

Three findings from the 2026-08-20 three-round infrastructure review (round 1),
all **CONFIRMED** at HEAD `7881e489`. Grouped because they are one pass over the
worker instance's boot and credential path.

## 1. Boot hard-depends on rpm.nodesource.com under `set -e`, with no retry and no replacement

`cms-service.ts:656-657` runs `curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -`
under `set -euo pipefail`. Every instance boot re-runs this — and boots are now
routine: the ASG rolls on every `cdk deploy`, plus spot interruptions.

Any transient failure (nodesource outage, DNS hiccup, mirror 503) aborts
user-data **before the systemd unit is written**. Nothing retries and nothing
replaces the instance: the EC2-only ASG health check (`:826-828`) sees a running
instance, and CloudFormation reports the deploy successful because cfn-signal was
deliberately omitted (`:862-887`). That decision is argued entirely in terms of
*readiness* — "a signal would prove nothing about readiness" — and never
addresses that a **boot-script** failure yields a permanently dead, never-replaced
worker. The mount-ordering comment at `:889-893` acknowledges exactly this
blindness for one step and fixes only the ordering.

**Scenario.** 2am spot interruption; the replacement boots during a 20-minute
nodesource incident; `curl | bash` fails; user-data dies; the instance passes EC2
health checks indefinitely. Publishes queue on EFS, the auth cache goes stale,
PRs stop being created — until someone notices the admin panel's "worker absent"
or the next deploy happens to replace the instance. `cdk deploy` said everything
succeeded.

**Fix direction.** Remove the boot-time third-party fetch — install Node from
AL2023's own `nodejs20` dnf module, or bake the runtime into an AMI / the worker
bundle. Failing that, wrap the network steps in a bounded retry and
`shutdown -h now` on script failure so the ASG actually replaces the instance.

## 2. The GitHub bot token can be persisted onto EFS, and is never cleaned up

`ensureRemoteGit()` (`cms-worker.ts:681-703`) clones `remote.git` from
`https://x-access-token:<token>@github.com/…`, which git records verbatim in
`remote.git/config` as `remote.origin.url`. The token is scrubbed only by a
`removeRemote('origin')` that (a) runs after the clone plus a verification
round-trip, (b) swallows its own failure silently (`.catch(() => {})`), and (c) is
never re-attempted — the already-exists path (`:666-678`) fast-returns without
ever re-checking the config. A token that survives once survives forever.

A clone interrupted by SIGKILL/power-off can also leave a partial repo whose
config already holds the token; that path additionally hits the "Delete
`remote.git` and restart the worker" refusal, so the poisoned config sits on EFS
until an operator acts.

**Scenario.** First boot of a new stack against a large repo; the bare clone
takes two minutes; the spot instance is interrupted right after the clone
completes. `remote.git/config` on EFS now contains the GitHub PAT. The security
model `docs/deploying-to-aws.md` sells — "If Lambda is compromised, an attacker
can read/write content on EFS but cannot push to GitHub"; "Secrets stay on the
worker" — is now false. A compromised Lambda can read the token off EFS and,
despite having no egress, exfiltrate it by writing it into branch content that
the worker then pushes to GitHub.

**Fix direction.** Clone without embedding the token in a persisted remote (via
`-c credential.*` / askpass, or clone to a temp name and rename into place only
after the config is scrubbed), and make the exists-path assert
`remote.origin.url` is absent — removing it if found — so any historic leak
self-heals.

## 3. Secret ARN props don't feed the IAM policy — clean deploy, crash-looping worker

The construct carries two disconnected representations of "the secrets the worker
reads": `secretsArns` feeds the IAM grant (`cms-service.ts:579-586`), while
`githubTokenSecretArn` / `clerkSecretKeySecretArn` feed the worker's `.env`
(`:638-643`). The generated template happens to set both, but the construct
accepts the individual ARN props alone — producing a worker that knows *which*
secret to read and has no permission to read it. Nothing flags it at synth.

**Scenario.** An adopter hand-writing their stack (both props are individually
documented, and `secretsArns`'s doc comment doesn't say it is the sole source of
IAM) sets `githubTokenSecretArn` and omits `secretsArns`. `cdk deploy` succeeds;
the worker boots, calls `GetSecretValue`, gets AccessDenied, exits, and systemd
restart-loops every 5s forever. The only signal is the CloudWatch log stream or
the admin panel's "absent" worker.

**Fix direction.** Union the individual ARN props into the IAM policy
automatically, or throw at synth when an ARN prop is set but absent from
`secretsArns`.
