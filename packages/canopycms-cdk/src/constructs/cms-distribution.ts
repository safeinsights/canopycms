import { Construct } from 'constructs'
import {
  Duration,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_lambda as lambda,
} from 'aws-cdk-lib'

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
    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(props.functionUrl)

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

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [props.domainName],
      certificate,
      defaultBehavior: {
        origin,
        cachePolicy: noCachePolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      additionalBehaviors: {
        '/_next/static/*': {
          origin,
          cachePolicy: staticCachePolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
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
