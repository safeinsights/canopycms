import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Construct } from 'constructs'
import {
  Duration,
  RemovalPolicy,
  Stack,
  Token,
  aws_ec2 as ec2,
  aws_efs as efs,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_autoscaling as autoscaling,
  aws_s3_assets as s3assets,
  aws_logs as logs,
} from 'aws-cdk-lib'
import type { IBucket } from 'aws-cdk-lib/aws-s3'
import { attachLambdaExecutionPolicies } from './lambda-execution-role'

// This package (`canopycms-cdk`) is `"type": "module"`, so its compiled output
// is real ESM and `__dirname` is not a global there - the worker asset path
// below throws `__dirname is not defined` under a real ESM runtime (e.g. `tsx`)
// without this. Vitest's SSR/CJS-interop transform shims `__dirname`
// automatically, so this file's own tests would not catch its absence. Same fix
// as ../../lambda/asset-transform/build.mjs and ./asset-support.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Synth-time mirror of `resolveDeploymentName`'s rule in the `canopycms`
 * package (packages/canopycms/src/operating-mode/deployment-name.ts).
 *
 * Duplicated rather than imported so a CONSTRUCT-only consumer does not pay for
 * the core package's module graph. Whether that still justifies duplicating is
 * an open question, tracked alongside the same question about the S3 prefix
 * constants in .claude/future-tasks/cdk-prefixes-duplication.md.
 *
 * Drift between the two copies is caught by a test, not by this comment:
 * cms-deploy.test.ts drives both this construct and the runtime predicate over
 * the shared fixture in
 * packages/canopycms/src/operating-mode/deployment-name-fixtures.ts and
 * requires them to agree. Add a case there when you change either copy.
 *
 * Scoped to `deploymentName` ONLY. `baseBranch` and `settingsBranch` are whole
 * branch names rather than single ref components, so they get
 * `assertValidGitBranchName` instead — see that function's doc comment for why
 * reusing this charset there would refuse a legitimate `release/2026`.
 */
const isValidDeploymentName = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
  !name.includes('..') &&
  !name.endsWith('.') &&
  !name.endsWith('.lock')

/**
 * The heredoc delimiter user-data uses to write the worker's `.env` (see the
 * `cat > … << 'ENVEOF'` block below).
 */
const ENV_HEREDOC_DELIMITER = 'ENVEOF'

/**
 * Guard every value interpolated into the worker's `.env` file.
 *
 * This is robustness, not a security boundary: the heredoc delimiter is
 * quoted, so the shell performs no expansion on the body, and these values
 * come from the adopter's own CDK code rather than from an attacker. What it
 * catches is a malformed value silently producing a broken instance — a value
 * carrying a newline injects an arbitrary extra line into the worker's
 * environment, and a value containing the delimiter ends the heredoc early, so
 * the rest of the value is executed as user-data shell commands. Both would
 * deploy clean and fail at boot, or worse, boot with a subtly wrong
 * environment.
 *
 * Applied to EVERY entry in `envEntries` below by construction, not by
 * remembering to call it at each site.
 */
function assertEnvSafe(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `CanopyCmsService: ${name} must not contain a newline (got ${JSON.stringify(value)}). ` +
        `It is written into the worker's .env file, where a newline injects an arbitrary ` +
        `extra environment line.`,
    )
  }
  // systemd (EnvironmentFile=, see the unit below) treats a value whose FIRST
  // character is a quote as a quoted value and keeps consuming until the
  // matching quote -- across newlines. So a single leading quote does not
  // corrupt one line, it swallows every line after it: the deployment name,
  // AWS_REGION, the secret ARNs. A quote anywhere else is literal and fine,
  // which is why this checks position 0 rather than banning the character.
  if (value.startsWith('"') || value.startsWith("'")) {
    throw new Error(
      `CanopyCmsService: ${name} must not start with a quote character ` +
        `(got ${JSON.stringify(value)}). It is written into the worker's .env file, which ` +
        `systemd reads as EnvironmentFile -- a leading quote opens a quoted value that ` +
        `consumes every following line until a matching quote, silently emptying the rest ` +
        `of the worker's environment.`,
    )
  }
  if (value.includes(ENV_HEREDOC_DELIMITER)) {
    throw new Error(
      `CanopyCmsService: ${name} must not contain ${JSON.stringify(ENV_HEREDOC_DELIMITER)} ` +
        `(got ${JSON.stringify(value)}). It is written into the worker's .env file with a ` +
        `<< '${ENV_HEREDOC_DELIMITER}' heredoc, which that value would terminate early.`,
    )
  }
  // The same systemd `EnvironmentFile=` parser the leading-quote rule above is
  // about also treats a backslash as an escape: `a\b` arrives as `ab`, and a
  // value ENDING in a backslash continues onto the next line, swallowing the
  // .env entry that follows it. That is the quote hazard again in a quieter
  // form -- it corrupts a neighbouring variable rather than the one it appears
  // in -- so it is refused here rather than debugged on an instance.
  if (value.includes('\\')) {
    throw new Error(
      `CanopyCmsService: ${name} must not contain a backslash (got ${JSON.stringify(value)}). ` +
        `It is written into the worker's .env file, which systemd reads as EnvironmentFile -- ` +
        `there a backslash escapes the next character, and a trailing one continues the value ` +
        `onto the following line, consuming the next variable entirely.`,
    )
  }
  // Leading/trailing whitespace is stripped by that same parser, so a value
  // that is only whitespace reaches the worker as an empty string and every
  // caller downstream treats it as unset -- the silent-discard case, arriving
  // by a route no charset check upstream can see.
  if (value !== value.trim()) {
    throw new Error(
      `CanopyCmsService: ${name} must not start or end with whitespace ` +
        `(got ${JSON.stringify(value)}). systemd strips it when reading the worker's .env, so ` +
        `the value the worker sees would differ from the one configured here.`,
    )
  }
  return value
}

/**
 * Refuse a `baseBranch`/`settingsBranch` that git itself would reject, at
 * synth rather than at worker boot.
 *
 * Both values are interpolated into a git ref AND into a line of the worker's
 * `.env` that user-data writes with a shell heredoc. `assertEnvSafe` covers the
 * `.env` half; this covers the ref half, because a value git refuses does not
 * fail at `cdk deploy` -- it fails inside the worker, where
 * `verifyBaseBranchExists` throws, `worker/index.ts` exits 1, and systemd's
 * `Restart=always` turns it into a crash loop with no signal at the deploy that
 * caused it.
 *
 * DELIBERATELY NOT `isValidDeploymentName`, which governs a single ref
 * COMPONENT and so forbids `/`. These two props are whole branch names, where
 * `/` is conventional (`release/2026`, `epic/foo`); reusing the component rule
 * would refuse `cdk synth` for an adopter whose default branch is `release/v2`,
 * and the worker handles such names fine - it keeps the raw name for git refs
 * and runs it through `sanitizeBranchName` only for workspace DIRECTORY names.
 * This implements git's `check-ref-format` rules for a branch name instead.
 * Nothing in `canopycms` validates a branch name, so there is no runtime
 * counterpart to drift from and no shared fixture list like `deploymentName`'s.
 */
function assertValidGitBranchName(propName: string, value: string): string {
  const reject = (why: string): never => {
    throw new Error(
      `CanopyCmsService: invalid ${propName} ${JSON.stringify(value)} -- ${why}. ` +
        `It is used as a git branch name and written into the worker's .env, so it must be a ` +
        `name git accepts: slash-separated components (a '/' is fine, and conventional), no ` +
        `component starting with '.' or ending with '.lock', no '..', '~', '^', ':', '?', '*', ` +
        `'[', '\\', '@{', no whitespace or control characters, no leading '-', and it may not ` +
        `start or end with '/' or end with '.'.`,
    )
  }

  if (value.length === 0) reject('it is empty')
  if (value === '@') reject("a lone '@' is reserved by git")
  // `git check-ref-format --branch` rejects HEAD: it names the symbolic ref,
  // not a branch. Accepting it produces the exact crash loop this guard
  // exists to prevent -- verifyBaseBranchExists looks up refs/heads/HEAD,
  // which never exists.
  if (value === 'HEAD') reject("'HEAD' names the symbolic ref, not a branch")
  if (value.startsWith('-')) reject("a leading '-' parses as a git option")
  if (value.startsWith('/') || value.endsWith('/')) reject("it starts or ends with '/'")
  if (value.endsWith('.')) reject("it ends with '.'")
  if (value.includes('..')) reject("it contains '..'")
  if (value.includes('//')) reject("it contains an empty path component ('//')")
  if (value.includes('@{')) reject("it contains '@{', which git reads as a reflog selector")

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) reject('it contains a control character')
    if (char === ' ') reject('it contains whitespace')
    if ('~^:?*[\\'.includes(char))
      reject(`it contains the git-forbidden character ${JSON.stringify(char)}`)
  }

  for (const component of value.split('/')) {
    if (component.startsWith('.'))
      reject(`its path component ${JSON.stringify(component)} starts with '.'`)
    if (component.endsWith('.lock'))
      reject(`its path component ${JSON.stringify(component)} ends with '.lock'`)
  }

  return value
}

/**
 * A Secrets Manager ARN carrying the ECS/CloudFormation JSON-field suffix,
 * i.e. `arn:…:secret:name-AbCdEf:MY_KEY::` rather than `arn:…:secret:name-AbCdEf`.
 *
 * Keyed on "a colon anywhere after `:secret:`", because a secret NAME cannot
 * contain one: Secrets Manager's documented name charset is ASCII letters,
 * digits and `/_+=.@-`. So everything after `:secret:` in a secret ARN is the
 * name -- plus the six random characters AWS appends, when the ARN is a
 * complete one rather than the partial form this guard deliberately accepts --
 * and a further colon can only begin the `:json-key:version-stage:version-id`
 * tail. Anchoring on the six-character suffix instead would MISS the name-only
 * form `arn:…:secret:name:MY_KEY::`, which is the shape ECS's own documentation
 * shows and so the one adopters copy.
 */
const SECRET_ARN_WITH_FIELD_SUFFIX = /:secret:[^:]*:/

/**
 * The last two characters of the `…:json-key::` spelling -- the ECS suffix with
 * `version-stage` and `version-id` left empty, which is how AWS's own examples
 * show it.
 *
 * Checked in ADDITION to the regex above, for one case the regex cannot see: an
 * unresolved CDK token, `${Token[TOKEN.42]}:MY_KEY::`, carries no `:secret:` to
 * anchor on because the ARN has not been rendered yet. No well-formed secret
 * ARN, token or literal, ends in two colons, so this is safe to refuse.
 *
 * KNOWN LIMIT: a token ARN with NON-empty version parts
 * (`${Token[…]}:MY_KEY:AWSCURRENT:v1`) is caught by neither check and is stamped
 * verbatim. Recognising it needs `Token.isUnresolved` plus a guess at where the
 * token ends; the spelling adopters actually copy has the empty parts, and every
 * LITERAL ARN is caught by the regex whatever its version parts say.
 */
const SECRET_ARN_WITH_EMPTY_VERSION_TAIL = '::'

/**
 * Guards one (secret ARN, JSON field) prop pair at synth.
 *
 * Both checks exist because the failure they replace is SILENT, and both
 * failures land on the worker at boot -- where systemd's `Restart=always` turns
 * a misconfiguration into an indefinite 5-second restart loop rather than
 * anything `cdk deploy` reports.
 *
 * 1. A JSON-field prop with no ARN prop. The field env var is stamped, the ARN
 *    is not, and the credential is read from nowhere: for Clerk that leaves
 *    `refreshAuthCache` undefined, disabling auth-cache refresh with NO log line
 *    at all; for GitHub the worker reports "CANOPYCMS_GITHUB_TOKEN or
 *    CANOPYCMS_GITHUB_TOKEN_SECRET_ARN is required" while the adopter looks at a
 *    stack that plainly configures a GitHub secret.
 * 2. An ARN carrying the ECS `:KEY::` suffix, a CloudFormation-dynamic-reference
 *    and ECS `secrets.valueFrom` convention the `GetSecretValue` API does not
 *    parse. Through the scaffolded stack the adopter gets CDK's own cryptic
 *    complaint ("does not appear to be complete; missing 6-character suffix");
 *    hand-rolling the stack, the string lands verbatim in the worker's IAM
 *    `Resource`, where it can never match the real secret, and the worker gets
 *    AccessDenied. The message names the JSON-field prop, because the adopter's
 *    intent is supported - just spelled differently here.
 *
 * An empty JSON field is rejected for the same reason `settingsBranch: ''` is:
 * the worker reads a blank env var as "not configured" (`|| undefined` at both
 * call sites in worker/index.ts), so stamping it would discard an explicitly
 * set prop without a word.
 */
function assertSecretPropPair(
  arnPropName: string,
  arn: string | undefined,
  jsonFieldPropName: string,
  jsonField: string | undefined,
): void {
  if (jsonField !== undefined) {
    // `.trim()`, not `=== ''`: systemd's EnvironmentFile parser strips leading
    // and trailing whitespace from a value, so `" "` reaches the worker as `""`
    // and takes the same silently-ignored path an empty string would.
    if (jsonField.trim() === '') {
      throw new Error(
        `CanopyCmsService: ${jsonFieldPropName} must name a key, but it is ` +
          `${JSON.stringify(jsonField)}. The worker reads a blank value as "no field configured" ` +
          `and falls back to using the secret's whole value, silently ignoring this prop -- name ` +
          `the key you want, or omit the prop entirely.`,
      )
    }
    if (!arn) {
      throw new Error(
        `CanopyCmsService: ${jsonFieldPropName} is set but ${arnPropName} is not. ` +
          `The JSON field names a key INSIDE a secret, so it does nothing without the secret's ` +
          `ARN -- the worker would be told which key to read and never told where to read it ` +
          `from. Set ${arnPropName}, or drop ${jsonFieldPropName}.`,
      )
    }
  }

  if (arn !== undefined) {
    assertSecretArnHasNoFieldSuffix(arnPropName, arn, jsonFieldPropName)
  }
}

/**
 * Rejects the ECS `:KEY::` ARN suffix on any prop that carries a secret ARN.
 *
 * Separate from `assertSecretPropPair` because `secretsArns` has no JSON-field
 * prop of its own and still needs the check: its values go verbatim into the
 * worker's IAM policy, where a suffixed ARN is an unmatchable `Resource` and
 * produces exactly the AccessDenied restart-loop described above.
 */
function assertSecretArnHasNoFieldSuffix(
  propName: string,
  arn: unknown,
  jsonFieldPropName?: string,
): void {
  // `unknown`, and narrowed here, because the types are not the whole story:
  // `secretsArns: [process.env.EXTRA_SECRET_ARN!]` is the idiom a CDK app that
  // reads its config from the environment reaches for -- the scaffolded
  // `bin/app.ts` does exactly that everywhere else -- and `!` turns an unset
  // variable into `undefined` with the compiler none the wiser. Throwing, not
  // skipping: the `typeof arn === 'string'` filter on the IAM union below drops
  // such an entry silently, leaving a worker told to read a secret it has no
  // grant for, which is AccessDenied at boot.
  if (typeof arn !== 'string' || arn.length === 0) {
    throw new Error(
      `CanopyCmsService: ${propName} must be a non-empty secret ARN string, but it is ` +
        `${JSON.stringify(arn) ?? String(arn)}. An unset environment variable asserted with '!' ` +
        `arrives here as undefined; it would otherwise be dropped from the worker's IAM policy ` +
        `in silence, leaving a worker that knows which secret to read and cannot read it.`,
    )
  }
  if (!SECRET_ARN_WITH_FIELD_SUFFIX.test(arn) && !arn.endsWith(SECRET_ARN_WITH_EMPTY_VERSION_TAIL))
    return
  const alternative = jsonFieldPropName
    ? `Pass the plain secret ARN (everything up to and including the six-character suffix) and ` +
      `name the key with ${jsonFieldPropName} instead.`
    : `Pass the plain secret ARN, ending at the six-character suffix.`
  throw new Error(
    `CanopyCmsService: ${propName} ${JSON.stringify(arn)} carries a ':KEY::' JSON-field suffix. ` +
      `That is the ECS / CloudFormation dynamic-reference convention; the worker reads secrets ` +
      `with the GetSecretValue API, which does not parse it -- the suffixed string would be ` +
      `written into the worker's IAM policy, where it can never match the real secret, and the ` +
      `worker would fail with AccessDenied at boot. ${alternative}`,
  )
}

/** The three props that together configure GitHub App authentication. */
const GITHUB_APP_PROP_NAMES = [
  'githubAppId',
  'githubAppInstallationId',
  'githubAppPrivateKeySecretArn',
] as const

/**
 * The props that mean "this deployment authenticates with a personal access
 * token". The JSON field belongs here as well as the ARN: on its own it cannot
 * authenticate anything, but its PRESENCE still says which credential the
 * adopter thinks they are configuring, which is what the exclusivity rule needs
 * to know.
 */
const GITHUB_TOKEN_PROP_NAMES = ['githubTokenSecretArn', 'githubTokenSecretJsonField'] as const

/**
 * Rejects a PEM private key passed where a prop expects an identifier or an ARN.
 *
 * There is no plaintext private-key prop, and there cannot be one: the value
 * would be written into the worker's `.env`, which systemd reads as
 * `EnvironmentFile=` where a newline begins a new variable. So the realistic
 * mistake is to paste the key into `githubAppPrivateKeySecretArn` -- the prop
 * whose name contains "PrivateKey" -- instead of the ARN of a secret holding it.
 * Without this, that lands on `assertEnvSafe`'s generic rule and reports "must
 * not contain a newline" about an ARN, explaining the mechanism and not the
 * mistake.
 *
 * Checked on each of `GITHUB_APP_PROP_NAMES`, since the same misunderstanding
 * puts the key in any of them. `githubAppPrivateKeySecretJsonField` is
 * deliberately not checked: a JSON key NAME is not somewhere anyone mistakes a
 * PEM for, and this stays aligned with the one list defining "the App props".
 *
 * **Reached only by a hand-written stack**, since the generated
 * `infrastructure/lib/cms-stack.ts` resolves the ARN with
 * `Secret.fromSecretCompleteArn` BEFORE constructing `CanopyCmsService`, so a
 * scaffolded adopter gets CDK's own "does not appear to be complete" complaint
 * first. The hand-written path has nothing else.
 *
 * A one-line key (a base64-wrapped PEM, say) is NOT caught here and cannot be -
 * it is indistinguishable from a malformed ARN at synth. It fails at boot in
 * `normalizeGitHubAppPrivateKey`, or for the ARN prop as a Secrets Manager error
 * naming the string it tried to fetch.
 */
function assertNotInlinePrivateKey(propName: string, value: string | undefined): void {
  if (value === undefined || !value.includes('-----BEGIN')) return
  throw new Error(
    `CanopyCmsService: ${propName} looks like a PEM private key, not ${
      propName === 'githubAppPrivateKeySecretArn' ? 'a secret ARN' : 'an identifier'
    }. ` +
      `The GitHub App private key can ONLY be supplied as a Secrets Manager ARN -- it is ` +
      `multi-line, and every value this construct configures goes into the worker's .env file, ` +
      `which systemd reads as EnvironmentFile where a newline starts a new variable. Store the ` +
      `PEM in Secrets Manager and pass that secret's full ARN as githubAppPrivateKeySecretArn ` +
      `(optionally with githubAppPrivateKeySecretJsonField if it lives inside a JSON document).`,
  )
}

/**
 * Rejects a GitHub App identifier that is not a whole number.
 *
 * Both identifiers are numeric, and the two wrong values an adopter reaches for
 * are the App's *slug* and its `Iv1.…` OAuth client id — both are on the same
 * settings page as the number, and neither works.
 *
 * Both fail worse at boot. `createAppAuth` refuses a non-numeric `appId` at
 * construction (`@octokit/auth-app@6.1.4`: `Number.isFinite(+options.appId)`),
 * so the app id at least produces a named error; the installation id is checked
 * only for falsiness there, so a non-numeric one is interpolated into
 * `/app/installations/NaN/access_tokens` and comes back as a 404 that reads as
 * "the app is not installed", sending the operator to re-install a good App.
 * Stricter than `createAppAuth`'s own `+value` coercion, deliberately: that
 * accepts `' 12 '`, `12.5` and `0x1f`, and none of them is an id.
 *
 * Two values pass through untouched, both of which would otherwise be reported
 * as the wrong problem:
 *
 * - **Empty**, which is what `process.env.GITHUB_APP_ID ?? ''` and an Actions
 *   `vars.` reference to a variable nobody created both produce. That is an
 *   ABSENT id, not a malformed one, and `assertGitHubAuthProps` says so by name.
 * - **An unresolved CDK token**, e.g. `Fn.importValue(…)`, whose value does not
 *   exist until deploy. Refusing it would make a legitimate configuration
 *   unrepresentable, and it is unverifiable here either way.
 *   `githubAppPrivateKeySecretArn` already accepts a token, so this keeps the
 *   App props consistent with each other.
 */
function assertNumericId(propName: string, value: string | undefined): void {
  if (value === undefined || value === '' || /^\d+$/.test(value)) return
  if (Token.isUnresolved(value)) return
  throw new Error(
    `CanopyCmsService: ${propName} must be the numeric id GitHub shows for the app ` +
      `(got ${JSON.stringify(value)}). The app's slug and its 'Iv1.…' client id both appear on ` +
      `the same settings page and neither works here — githubAppId is the number labelled ` +
      `"App ID", and githubAppInstallationId is the trailing number in the URL of the app's ` +
      `install page under your organisation's settings.`,
  )
}

/**
 * Guards the GitHub credential props at synth: exactly one shape, fully given.
 *
 * 1. **All three App props or none.** Two of the three cannot work at all:
 *    `createAppAuth` needs the App ID, the installation ID and the key, and the
 *    message names the missing ones.
 * 2. **Not both an App and a token.** Rejected rather than resolved by
 *    precedence, because it would otherwise be undefined which identity a push
 *    or a pull request acts as -- and a PR opened by the wrong identity is not
 *    something an adopter notices quickly.
 *
 * Rule 2 also lives in `resolveWorkerGitHubAuth`
 * (packages/canopycms/src/worker/github-auth.ts), which core keeps because core
 * is reachable without this construct; rule 1 has no counterpart there, since
 * core takes one already-built `githubAppAuth` object. Checking at synth matters
 * because a worker that throws at boot is restarted by systemd every 5 seconds
 * indefinitely while `cdk deploy` reports success.
 *
 * Configuring NEITHER is deliberately not an error here. The worker also reads
 * `CANOPYCMS_GITHUB_TOKEN` directly from its environment, which an adopter can
 * supply outside this construct, and core refuses the genuinely empty case at
 * boot with a message naming both options.
 */
function assertGitHubAuthProps(props: CanopyCmsServiceProps): void {
  for (const name of GITHUB_APP_PROP_NAMES) {
    assertNotInlinePrivateKey(name, props[name])
  }
  assertNumericId('githubAppId', props.githubAppId)
  assertNumericId('githubAppInstallationId', props.githubAppInstallationId)

  const missing = GITHUB_APP_PROP_NAMES.filter((name) => !props[name])
  const provided = GITHUB_APP_PROP_NAMES.filter((name) => props[name])

  if (provided.length > 0 && missing.length > 0) {
    throw new Error(
      `CanopyCmsService: GitHub App authentication needs all of ` +
        `${GITHUB_APP_PROP_NAMES.join(', ')}, but ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set (${provided.join(' and ')} ` +
        `${provided.length === 1 ? 'is' : 'are'}). An App's installation token is minted from ` +
        `all three together, so a partial set cannot authenticate at all -- supply the rest, or ` +
        `drop them and use githubTokenSecretArn.`,
    )
  }

  // The JSON field counts as "a token is configured", not just the ARN. An
  // adopter following docs/adopter-migration.md removes `githubTokenSecretArn`
  // and overlooks `githubTokenSecretJsonField`; left out of this check, that
  // lands on `assertSecretPropPair` instead, which answers "Set
  // githubTokenSecretArn, or drop githubTokenSecretJsonField" -- pointing them
  // back at the credential they were just told to delete, and at a
  // configuration this rule would then refuse anyway.
  const tokenPropsSet = GITHUB_TOKEN_PROP_NAMES.filter((name) => props[name])
  if (provided.length > 0 && tokenPropsSet.length > 0) {
    throw new Error(
      `CanopyCmsService: configure either the githubToken* props or the githubApp* props, not ` +
        `both (${tokenPropsSet.join(' and ')} ${tokenPropsSet.length === 1 ? 'is' : 'are'} set ` +
        `alongside ${provided.join(' and ')}). Two credentials would leave it undefined which ` +
        `identity the worker's pushes and pull requests act as. A personal access token is the ` +
        `default and needs no App props; GitHub App auth replaces it, so drop ` +
        `${tokenPropsSet.join(' and ')} when you adopt it.`,
    )
  }
}

/**
 * Default CMS Lambda timeout.
 *
 * Shared with `CanopyCmsDistribution`, which uses it as its default origin
 * read timeout: CloudFront's own default is **30 seconds**, so leaving the
 * origin unset silently caps this Lambda at half its budget. Requests in the
 * gap are answered 504 at the edge while the invocation runs to completion
 * behind them — first-touch branch provisioning does a full `git clone` onto
 * EFS inside the request, so this is a real path, not a hypothetical one.
 *
 * One constant rather than two matching literals, so the pair cannot drift;
 * `cms-deploy.test.ts` asserts the emitted template keeps them equal.
 *
 * NOTE: CloudFront accepts an origin read timeout up to 60s without a quota
 * increase. A longer Lambda timeout needs an AWS quota increase before the
 * distribution can match it — `CanopyCmsDistribution` fails at synth rather
 * than deploying a configuration that would 504.
 */
export const DEFAULT_CMS_LAMBDA_TIMEOUT = Duration.seconds(60)

/** CloudFront's maximum origin read timeout without a service-quota increase. */
export const MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT = Duration.seconds(60)

export interface CanopyCmsServiceProps {
  /** Docker image for the CMS Lambda function */
  cmsDockerImage: lambda.DockerImageCode

  /** Optional: use an existing VPC instead of creating one */
  vpc?: ec2.IVpc

  /** Lambda memory in MB (default: 2048) */
  memorySize?: number

  /** Lambda timeout (default: 60 seconds) */
  timeout?: Duration

  /** Lambda reserved concurrency cap (default: 10) */
  reservedConcurrency?: number

  /**
   * Lambda architecture (default: `Architecture.ARM_64`, matching the EC2
   * worker and AssetSupport's transform Lambda).
   *
   * This also decides the image's architecture for
   * `DockerImageCode.fromImageAsset`: the construct always passes a resolved
   * architecture to the function, and CDK derives the Docker build platform
   * from it. So omit `platform` on `fromImageAsset`. An explicit `platform`
   * overrides the derived one, and an image built for the other architecture
   * cannot run on the function: an arm64 image on an x86_64 function fails at
   * invoke with `Runtime.InvalidEntrypoint` (see "Where the image is built" in
   * docs/deploying-to-aws.md). A prebuilt image (`DockerImageCode.fromEcr`) has
   * no build for CDK to steer, so it must already be built for this architecture.
   */
  architecture?: lambda.Architecture

  /** EC2 spot max price (default: on-demand rate for t4g.nano) */
  spotMaxPrice?: string

  /**
   * ADDITIONAL Secrets Manager ARNs the worker may read.
   *
   * You do NOT need to repeat `githubTokenSecretArn` or
   * `clerkSecretKeySecretArn` here — those are unioned into the worker's IAM
   * policy automatically. Use this only for secrets the construct does not
   * know about.
   */
  secretsArns?: string[]

  /**
   * Environment variables for the Lambda function.
   *
   * Two keys are not free-form here, because the construct configures the
   * worker from the same values and the two halves must agree:
   * `CANOPYCMS_DEPLOYMENT_NAME` is folded into `deploymentName` (validated,
   * and mirrored into the worker's `.env`), and `CANOPY_MODE` accepts only
   * `'prod'`. Everything else is passed through untouched.
   */
  environment?: Record<string, string>

  /** EFS removal policy (default: RETAIN) */
  efsRemovalPolicy?: RemovalPolicy

  /** GitHub owner for worker git operations (e.g., 'safeinsights') */
  githubOwner: string

  /** GitHub repo name for worker git operations (e.g., 'docs-site') */
  githubRepo: string

  /** Secrets Manager ARN for the GitHub bot token */
  githubTokenSecretArn?: string

  /**
   * The key within a JSON secret document at `githubTokenSecretArn`; omit when
   * the secret's whole value is the credential.
   *
   * Stamped into the worker's `CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD`, which
   * `getSecret` (packages/canopycms-cdk/worker/secrets.ts) reads to pull one
   * field out of the document instead of using the whole string. Omitting it is
   * the default and the common case — a secret holding a bare `ghp_…` needs
   * nothing here.
   *
   * This is NOT the ECS/CloudFormation `arn:…:secret:name-AbCdEf:KEY::`
   * convention. The worker calls the `GetSecretValue` API, which does not parse
   * that suffix; a literal ARN carrying one is refused at synth (see
   * `assertSecretArnHasNoFieldSuffix` below, and the known limit recorded on
   * `SECRET_ARN_WITH_EMPTY_VERSION_TAIL` for the one token spelling that gets
   * through) and the field belongs here instead.
   */
  githubTokenSecretJsonField?: string

  /**
   * GitHub App ID, to authenticate the worker as a GitHub App installation
   * instead of as a personal access token.
   *
   * **The token is the default and stays first-class.** Registering a GitHub
   * App under an organisation takes an owner of that organisation (or a GitHub
   * App manager for all its Apps), which many adopters are not, so this is the
   * "if your organisation requires it" option, not a direction of travel.
   * Nothing about
   * `githubTokenSecretArn` is deprecated or warned about.
   *
   * All three App props (`githubAppId`, `githubAppInstallationId`,
   * `githubAppPrivateKeySecretArn`) are set together or not at all, and App
   * auth is mutually exclusive with `githubTokenSecretArn` — both are refused
   * at synth. That mirrors `resolveWorkerGitHubAuth` in core
   * (packages/canopycms/src/worker/github-auth.ts), which refuses the same two
   * shapes at boot; checking here turns a 5-second systemd restart loop into a
   * failed `cdk synth`.
   *
   * Stamped into the worker's `CANOPYCMS_GITHUB_APP_ID`.
   */
  githubAppId?: string

  /**
   * The App's installation ID on your repository — NOT the App ID above.
   *
   * An App can be installed on several accounts, and a token is minted per
   * installation, so both numbers are needed. It is the trailing number in the
   * URL of the App's install page under your organisation's settings.
   *
   * Stamped into the worker's `CANOPYCMS_GITHUB_APP_INSTALLATION_ID`.
   */
  githubAppInstallationId?: string

  /**
   * Secrets Manager ARN for the App's PEM private key.
   *
   * **ARN-only: there is deliberately no plaintext prop for this key**, and the
   * reason is mechanical. Every value the construct puts in the worker's
   * environment is written into a `.env` file systemd reads as
   * `EnvironmentFile=`, where a newline starts a new variable, so `assertEnvSafe`
   * refuses one and a PEM is inherently multi-line: a plaintext key could not be
   * delivered to the worker intact by this path at all. Passing the PEM itself
   * here is caught by name at synth (`assertNotInlinePrivateKey`) rather than
   * surfacing as a puzzling "an ARN must not contain a newline".
   *
   * The ARN is unioned into the worker's IAM policy alongside the other secret
   * ARN props; you do not need to repeat it in `secretsArns`.
   */
  githubAppPrivateKeySecretArn?: string

  /**
   * The key within a JSON secret document at `githubAppPrivateKeySecretArn`;
   * omit when the secret's whole value is the PEM.
   *
   * Stamped into the worker's
   * `CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD`. See
   * `githubTokenSecretJsonField` above — same mechanism, same non-relationship
   * to the ECS `:KEY::` ARN suffix.
   *
   * A PEM stored as a JSON string value carries its newlines as `\n` escapes,
   * which `JSON.parse` turns back into real newlines — and the worker
   * additionally runs whatever it reads through
   * `normalizeGitHubAppPrivateKey`, which unescapes and base64-unwraps, so a
   * key mangled by a single-line config field still works.
   */
  githubAppPrivateKeySecretJsonField?: string

  /** Secrets Manager ARN for the Clerk secret key */
  clerkSecretKeySecretArn?: string

  /**
   * The key within a JSON secret document at `clerkSecretKeySecretArn`; omit
   * when the secret's whole value is the credential.
   *
   * Stamped into the worker's `CLERK_SECRET_KEY_SECRET_JSON_FIELD`. See
   * `githubTokenSecretJsonField` above — same mechanism, same non-relationship
   * to the ECS `:KEY::` ARN suffix.
   *
   * Note that this covers `CLERK_SECRET_KEY` only. A Clerk JSON document
   * typically also holds `CLERK_JWT_KEY` and the publishable key, and NEITHER
   * can be sourced from Secrets Manager at all: `CLERK_JWT_KEY` reaches the
   * Lambda as a plain value through `environment`, and the publishable key is a
   * Docker build arg inlined into the client bundle. Both are public material
   * (docs/deploying-to-aws.md, "Security Model"), so that is by design rather
   * than an omission — but it means pointing this prop at your document does
   * not relieve you of supplying those two separately.
   */
  clerkSecretKeySecretJsonField?: string

  /**
   * The GitHub repository's default branch name (default: 'main').
   *
   * Interpolated straight into a git ref (`refs/heads/{baseBranch}`) and into
   * the worker's `.env` heredoc, so an invalid value is rejected at synth (see
   * `assertValidGitBranchName` above). A branch that git accepts but the repo
   * does not have fails permanently at boot instead: `verifyBaseBranchExists`
   * (packages/canopycms/src/worker/cms-worker.ts) throws, `worker/index.ts`
   * exits 1, systemd's `Restart=always` repeats that forever, and
   * `rebaseActiveBranches` rebases against the wrong lineage in the meantime.
   *
   * MUST match the shared repo's `canopycms.config.ts`'s `defaultBaseBranch`
   * (both default to 'main' when unset) — the two are resolved by different
   * processes (this stamps the worker's `.env`; the Lambda reads
   * `config.defaultBaseBranch` at request time) with no automatic reconciliation
   * between them. `infrastructure/lib/cms-stack.ts`, as scaffolded by
   * `canopycms init-deploy aws`, derives this prop FROM that config file so the
   * two cannot drift; a hand-rolled stack must set it explicitly whenever
   * `defaultBaseBranch` is anything other than 'main'.
   */
  baseBranch?: string

  /**
   * Explicit settings-branch name, stamped into the worker's
   * `CANOPYCMS_SETTINGS_BRANCH` environment variable (default: unset, in which
   * case the worker falls through to the same computed name the Lambda uses,
   * `canopycms-settings-<deploymentName>` — see `deploymentName` below).
   *
   * Only set this to mirror an adopter-configured `config.settingsBranch` in
   * `canopycms.config.ts`. Leaving both unset is safe: Lambda and worker resolve
   * the SAME computed name independently, with nothing to keep in sync. But if
   * the shared config sets `settingsBranch` and this prop does not, the worker
   * keeps resolving the computed name while the Lambda's `getSettingsBranchName`
   * short-circuits on `config.settingsBranch`, so the two own different
   * branches: the PRIMARY settings-push path still reaches GitHub (its task
   * payload carries the Lambda-resolved name), but the worker's per-cycle
   * backstop push (`pushSettingsBranches`) targets the wrong branch and its
   * "foreign settings branch" warning misfires against the deployment's own.
   *
   * Interpolated into a git ref and the worker's `.env` heredoc, so validated at
   * synth like `baseBranch` (see `assertValidGitBranchName`).
   * `infrastructure/lib/cms-stack.ts`, as scaffolded by `canopycms init-deploy
   * aws`, derives it from the same `canopycms.config.ts` so the two cannot
   * drift.
   */
  settingsBranch?: string

  /**
   * Deployment name (default: 'prod'). Namespaces the settings branch
   * (`canopycms-settings-{deploymentName}`) so this stack's CMS Lambda/worker
   * don't fight another CanopyCMS deployment over the same orphan settings
   * branch. Stamped into the Lambda's `CANOPYCMS_DEPLOYMENT_NAME` environment
   * variable and the worker's `.env`; both resolve it through
   * `resolveDeploymentName` (packages/canopycms/src/operating-mode/deployment-name.ts),
   * which lets this env value win over any `deploymentName` baked into the
   * shared repo's `canopycms.config.ts` — the point of this prop.
   *
   * `environment.CANOPYCMS_DEPLOYMENT_NAME` still overrides this prop, but it
   * is now folded in at synth: the winner is validated by the same rule and
   * written to BOTH halves, so the Lambda and the worker can never resolve
   * different settings branches.
   *
   * Two `CanopyCmsService` stacks pointed at the SAME GitHub repo MUST set
   * distinct values here, or both resolve to `canopycms-settings-prod` and
   * fight over the same branch (permissions/groups changes reviewed on one PR
   * clobber the other). Changing this value later, on a stack that already
   * has a populated settings workspace, is refused at boot (see
   * settings-workspace.ts's rename guard) rather than silently reset — plan
   * the value up front for any stack that shares a repo.
   */
  deploymentName?: string

  /**
   * The asset bucket (from `AssetSupport`, or any bucket following its
   * prefix layout) the CMS Lambda's role should be granted access to. When
   * provided, grants the exact prefix-scoped put/get/delete permissions
   * `S3AssetStore` calls for (packages/canopycms/src/assets/store-s3.ts) -
   * mirrors `AssetSupport.grantUploadAccess()` rather than depending on that
   * construct directly, so `canopycms-cdk`'s two constructs stay decoupled.
   */
  assetBucket?: IBucket

  /**
   * Retention for the EC2 worker's CloudWatch log group (default: three
   * months).
   */
  workerLogRetention?: logs.RetentionDays

  /**
   * Name for the worker's CloudWatch log group (default:
   * `/canopycms/<stackName>/worker`). Override to follow an org naming
   * convention, or when instantiating this construct twice in one stack (the
   * default name would collide).
   */
  workerLogGroupName?: string

  /**
   * Execution role for the CMS Lambda (default: CDK creates one).
   *
   * Set this when the role's ARN has to be computable WITHOUT a reference to
   * this construct - typically a cross-account asset bucket. See
   * `AssetSupportProps.transformRole` for why `Fn::GetStackOutput` does not give
   * you that, and what a deterministically NAMED role costs
   * (`CAPABILITY_NAMED_IAM`, no in-place replacement without a rename).
   *
   * This Lambda is VPC-attached, which makes the compensation in
   * `attachLambdaExecutionPolicies` (./lambda-execution-role) load-bearing
   * rather than cosmetic: CDK discards `AWSLambdaVPCAccessExecutionRole` for a
   * passed role, and without it the function cannot create ENIs and so cannot
   * start - after synthesizing and deploying clean. The construct re-attaches
   * it, which is also why this is `iam.Role` and not `iam.IRole` (an imported
   * role would drop it again, silently). Everything else survives a passed role
   * untouched: the EFS access-point statements, the `cmsLogGroup` write grant
   * and the `assetBucket` grants all land on it.
   *
   * The EC2 worker has its own instance role and is unaffected by this prop.
   */
  lambdaRole?: iam.Role

  /**
   * Retention for the CMS Lambda's CloudWatch log group (default: three
   * months / 90 days).
   */
  cmsLogRetention?: logs.RetentionDays

  /**
   * Name for the CMS Lambda's CloudWatch log group (default:
   * `/canopycms/<stackName>/cms`). Deliberately NOT
   * `/aws/lambda/<function-name>` - see the constructor's `cmsLogGroup`
   * comment for why a CDK-managed group must avoid that exact name once the
   * function has ever been deployed without one (CloudFormation's
   * `CreateLogGroup` call fails "already exists" against a group Lambda
   * itself auto-created outside CloudFormation). Override to follow an org
   * naming convention, or when instantiating this construct twice in one
   * stack (the default name would collide).
   */
  cmsLogGroupName?: string
}

/**
 * Core CDK construct for CanopyCMS deployment.
 *
 * Creates:
 * - VPC (2 AZs, public + private subnets, NO NAT)
 * - EFS filesystem with access point at /workspace
 * - Lambda function (Docker image, EFS mount, private subnet, no internet)
 * - Lambda Function URL (for CloudFront origin)
 * - EC2 Worker (t4g.nano spot in ASG, public subnet, EFS mount, systemd) -
 *   rolled via the ASG's UpdatePolicy by every deploy that changes its launch
 *   template, so a changed worker bundle reaches the instance instead of
 *   sitting unused in a launch template until the next spot interruption (see
 *   the UpdatePolicy below)
 * - Dedicated CloudWatch log groups for the CMS Lambda and the worker's
 *   stdout/stderr (the worker's is shipped via the amazon-cloudwatch-agent -
 *   journald is not agent-readable), each with a custom name/retention/
 *   removal policy instead of the CloudFormation-implicit
 *   `/aws/lambda/<function-name>` group (infinite retention, survives
 *   `cdk destroy`)
 * - Security groups (least-privilege)
 * - IAM roles (Lambda: EFS + CloudWatch Logs write scoped to its own log
 *   group; EC2: EFS + Secrets Manager + CloudWatch Logs write, scoped to its
 *   own log group)
 */
export class CanopyCmsService extends Construct {
  /** Lambda Function URL — use as CloudFront origin */
  public readonly functionUrl: lambda.FunctionUrl

  /**
   * The CMS Lambda's resolved timeout — `props.timeout` or
   * {@link DEFAULT_CMS_LAMBDA_TIMEOUT}.
   *
   * Exposed so a distribution in front of this service can set its origin read
   * timeout to the SAME value. CloudFront's own default is 30s, which silently
   * caps a longer Lambda: every request landing in the gap is answered 504 at
   * the edge while the invocation runs to completion behind it (see
   * `CanopyCmsDistribution`'s `originReadTimeout`).
   */
  public readonly timeout: Duration

  /** The EFS filesystem */
  public readonly fileSystem: efs.FileSystem

  /** The VPC */
  public readonly vpc: ec2.IVpc

  /** The Lambda function */
  public readonly lambdaFunction: lambda.Function

  /** The CMS Lambda's CloudWatch log group (Lambda stdout/stderr) */
  public readonly cmsLogGroup: logs.LogGroup

  /** The EC2 worker Auto Scaling Group */
  public readonly workerAsg: autoscaling.AutoScalingGroup

  /** The EC2 worker's CloudWatch log group (worker stdout/stderr) */
  public readonly workerLogGroup: logs.LogGroup

  constructor(scope: Construct, id: string, props: CanopyCmsServiceProps) {
    super(scope, id)

    // Deployment name: ONE effective value, validated once, used by both halves.
    // `props.environment` is spread into the Lambda's environment, so an adopter
    // can set CANOPYCMS_DEPLOYMENT_NAME there directly; that escape hatch is
    // resolved HERE so it cannot bypass the synth guard below, and so the same
    // validated string is stamped on the Lambda AND written into the worker's
    // `.env`. Two halves resolving different settings branches is what
    // `pushSettingsBranches`'s "foreign settings branch" warning detects.
    const envDeploymentNameOverride = props.environment?.['CANOPYCMS_DEPLOYMENT_NAME']
    const deploymentName = envDeploymentNameOverride ?? props.deploymentName ?? 'prod'
    const deploymentNameSource =
      envDeploymentNameOverride !== undefined
        ? 'environment.CANOPYCMS_DEPLOYMENT_NAME'
        : 'deploymentName'

    // Fail at synth, not at boot. deploymentName is interpolated BOTH into a git
    // ref (`canopycms-settings-{deploymentName}`) and into a line of the worker's
    // `.env`, which user-data writes with a shell heredoc — a value carrying a
    // newline or quote would corrupt the worker's environment file before any
    // runtime validation could run.
    if (!isValidDeploymentName(deploymentName)) {
      throw new Error(
        `CanopyCmsService: invalid deploymentName ${JSON.stringify(deploymentName)} ` +
          `(from ${deploymentNameSource}). ` +
          `It must start with a letter or digit, contain only letters, digits, '.', '_' or '-', ` +
          `and must not contain '..' or end with '.' or '.lock'.`,
      )
    }

    // Both are interpolated into a git ref and the worker's `.env` heredoc, so
    // both are guarded at synth - see their doc comments for the failure each
    // prevents. `settingsBranch` stays `undefined` (not stamped at all) unless
    // the adopter explicitly set it: an absent env var and an empty one are NOT
    // the same to the worker, which falls through to a computed name only when
    // `CANOPYCMS_SETTINGS_BRANCH` is unset entirely.
    const baseBranch = assertValidGitBranchName('baseBranch', props.baseBranch ?? 'main')
    const settingsBranch =
      props.settingsBranch !== undefined
        ? assertValidGitBranchName('settingsBranch', props.settingsBranch)
        : undefined

    // Checked at the top so a misconfigured pair fails `cdk synth` rather than
    // `cdk deploy`-then-restart-loop.
    //
    // WHICH CREDENTIAL first, then whether each is well formed: the order is
    // load-bearing. Reversed, an adopter following docs/adopter-migration.md who
    // removes `githubTokenSecretArn` and overlooks `githubTokenSecretJsonField`
    // is told "Set githubTokenSecretArn, or drop githubTokenSecretJsonField" --
    // pointing them back at the credential they were just told to delete, and at
    // a configuration the exclusivity rule would refuse anyway.
    // `assertGitHubAuthProps` is silent when no App prop is set, so this costs
    // the token-only path nothing.
    assertGitHubAuthProps(props)
    assertSecretPropPair(
      'githubTokenSecretArn',
      props.githubTokenSecretArn,
      'githubTokenSecretJsonField',
      props.githubTokenSecretJsonField,
    )
    assertSecretPropPair(
      'clerkSecretKeySecretArn',
      props.clerkSecretKeySecretArn,
      'clerkSecretKeySecretJsonField',
      props.clerkSecretKeySecretJsonField,
    )
    assertSecretPropPair(
      'githubAppPrivateKeySecretArn',
      props.githubAppPrivateKeySecretArn,
      'githubAppPrivateKeySecretJsonField',
      props.githubAppPrivateKeySecretJsonField,
    )
    // `secretsArns` gets the suffix half of the same guard: it has no
    // JSON-field prop, but its entries are written verbatim into the worker's
    // IAM policy below, so a suffixed ARN fails there in precisely the way the
    // policy's own comment describes.
    for (const [index, arn] of (props.secretsArns ?? []).entries()) {
      assertSecretArnHasNoFieldSuffix(`secretsArns[${index}]`, arn)
    }

    // The adopter's `canopycms.config.ts` is shared by local dev, the image
    // build and this deployment, and it says `dev`. That is right for both of
    // the others: build-time reads come from the working tree in either mode
    // (`readsFromCheckout` in canopycms's build-mode.ts), while prod would hold
    // the image builder to checks it has no reason to meet (gitBotAuthorName/
    // gitBotAuthorEmail, a credential-verifying auth plugin). So the deployed
    // mode is supplied at run time instead: `resolveOperatingMode`
    // (packages/canopycms/src/operating-mode/mode-env.ts) reads CANOPY_MODE and
    // it wins over the config literal. Without it the Lambda runs dev mode,
    // resolves its workspace to `<cwd>/.canopy-dev`, and fails EROFS on Lambda's
    // read-only filesystem.
    //
    // Only 'prod' is accepted from `props.environment`: this construct deploys
    // the prod topology (EFS workspace, no internet, read-only container), so a
    // synth error beats an EROFS crash-loop. The browser half of `mode` cannot
    // come from here at all; it is inlined at image-build time from the
    // NEXT_PUBLIC_CANOPY_MODE build arg (Dockerfile.cms.template).
    const envModeOverride = props.environment?.['CANOPY_MODE']
    if (envModeOverride !== undefined && envModeOverride !== 'prod') {
      throw new Error(
        `CanopyCmsService: invalid environment.CANOPY_MODE ${JSON.stringify(envModeOverride)}. ` +
          `This construct deploys the prod topology, so the only supported value is "prod" ` +
          `(dev mode resolves its workspace to <cwd>/.canopy-dev, which is read-only on Lambda). ` +
          `Omit it to get the default.`,
      )
    }

    this.vpc =
      props.vpc ??
      new ec2.Vpc(this, 'Vpc', {
        maxAzs: 2,
        natGateways: 0, // No NAT — Lambda has no internet access
        subnetConfiguration: [
          {
            name: 'Public',
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
          {
            name: 'Private',
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
            cidrMask: 24,
          },
        ],
      })

    // Gateway VPC endpoint for S3 (free - no hourly/data charge, unlike an
    // interface endpoint). Without this the PRIVATE_ISOLATED subnet has NO route
    // to S3 at all (no NAT, no IGW) and the CMS Lambda's S3AssetStore calls
    // (presigned POST generation, finalize's originals/meta writes) hang or fail
    // outright. `addGatewayEndpoint` is on `IVpc` itself, so this works whether
    // `this.vpc` was created here or supplied via `props.vpc`.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    })

    // EFS — persistent filesystem for content, git repos, cache
    const efsSg = new ec2.SecurityGroup(this, 'EfsSg', {
      vpc: this.vpc,
      description: 'CanopyCMS EFS',
      allowAllOutbound: false,
    })

    this.fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc: this.vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy: props.efsRemovalPolicy ?? RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: efsSg,
    })

    const accessPoint = this.fileSystem.addAccessPoint('WorkspaceAP', {
      path: '/workspace',
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755',
      },
      posixUser: {
        gid: '1000',
        uid: '1000',
      },
    })

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'CanopyCMS Lambda',
      allowAllOutbound: false, // No internet access
    })

    // The Lambda SG is allowAllOutbound: false, so without the explicit EGRESS
    // rule as well as the EFS ingress rule the NFS mount is blocked and every
    // Lambda request fails to reach /mnt/efs. Same pair for the worker below.
    efsSg.addIngressRule(lambdaSg, ec2.Port.tcp(2049), 'Lambda NFS access')
    lambdaSg.addEgressRule(efsSg, ec2.Port.tcp(2049), 'NFS to EFS')

    // Lambda -> S3 via the gateway endpoint above, HTTPS only. The tight option,
    // `ec2.Peer.prefixList(<S3 managed prefix list id>)`, needs a
    // region-specific literal id: no CFN attribute exposes it off
    // `GatewayVpcEndpoint`, and `PrefixList.fromLookup` is a real AWS
    // context-provider lookup, which would make this construct's synth require
    // live AWS credentials.
    //
    // `anyIpv4()` on 443 is safe HERE SPECIFICALLY because this
    // PRIVATE_ISOLATED subnet's route table has no route to 0.0.0.0/0 at all
    // (no NAT, no IGW) - only the VPC CIDR and configured endpoints' prefix-list
    // routes - so the rule cannot reach the general internet. The route table,
    // not the security group, is the real boundary. Narrow this to
    // `Peer.prefixList(...)` if a region-agnostic reference to the S3 managed
    // prefix list lands in CDK, or if this VPC ever gains a NAT/IGW route.
    lambdaSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to S3 (via gateway endpoint)',
    )

    // Dedicated CloudWatch log group for the CMS Lambda's stdout/stderr,
    // custom-named and NOT the CloudFormation-implicit `/aws/lambda/<function
    // name>`, for two reasons: CDK does not manage that implicit group at all
    // (infinite retention, and `cdk destroy` leaves it behind), and Lambda
    // auto-creates it on first invoke OUTSIDE CloudFormation, after which a CDK
    // `LogGroup` using that exact name fails `CreateLogGroup` with "already
    // exists" and blocks every future `cdk deploy`. Same convention as
    // `workerLogGroup` below.
    this.cmsLogGroup = new logs.LogGroup(this, 'CmsFunctionLogs', {
      logGroupName: props.cmsLogGroupName ?? `/canopycms/${Stack.of(this).stackName}/cms`,
      retention: props.cmsLogRetention ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    this.timeout = props.timeout ?? DEFAULT_CMS_LAMBDA_TIMEOUT

    // Re-attach what CDK silently drops for a caller-supplied role. MUST run
    // for every passed role, and `vpc: true` here is the load-bearing part:
    // this function is VPC-attached, so a role without
    // AWSLambdaVPCAccessExecutionRole cannot create ENIs and the Lambda cannot
    // start, having deployed clean. See that function's doc comment.
    if (props.lambdaRole) {
      attachLambdaExecutionPolicies(props.lambdaRole, { vpc: true })
    }

    // Always resolved, never passed through as `undefined`. DockerImageFunction
    // hands it to the image code's `_bind`, and for `fromImageAsset` that is
    // what sets the Docker build platform. Unset, CDK sets no platform at all:
    // Docker builds for whatever machine runs `cdk deploy` (arm64 on Apple
    // Silicon, amd64 on an x86 CI runner) while the function stays x86_64, and
    // the mismatch only shows at invoke. See `architecture`'s doc comment.
    const architecture = props.architecture ?? lambda.Architecture.ARM_64

    this.lambdaFunction = new lambda.DockerImageFunction(this, 'CmsFunction', {
      code: props.cmsDockerImage,
      // Default (unset) leaves CDK to create the execution role, with its own
      // managed policies intact. See `lambdaRole`'s doc comment.
      role: props.lambdaRole,
      memorySize: props.memorySize ?? 2048,
      timeout: this.timeout,
      reservedConcurrentExecutions: props.reservedConcurrency ?? 10,
      architecture,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      filesystem: lambda.FileSystem.fromEfsAccessPoint(accessPoint, '/mnt/efs'),
      // Pass the pre-created group via `logGroup`, NOT `logRetention` (CDK
      // throws LogRetentionLogGroupConflict/ConflictingLogPolicyOptions if
      // both are set on the same function) - the removal policy lives on the
      // LogGroup construct above instead.
      logGroup: this.cmsLogGroup,
      environment: {
        // INVARIANT: the Lambda mounts EFS through the WorkspaceAP access point
        // above, which is already rooted at EFS:/workspace - so /mnt/efs here IS
        // EFS:/workspace. The EC2 worker instead mounts the filesystem ROOT at
        // /mnt/efs (see UserData below) and reaches the same directory via
        // /mnt/efs/workspace. Both paths must resolve to EFS:/workspace, or the
        // Lambda and worker silently operate on different directories.
        CANOPYCMS_WORKSPACE_ROOT: '/mnt/efs',
        CANOPY_AUTH_CACHE_PATH: '/mnt/efs/.cache',
        // git >= 2.35.2 refuses repos owned by another uid (the access point
        // forces uid 1000; Lambda containers run as a different user).
        // Env-based GIT_CONFIG_* CANNOT fix this - simple-git hard-blocks env
        // config. The fix lives in the image: Dockerfile.cms.template runs
        // `git config --system safe.directory '*'`.
        ...props.environment,
        // AFTER the spread, deliberately. Both values are already the adopter's
        // own choice (an `environment` override is folded into `deploymentName`
        // above and validated; CANOPY_MODE is restricted to 'prod'), so nothing
        // is taken away - the placement is what stops the Lambda and the
        // worker's `.env` holding different strings.
        CANOPYCMS_DEPLOYMENT_NAME: deploymentName,
        CANOPY_MODE: 'prod',
      },
    })

    // Explicit, scoped grant - NOT a reliance on the auto-created execution
    // role's AWSLambdaBasicExecutionRole managed policy, which CDK attaches
    // regardless of `logGroup` and never adjusts for it (passing `logGroup` only
    // points the function's LoggingConfig at this group; it grants no IAM). That
    // policy's logs:CreateLogStream/logs:PutLogEvents statement is scoped to
    // `arn:aws:logs:*:*:log-group:/aws/lambda/*:*`, so it grants nothing for a
    // custom-named group. Without this grantWrite the function creates log
    // streams into the void: CloudWatch Logs delivery failures never reach the
    // invocation, so logs simply vanish with no error anywhere.
    this.cmsLogGroup.grantWrite(this.lambdaFunction)

    // AWS_IAM (not NONE): the Function URL must only be reachable through
    // CloudFront, which signs origin requests via Origin Access Control (see
    // CanopyCmsDistribution). With NONE, anyone who learns the URL hits the CMS
    // directly, bypassing CloudFront. Adopters wiring their own CloudFront must
    // configure an OAC and grant it lambda:InvokeFunctionUrl.
    this.functionUrl = this.lambdaFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })

    // The same prefix-scoped put/get/delete grants as
    // `AssetSupport.grantUploadAccess()`, duplicated rather than shared so the
    // two constructs stay independently usable - a consumer wires them together
    // in their own stack, and `AssetSupport` has no CMS-service dependency
    // either.
    if (props.assetBucket) {
      const prefixes = {
        staging: 'asset-staging',
        originals: 'asset-originals',
        meta: 'asset-meta',
        public: 'assets',
      }
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.staging}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.staging}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.originals}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.meta}/*`)
      props.assetBucket.grantRead(this.lambdaFunction, `${prefixes.public}/*`)
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.originals}/*`)
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.meta}/*`)
      props.assetBucket.grantPut(this.lambdaFunction, `${prefixes.public}/*`)
      props.assetBucket.grantDelete(this.lambdaFunction, `${prefixes.staging}/*`)
      props.assetBucket.grantDelete(this.lambdaFunction, `${prefixes.meta}/*`)
    }

    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc: this.vpc,
      description: 'CanopyCMS EC2 Worker',
      allowAllOutbound: false,
    })

    efsSg.addIngressRule(workerSg, ec2.Port.tcp(2049), 'Worker NFS access')
    workerSg.addEgressRule(efsSg, ec2.Port.tcp(2049), 'NFS to EFS')

    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS outbound')

    // Worker → DNS (needed for EFS DNS-based mount targets)
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'DNS TCP')
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS UDP')

    const workerRole = new iam.Role(this, 'WorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'CanopyCMS EC2 Worker role',
    })

    // The worker's secret grant MUST be the UNION of `secretsArns` and every
    // individual ARN prop. Anything the construct stamps into the worker's
    // `.env` and omits here is a worker that knows WHICH secret to read and has
    // no permission to read it: `cdk deploy` succeeds, the worker boots, gets
    // AccessDenied from GetSecretValue, exits, and systemd restart-loops it
    // every 5s forever, with nothing flagged at synth.
    //
    // Deduped for the reader, NOT for the emitted template: `PolicyStatement`
    // already collapses a repeated `resources` entry (aws-cdk-lib 2.265), so
    // removing this `new Set` changes no synthesized output.
    const secretsArns = [
      ...new Set(
        [
          ...(props.secretsArns ?? []),
          props.githubTokenSecretArn,
          // Read by the same `getSecret` call path as the token it replaces,
          // from the same instance profile, so omitting it here reproduces that
          // AccessDenied restart-loop exactly.
          props.githubAppPrivateKeySecretArn,
          props.clerkSecretKeySecretArn,
        ].filter((arn): arn is string => typeof arn === 'string' && arn.length > 0),
      ),
    ]
    if (secretsArns.length > 0) {
      workerRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: secretsArns,
        }),
      )
    }

    // Worker needs EFS access (handled via security group, but mount needs ec2:DescribeAvailabilityZones)
    workerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonElasticFileSystemClientReadWriteAccess'),
    )

    // Observation channel for a NAT-less deploy (SSM Session Manager / send-command);
    // worker SG already allows 443 egress.
    workerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    )

    // Dedicated CloudWatch log group for the worker's stdout/stderr (shipped by
    // the CloudWatch agent in user-data below - the agent cannot read journald,
    // so the systemd unit is switched to file output further down).
    this.workerLogGroup = new logs.LogGroup(this, 'WorkerLogs', {
      logGroupName: props.workerLogGroupName ?? `/canopycms/${Stack.of(this).stackName}/worker`,
      retention: props.workerLogRetention ?? logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    })
    // CreateLogStream + PutLogEvents scoped to this group only (least privilege;
    // the group is pre-created by CFN so the agent never needs CreateLogGroup).
    this.workerLogGroup.grantWrite(workerRole)

    // The worker is bundled with esbuild into a single JS file (pnpm run build:worker)
    const workerAsset = new s3assets.Asset(this, 'WorkerCode', {
      path: path.join(__dirname, '../../worker/dist'),
    })
    workerAsset.grantRead(workerRole)

    // Name/value PAIRS rather than pre-formatted lines: every value then flows
    // through `assertEnvSafe` in the single `map` below, so a value added here
    // later is guarded whether or not whoever adds it remembers to.
    const envEntries: Array<[string, string]> = [
      ['CANOPYCMS_WORKSPACE_ROOT', '/mnt/efs/workspace'],
      ['CANOPYCMS_GITHUB_OWNER', props.githubOwner],
      ['CANOPYCMS_GITHUB_REPO', props.githubRepo],
      ['CANOPYCMS_BASE_BRANCH', baseBranch],
      // The SAME string the Lambda's environment gets above, including an
      // `environment.CANOPYCMS_DEPLOYMENT_NAME` override - the two halves
      // resolve one settings branch (`canopycms-settings-<name>`) between them,
      // and disagreeing here is what the runtime warning detects.
      ['CANOPYCMS_DEPLOYMENT_NAME', deploymentName],
      // The AWS SDK JS v3 cannot resolve a region from IMDS on its own - without
      // this the worker's bare `SecretsManagerClient({})` crash-loops with
      // "Region is missing".
      ['AWS_REGION', Stack.of(this).region],
    ]
    if (props.githubTokenSecretArn) {
      envEntries.push(['CANOPYCMS_GITHUB_TOKEN_SECRET_ARN', props.githubTokenSecretArn])
    }
    // The JSON-field vars need NO IAM change, and that is not an oversight: a
    // field is a key inside a secret's value, not a separately grantable
    // resource. `secretsmanager:GetSecretValue` on the secret -- already granted
    // above from the same ARN prop -- returns the whole document, and the worker
    // picks the field out of it in `getSecret` (worker/secrets.ts).
    if (props.githubTokenSecretJsonField) {
      envEntries.push([
        'CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD',
        props.githubTokenSecretJsonField,
      ])
    }
    // GitHub App credentials, stamped individually even though
    // `assertGitHubAuthProps` has established they are all set or all unset: a
    // future prop added to the App set then cannot be silently dropped by a
    // condition that names only its siblings.
    if (props.githubAppId) {
      envEntries.push(['CANOPYCMS_GITHUB_APP_ID', props.githubAppId])
    }
    if (props.githubAppInstallationId) {
      envEntries.push(['CANOPYCMS_GITHUB_APP_INSTALLATION_ID', props.githubAppInstallationId])
    }
    if (props.githubAppPrivateKeySecretArn) {
      envEntries.push([
        'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_ARN',
        props.githubAppPrivateKeySecretArn,
      ])
    }
    if (props.githubAppPrivateKeySecretJsonField) {
      envEntries.push([
        'CANOPYCMS_GITHUB_APP_PRIVATE_KEY_SECRET_JSON_FIELD',
        props.githubAppPrivateKeySecretJsonField,
      ])
    }
    if (props.clerkSecretKeySecretArn) {
      envEntries.push(['CLERK_SECRET_KEY_SECRET_ARN', props.clerkSecretKeySecretArn])
    }
    if (props.clerkSecretKeySecretJsonField) {
      envEntries.push(['CLERK_SECRET_KEY_SECRET_JSON_FIELD', props.clerkSecretKeySecretJsonField])
    }
    if (settingsBranch !== undefined) {
      // Only when explicitly set - an absent prop must keep today's behavior
      // (the worker falls through to the computed `canopycms-settings-<name>`),
      // so this must never stamp an empty string either way.
      envEntries.push(['CANOPYCMS_SETTINGS_BRANCH', settingsBranch])
    }
    const envFileContent = envEntries
      .map(([name, value]) => `${name}=${assertEnvSafe(name, value)}`)
      .join('\n')

    const userData = ec2.UserData.forLinux()
    userData.addCommands(
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      '# FAIL-FAST. Every step below is required for the worker to exist at',
      '# all, and until this trap existed a failure in any of them aborted',
      '# user-data BEFORE the systemd unit was written -- leaving an instance',
      "# that runs, passes the ASG's EC2-only health check indefinitely, and",
      '# does nothing. cfn-signal is deliberately not used here (it would',
      '# prove nothing about READINESS, which is the argument recorded below),',
      '# but that argument never covered a boot-SCRIPT failure: `cdk deploy`',
      '# reported success while publishes queued on EFS, the auth cache went',
      '# stale and PRs stopped being created, until a human noticed the admin',
      '# panel showing the worker absent.',
      '#',
      '# Shutting down makes the instance fail its EC2 health check, so the ASG',
      '# replaces it -- which is the only automatic recovery available in this',
      '# topology. The echo lands in the console log, readable via',
      '# `aws ec2 get-console-output`, because the CloudWatch agent is itself',
      '# configured further down and cannot be relied on to exist yet.',
      'trap \'echo "canopy-worker user-data FAILED at line $LINENO (exit $?)" >&2; shutdown -h now\' ERR',
      '',
      '# Bounded retry for the network-dependent steps. Package mirrors and S3',
      '# have transient failures; a single flake should cost seconds, not an',
      '# instance replacement.',
      'retry() {',
      '  local n=0',
      '  until "$@"; do',
      '    n=$((n + 1))',
      '    if [ "$n" -ge 5 ]; then',
      '      echo "canopy-worker: command failed after $n attempts: $*" >&2',
      '      return 1',
      '    fi',
      '    sleep $((n * 5))',
      '  done',
      '}',
      '',
      '# Install dependencies (unzip is not guaranteed in the AL2023 AMI)',
      'retry dnf install -y git unzip',
      "# Node comes from AL2023's own repos, NOT a piped third-party installer.",
      '# The previous boot curled the NodeSource RPM setup script straight into',
      '# bash, so every instance replacement -- which the ASG performs on every',
      '# `cdk deploy`, plus every spot interruption -- depended on a third party',
      '# being reachable. cms-deploy.test.ts asserts that URL never comes back,',
      '# which is why it is not spelled out here.',
      '#',
      '# nodejs22, not 20: Node 20 reached upstream EOL on 2026-04-30, and this',
      '# repo declares `engines.node: ">=22"` with .nvmrc `v22`, so the worker',
      '# was running an EOL runtime BELOW the floor its own code is tested at.',
      "# 22 (EOL 2027-04-30) matches .nvmrc, CI, and the transform Lambda's",
      '# NODEJS_22_X, so one runtime is tested everywhere.',
      '#',
      '# ExecStart uses the NAMESPACED /usr/bin/node-22 (see the systemd unit',
      '# below), not the bare `node`: AL2023 installs versioned binaries and',
      '# points `/usr/bin/node` at one of them through `alternatives`, whose',
      '# selection AWS documents as able to change at any time.',
      'retry dnf install -y nodejs22',
      '',
      '# Mount EFS',
      'retry dnf install -y amazon-efs-utils',
      'mkdir -p /mnt/efs',
      `mount -t efs ${this.fileSystem.fileSystemId}:/ /mnt/efs`,
      '# Persist the mount across instance reboots: user-data runs once per',
      '# instance, so without an fstab entry a plain reboot leaves /mnt/efs an',
      '# empty local dir and the worker would clone a divergent remote.git',
      '# onto the instance disk, invisible to the Lambda.',
      `echo '${this.fileSystem.fileSystemId}:/ /mnt/efs efs _netdev 0 0' >> /etc/fstab`,
      '',
      '# Download worker from CDK S3 Asset',
      `retry aws s3 cp s3://${workerAsset.s3BucketName}/${workerAsset.s3ObjectKey} /tmp/canopy-worker.zip`,
      'mkdir -p /opt/canopy-worker',
      'cd /opt/canopy-worker',
      'unzip -o /tmp/canopy-worker.zip',
      '# The worker bundle is ESM (esbuild --format=esm). Without this marker a',
      '# .js file is CommonJS by default and the import statement fails.',
      '# Node >=22.7 auto-detects module syntax and would mask its absence, and',
      '# this instance now runs node-22 -- so the marker is kept BECAUSE that',
      '# auto-detection is a fallback we should not depend on, not because the',
      '# runtime here still needs it.',
      `echo '{"type":"module"}' > /opt/canopy-worker/package.json`,
      '',
      '# Write environment file for systemd service',
      `cat > /opt/canopy-worker/.env << 'ENVEOF'`,
      envFileContent,
      'ENVEOF',
      '',
      '# Create systemd service',
      `cat > /etc/systemd/system/canopy-worker.service << 'SVCEOF'`,
      '[Unit]',
      'Description=CanopyCMS Worker Daemon',
      'After=network.target',
      '# Never run against an unmounted /mnt/efs (see the fstab note above).',
      'RequiresMountsFor=/mnt/efs',
      '',
      '[Service]',
      'Type=simple',
      'User=ec2-user',
      'WorkingDirectory=/opt/canopy-worker',
      '# Namespaced binary, not bare `node`: AL2023 points /usr/bin/node at',
      '# an installed version through `alternatives`, and AWS documents that',
      '# selection as able to change at any time. node-22 always means 22.',
      'ExecStart=/usr/bin/node-22 index.js',
      'Restart=always',
      'RestartSec=5',
      'TimeoutStartSec=300',
      '# File output, not journal: the CloudWatch agent cannot read journald,',
      '# so it tails this file instead (see the agent config below).',
      '# CAUTION: /var/log/canopy-worker must exist BEFORE first start. systemd',
      '# opens append: targets before it creates LogsDirectory= dirs',
      '# (systemd#27591), so without the pre-created dir the exec fails with',
      '# 209/STDOUT and Restart=always crash-loops forever. User-data runs',
      '# mkdir before systemctl start; LogsDirectory= is kept for ownership.',
      'LogsDirectory=canopy-worker',
      'StandardOutput=append:/var/log/canopy-worker/worker.log',
      'StandardError=append:/var/log/canopy-worker/worker.log',
      'EnvironmentFile=/opt/canopy-worker/.env',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SVCEOF',
      '',
      '# Set ownership for ec2-user',
      'chown -R ec2-user:ec2-user /opt/canopy-worker',
      '# Non-recursive: EFS access point enforces UID 1000 for Lambda.',
      '# Only set ownership on mount point and workspace dir to avoid',
      '# slow recursive chown on large filesystems during ASG replacements.',
      'chown ec2-user:ec2-user /mnt/efs',
      'mkdir -p /mnt/efs/workspace',
      'chown ec2-user:ec2-user /mnt/efs/workspace',
      '',
      '# Pre-create the worker log dir (crash-loop guard, MUST precede the',
      '# first systemctl start): systemd opens StandardOutput=append: files',
      '# BEFORE it creates LogsDirectory= dirs (systemd#27591), so on a fresh',
      '# instance the unit would fail exec with 209/STDOUT and crash-loop',
      '# forever without this. The unit keeps LogsDirectory= for ownership',
      '# management on subsequent starts.',
      'mkdir -p /var/log/canopy-worker',
      'chown ec2-user:ec2-user /var/log/canopy-worker',
      '',
      '# Start worker',
      'systemctl daemon-reload',
      'systemctl enable canopy-worker',
      'systemctl start canopy-worker',
      '',
      '# ---- CloudWatch log shipping ----',
      '# Placed AFTER worker start: with set -euo pipefail, a package/agent',
      '# failure here must not prevent the worker from running (shipping is',
      '# best-effort).',
      '#',
      '# DISARM THE FAIL-FAST TRAP AND errexit FIRST. Everything above this line',
      '# is required for the worker to exist at all, so a failure there should',
      '# replace the instance. Nothing below it is: the worker is already',
      '# running and healthy by this point. Leaving the trap armed would let a',
      '# package-mirror outage during the agent install shut down a perfectly',
      '# good worker -- and the ASG would relaunch straight into the same',
      '# outage, turning degraded log shipping into a replacement loop with the',
      '# worker down for its duration. That is strictly worse than the',
      '# best-effort behaviour this section has always documented.',
      'trap - ERR',
      'set +e',
      'retry dnf install -y amazon-cloudwatch-agent logrotate',
      '',
      '# Bound on-disk growth; copytruncate keeps the fd the CW agent tails valid',
      '# (tiny copy->truncate loss window is acceptable for diagnostic logs).',
      `cat > /etc/logrotate.d/canopy-worker << 'ROTEOF'`,
      '/var/log/canopy-worker/worker.log {',
      '    size 10M',
      '    rotate 5',
      '    compress',
      '    copytruncate',
      '    missingok',
      '    notifempty',
      '}',
      'ROTEOF',
      '# The config above only fires when logrotate actually runs; AL2023',
      '# presets may leave logrotate.timer disabled, and without it the size',
      '# cap never triggers and worker.log grows until the nano disk fills.',
      '# --now is idempotent if the timer is already enabled/running.',
      'systemctl enable --now logrotate.timer',
      '',
      '# No retention_in_days here: CDK owns retention on the pre-created group.',
      `cat > /opt/aws/amazon-cloudwatch-agent/etc/canopy-worker-logs.json << 'CWEOF'`,
      '{',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/canopy-worker/worker.log",',
      `            "log_group_name": "${this.workerLogGroup.logGroupName}",`,
      '            "log_stream_name": "{instance_id}",',
      // The worker prefixes every line with an ISO-8601 timestamp
      // (packages/canopycms/src/worker/log.ts). Parsing it here is what makes
      // CloudWatch show the time the WORKER emitted a line rather than the
      // time the agent shipped it - those diverge exactly when it matters
      // (agent hiccup, buffered burst, post-restart backlog).
      '            "timestamp_format": "%Y-%m-%dT%H:%M:%S.%f",',
      // The prefix ends in `Z`, so the parsed time is UTC. Without this the
      // agent would interpret it in the instance's local zone.
      '            "timezone": "UTC",',
      // "{timestamp_format}" reuses the pattern above as the multi-line start
      // marker: a line WITHOUT the timestamp prefix continues the previous
      // event instead of becoming its own. That is what keeps a stack trace as
      // one CloudWatch event, and why every writer to this file must go
      // through the worker log helpers.
      '            "multi_line_start_pattern": "{timestamp_format}"',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  }',
      '}',
      'CWEOF',
      '# fetch-config -s starts AND systemctl-enables the agent (reboot-persistent).',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/canopy-worker-logs.json',
    )

    // Launch template (not the deprecated AutoScalingGroup instanceType/
    // machineImage/... shorthand): that shorthand synthesizes an
    // AWS::AutoScaling::LaunchConfiguration, which AWS accounts created after
    // ~mid-2023 cannot create at all — `cdk deploy` would hard-fail for any
    // fresh adopter account. An explicit LaunchTemplate synthesizes
    // AWS::EC2::LaunchTemplate instead, which every account can use.
    const launchTemplate = new ec2.LaunchTemplate(this, 'WorkerLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role: workerRole,
      securityGroup: workerSg,
      userData,
      spotOptions: {
        requestType: ec2.SpotRequestType.ONE_TIME, // required for ASG-managed spot
        maxPrice: parseFloat(props.spotMaxPrice ?? '0.0042'), // On-demand rate for t4g.nano
      },
    })

    this.workerAsg = new autoscaling.AutoScalingGroup(this, 'WorkerAsg', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      // `healthChecks`, not the deprecated `healthCheck`/`HealthCheck.ec2({ grace })`:
      // both synthesize the same HealthCheckType/HealthCheckGracePeriod, but the
      // deprecated form prints a jsii warning on every synth -- in adopters'
      // `cdk synth` output, not just ours -- and is slated for removal in v3.
      healthChecks: autoscaling.HealthChecks.ec2({
        gracePeriod: Duration.minutes(5),
      }),
      // Without an updatePolicy, CloudFormation's default behavior for an ASG
      // behind a changed launch template is to update the template resource
      // and do NOTHING else - the running instance keeps its old user-data
      // (and therefore the old worker code: the worker bundle is a CDK S3
      // asset whose hash is interpolated into user-data's `aws s3 cp
      // s3://...`) until a spot interruption or a manual terminate happens
      // to replace it. `cdk deploy` would then silently deploy everything
      // EXCEPT the worker. `rollingUpdate` makes CloudFormation actually
      // terminate-and-relaunch the instance on every deploy that changes the
      // launch template, so a worker code change actually reaches it.
      //
      // minInstancesInService: 0 is REQUIRED, not just accepted, because
      // minCapacity/maxCapacity are both 1: nothing can stay "in service" out of
      // a max of 1 while its replacement is created. The update is therefore
      // terminate-then-relaunch, with a short worker outage while the
      // replacement boots (2-4 minutes of package installs and the EFS mount).
      // That outage is acceptable: the task queue and branch workspaces live on
      // EFS, not on the instance, so the new instance picks up where the old one
      // left off, and the Lambda's Save/Publish paths only enqueue task files
      // onto EFS and never talk to the worker directly. A task mid-flight at
      // termination is handled by orphan recovery on every task-queue cycle, not
      // only at worker boot (recoverOrphanedTasks in
      // CmsWorker.processTaskQueue(), packages/canopycms/src/worker/cms-worker.ts).
      //
      // `waitOnResourceSignals` therefore defaults to false here - see the
      // no-cfn-signal note below.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({ minInstancesInService: 0 }),
    })

    // Deliberately NO cfn-signal, for two reasons:
    //
    // 1. User-data runs under `set -euo pipefail` and the CloudWatch-agent block
    //    sits at the very end ON PURPOSE, so an agent failure cannot kill the
    //    boot. A cfn-signal after it would never run when that block fails, and
    //    CloudFormation would wait out its timeout and roll back the ENTIRE
    //    deploy - the opposite of "agent shipping is best-effort".
    // 2. Placed earlier (right after `systemctl start canopy-worker`) a signal
    //    proves almost nothing: the unit is `Type=simple` with `Restart=always`,
    //    so `systemctl start` returns 0 the instant the process execs and a
    //    worker that immediately crash-loops still signals SUCCESS. A real
    //    readiness gate would have to poll `worker-status.json` or
    //    `systemctl is-active` in a loop first.
    //
    // recoverOrphanedTasks()'s per-cycle recovery (see above) covers the actual
    // problem - a stranded task surviving an instance replacement - regardless
    // of WHY the instance was replaced, and without depending on the new one
    // ever proving "ready".

    // Boot ordering: the ASG can launch before EFS mount targets are
    // available; user-data runs with `set -euo pipefail`, so an early
    // `mount -t efs` failure kills the whole bootstrap and the
    // EC2-health-checked ASG never notices.
    this.workerAsg.node.addDependency(this.fileSystem.mountTargetsAvailable)
  }
}
