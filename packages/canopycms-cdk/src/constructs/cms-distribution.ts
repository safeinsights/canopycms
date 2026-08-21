import { Construct } from 'constructs'
import {
  Duration,
  Stack,
  Token,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_lambda as lambda,
} from 'aws-cdk-lib'
import { DEFAULT_CMS_LAMBDA_TIMEOUT, MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT } from './cms-service'

/**
 * Merge caller behaviors over this construct's own, preserving THE CALLER'S
 * ordering for every key they supply.
 *
 * A plain `{ ...defaults, ...caller }` gets the values right and the ORDER
 * wrong: JavaScript keeps an overridden key at its first-insertion index, so a
 * caller who overrides `/_next/static/*` finds it pinned ahead of every other
 * pattern they passed, regardless of the order they wrote. Since CloudFront
 * matches path patterns in order, that silently makes a more specific pattern
 * listed after it unreachable -- exactly the failure the prop's doc comment
 * warns callers to avoid, introduced by the merge itself.
 *
 * Dropping collided defaults FIRST means the caller's own object contributes
 * its keys in its own order.
 */
function mergeBehaviors(
  defaults: Record<string, cloudfront.BehaviorOptions>,
  caller: Record<string, cloudfront.BehaviorOptions> | undefined,
): Record<string, cloudfront.BehaviorOptions> {
  if (!caller) return defaults
  const uncollided = Object.fromEntries(
    Object.entries(defaults).filter(([pattern]) => !(pattern in caller)),
  )
  return { ...uncollided, ...caller }
}

export interface CanopyCmsDistributionProps {
  /** Lambda Function URL from CanopyCmsService */
  functionUrl: lambda.FunctionUrl

  /** Domain name for the CMS (e.g., 'cms.docs.example.org') */
  domainName: string

  /** Route53 hosted zone domain (e.g., 'example.org') */
  hostedZoneDomain: string

  /** Optional: provide an existing hosted zone instead of looking up by domain */
  hostedZone?: route53.IHostedZone

  /** Optional: provide an existing ACM certificate instead of creating one */
  certificate?: acm.ICertificate

  /**
   * How long CloudFront waits for the origin to respond.
   *
   * Defaults to {@link DEFAULT_CMS_LAMBDA_TIMEOUT}, matching the CMS Lambda's
   * own default. Pass `cmsService.timeout` when you override the Lambda's
   * timeout, so the two cannot drift.
   *
   * Left unset on the origin, CloudFront applies its service default of **30
   * seconds** — which silently caps a 60s Lambda at half its budget. Every
   * request landing in the 30-60s band is answered 504 at the edge while the
   * invocation continues to completion behind it: server-side success,
   * viewer-facing failure, and nothing in either log explaining the other
   * half. First-touch branch provisioning does a full `git clone` onto EFS
   * inside the request, so this is a real path.
   *
   * Capped at 60s: CloudFront rejects more without a service-quota increase.
   */
  originReadTimeout?: Duration

  /**
   * Extra CloudFront behaviors, merged with this construct's own.
   *
   * The reason this exists: `AssetSupport.assetBehaviors()` returns the two
   * behaviors a media-enabled deployment needs (`/assets/*` and
   * `/assets/t/*`), and without a way to pass them in there was no route to
   * attach them to the distribution the scaffold generates — making the
   * scaffold's own "uncomment to enable media" path a dead end.
   *
   * ORDER MATTERS. CloudFront matches path patterns in the order given, so a
   * more specific pattern must be listed before a more general one that also
   * matches: `/assets/t/*` before `/assets/*`, or every transform request is
   * served by the static S3-only behavior and never fails over to the
   * transform Lambda.
   *
   * Keys here override this construct's own behaviors on collision, which is
   * deliberate — the caller is more specific than the default — and an
   * overridden key takes YOUR position in this object, not the position the
   * default held. (A plain object spread would do the opposite; see
   * `mergeBehaviors`.)
   */
  additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>
}

/**
 * Optional CDK construct for CanopyCMS CloudFront distribution.
 *
 * Use this if you don't have existing CloudFront infrastructure.
 * If you do, use the functionUrl output from CanopyCmsService
 * and wire it into your own CloudFront setup.
 *
 * Creates:
 * - ACM certificate (DNS validated) — unless provided
 * - CloudFront distribution with Function URL origin
 * - Route53 A/AAAA alias records
 * - Cache policies: no-cache for /api/* and /edit*, cache /_next/static/*
 * - Viewer-request CloudFront Function setting x-forwarded-host (redirect-URL
 *   derivation behind the Host-stripping OAC origin)
 */
export class CanopyCmsDistribution extends Construct {
  /** The CloudFront distribution */
  public readonly distribution: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: CanopyCmsDistributionProps) {
    super(scope, id)

    // ========================================================================
    // DNS — Hosted Zone lookup
    // ========================================================================

    const hostedZone =
      props.hostedZone ??
      route53.HostedZone.fromLookup(this, 'Zone', {
        domainName: props.hostedZoneDomain,
      })

    // ========================================================================
    // ACM Certificate
    // ========================================================================

    // CloudFront requires its ACM certificate to live in us-east-1, and this
    // construct creates one in the STACK's region. Nothing in the construct,
    // the scaffold, or docs/deploying-to-aws.md said so -- the scaffold merely
    // asks for an AWS_REGION variable with us-east-1 as an example -- so an
    // adopter elsewhere got an opaque region error and had to research both
    // workarounds themselves. Fail with the answer instead.
    //
    // Only when the region is actually known at synth: a region-agnostic stack
    // resolves to a token, and rejecting that would break `cdk synth` for
    // everyone (the token is not us-east-1 as a string). Those deploys are
    // rejected by CloudFront at deploy time as before.
    const stackRegion = Stack.of(this).region
    if (!props.certificate && !Token.isUnresolved(stackRegion) && stackRegion !== 'us-east-1') {
      throw new Error(
        `CanopyCmsDistribution: CloudFront requires its ACM certificate in us-east-1, but this ` +
          `stack is in ${stackRegion}, so the certificate this construct would create cannot be ` +
          `used. Either (a) create the certificate in a us-east-1 stack and pass it as the ` +
          `\`certificate\` prop, or (b) deploy this stack in us-east-1. See ` +
          `docs/deploying-to-aws.md.`,
      )
    }

    const certificate =
      props.certificate ??
      new acm.Certificate(this, 'Cert', {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      })

    // ========================================================================
    // CloudFront Distribution
    // ========================================================================

    // Origin: Lambda Function URL secured with Origin Access Control (OAC).
    // CloudFront signs each origin request with SigV4 so the AWS_IAM-protected
    // Function URL only accepts traffic from this distribution — direct hits to
    // the Function URL are rejected (DEP-H2). withOriginAccessControl creates
    // the OAC and grants CloudFront lambda:InvokeFunctionUrl automatically.
    //
    // readTimeout is passed EXPLICITLY. aws-cdk-lib emits it as
    // `originReadTimeout: this.props.readTimeout?.toSeconds()` — omitted
    // entirely when unset, so CloudFront's 30s service default applies and
    // silently halves the CMS Lambda's 60s budget. See the prop's doc comment.
    const readTimeout = props.originReadTimeout ?? DEFAULT_CMS_LAMBDA_TIMEOUT
    if (readTimeout.toSeconds() > MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()) {
      throw new Error(
        `CanopyCmsDistribution: originReadTimeout is ${readTimeout.toSeconds()}s, but CloudFront ` +
          `allows at most ${MAX_CLOUDFRONT_ORIGIN_READ_TIMEOUT.toSeconds()}s without a service-quota ` +
          `increase. Either lower the CMS Lambda's timeout to match, or request a quota increase for ` +
          `"Origin response timeout" and pass the higher value explicitly. Deploying with a shorter ` +
          `origin timeout than the Lambda's would 504 at the edge on requests that actually succeed.`,
      )
    }
    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(props.functionUrl, {
      readTimeout,
    })

    // Cache policy for API/editor routes: AWS's managed CACHING_DISABLED
    // policy. Deploy-proven (deploy-test epic, 2026-07-23): CloudFront
    // rejects ANY non-none cache-key setting on a caching-disabled policy -
    // Authorization in a header allowlist (aws/aws-cdk#16977) but also
    // cookieBehavior/queryStringBehavior `all()` ("The parameter
    // CookieBehavior is invalid for policy with caching disabled"). With
    // TTL 0 the cache key is meaningless anyway; the origin still receives
    // the full viewer request (headers/cookies/query string, minus Host -
    // forwarding Host would break the OAC-signed Function URL) via the
    // ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy on the behavior.
    const noCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED

    // Cache policy for static assets
    const staticCachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(365),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    })

    // CloudFront gives the origin the Function URL's own Host (forwarding the
    // viewer Host would break the OAC SigV4 signature), and Lambda Web Adapter
    // forwards no `x-forwarded-*` headers of its own - so without this
    // function, Clerk/Next derive sign-in redirect URLs from the IAM-authed
    // Function URL host instead of the public domain, and the redirect 403s
    // (direct Function URL hits are rejected). Deploy-proven (deploy-test
    // epic, 2026-07-23): x-forwarded-proto is on CloudFront Functions'
    // DISALLOWED header list - setting it fails every request with 502
    // FunctionValidationError. Only x-forwarded-host is set; proto is
    // unambiguous anyway (viewer-facing CloudFront is HTTPS-only via
    // REDIRECT_TO_HTTPS).
    const forwardedHostFunction = new cloudfront.Function(this, 'ForwardedHostFunction', {
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          "  request.headers['x-forwarded-host'] = { value: request.headers.host.value };",
          '  return request;',
          '}',
        ].join('\n'),
      ),
    })

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [props.domainName],
      certificate,
      defaultBehavior: {
        origin,
        cachePolicy: noCachePolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          {
            function: forwardedHostFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: mergeBehaviors(
        {
          '/_next/static/*': {
            origin,
            cachePolicy: staticCachePolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          },
        },
        props.additionalBehaviors,
      ),
    })

    // ========================================================================
    // DNS Records
    // ========================================================================

    new route53.ARecord(this, 'ARecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    })

    new route53.AaaaRecord(this, 'AaaaRecord', {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    })
  }
}
