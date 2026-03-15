import { Construct } from 'constructs'
import {
  Duration,
  Fn,
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

    // Extract the domain from the Function URL (https://xxx.lambda-url.region.on.aws)
    const functionUrlDomain = Lazy_extractDomain(props.functionUrl)

    // Origin: Lambda Function URL
    const origin = new origins.HttpOrigin(functionUrlDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    })

    // Cache policy for API/editor routes: no caching, forward all headers
    const noCachePolicy = new cloudfront.CachePolicy(this, 'NoCachePolicy', {
      cachePolicyName: `${id}-no-cache`,
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization', 'Cookie', 'Host'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    })

    // Cache policy for static assets
    const staticCachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
      cachePolicyName: `${id}-static`,
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

/**
 * Extract the domain from a Lambda Function URL.
 * The URL is like https://xxx.lambda-url.region.on.aws/
 * We need just the domain part for CloudFront origin.
 */
function Lazy_extractDomain(functionUrl: lambda.FunctionUrl): string {
  // Function URL is a Token at synth time, so we use Fn.select + Fn.split
  // to extract the domain from the URL: https://xxx.lambda-url.region.on.aws/
  return Fn.select(2, Fn.split('/', functionUrl.url))
}
