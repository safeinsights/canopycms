import { describe, it, expect } from 'vitest'
import type { Construct } from 'constructs'
import { Duration, Stack } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import {
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ecr as ecr,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_s3 as s3,
} from 'aws-cdk-lib'
import { CanopyCmsService } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { CanopyCmsDistribution } from './cms-distribution'
import { AssetSupport, ASSETS_PATH_PATTERN, ASSETS_TRANSFORM_PATH_PATTERN } from './asset-support'
import { EDITOR_PATH_PATTERNS, cloudFrontPathPatternMatches } from './editor-routing'
import { newTestApp } from '../../test-support/test-synth'

const EDITOR_PATTERNS = ['/edit', '/edit/*', '/api/canopycms/*']

interface SynthBehavior {
  PathPattern: string
  TargetOriginId: string
  CachePolicyId?: unknown
  OriginRequestPolicyId?: unknown
  ResponseHeadersPolicyId?: { Ref?: string } | string
  FunctionAssociations?: { EventType: string; FunctionARN: unknown }[]
  Compress?: boolean
  AllowedMethods?: string[]
  ViewerProtocolPolicy?: string
}

interface SynthOrigin {
  Id: string
  CustomOriginConfig?: { OriginReadTimeout?: number }
}

function buildStack(id: string, serviceOverrides: Partial<CanopyCmsServiceProps> = {}) {
  const app = newTestApp()
  const stack = new Stack(app, id, { env: { account: '123456789012', region: 'us-east-1' } })
  const service = new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
    ...serviceOverrides,
  })
  return { stack, service }
}

/** A site distribution of the kind an adopter already owns: S3 default, maybe some behaviors. */
function siteDistribution(
  stack: Stack,
  props: Partial<cloudfront.DistributionProps> = {},
): cloudfront.Distribution {
  const bucket = new s3.Bucket(stack, 'SiteBucket')
  return new cloudfront.Distribution(stack, 'Site', {
    defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket) },
    ...props,
  })
}

function distributionConfig(template: Template, logicalIdPrefix?: string) {
  const dists = template.findResources('AWS::CloudFront::Distribution')
  const entry = Object.entries(dists).find(
    ([id]) => !logicalIdPrefix || id.startsWith(logicalIdPrefix),
  )
  expect(entry, 'distribution should be synthesized').toBeDefined()
  return entry![1].Properties.DistributionConfig as {
    CacheBehaviors?: SynthBehavior[]
    DefaultCacheBehavior: SynthBehavior
    Origins: SynthOrigin[]
  }
}

function headersPolicyConfig(template: Template, behavior: SynthBehavior) {
  const ref = behavior.ResponseHeadersPolicyId
  expect(
    ref,
    `${behavior.PathPattern ?? 'default'} should carry a response headers policy`,
  ).toEqual({
    Ref: expect.any(String),
  })
  const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy')
  const policy = policies[(ref as { Ref: string }).Ref]
  expect(policy, 'referenced policy should exist in the template').toBeDefined()
  return policy.Properties.ResponseHeadersPolicyConfig as {
    SecurityHeadersConfig: Record<string, Record<string, unknown>>
    CustomHeadersConfig?: { Items: { Header: string; Value: string; Override: boolean }[] }
  }
}

/** The headers the editor's behaviors must carry, wherever they are attached. */
function expectEditorHeaders(template: Template, behavior: SynthBehavior) {
  const config = headersPolicyConfig(template, behavior)
  const security = config.SecurityHeadersConfig
  expect(security.ContentSecurityPolicy).toEqual({
    ContentSecurityPolicy: "frame-ancestors 'self'",
    Override: false,
  })
  expect(security.FrameOptions).toEqual({ FrameOption: 'SAMEORIGIN', Override: false })
  expect(security.ContentTypeOptions).toEqual({ Override: true })
  expect(security.StrictTransportSecurity).toEqual(
    expect.objectContaining({ AccessControlMaxAgeSec: 31536000, Override: false }),
  )
  expect(config.CustomHeadersConfig?.Items).toEqual([
    { Header: 'X-Robots-Tag', Value: 'noindex', Override: true },
  ])
  // Cross-Origin-Opener-Policy can break popup OAuth sign-in.
  expect(JSON.stringify(config)).not.toMatch(/Cross-Origin-Opener-Policy/i)
}

describe('cloudFrontPathPatternMatches', () => {
  it.each([
    ['/edit', '/edit', true],
    ['/edit', '/edit/', false],
    ['/edit', '/editorial', false],
    ['/edit/*', '/edit/', true],
    ['/edit/*', '/edit/branch/x', true],
    ['/edit/*', '/edit', false],
    ['/edit/*', '/editorial', false],
    ['/edit/*', '/edit-assets/logo.png', false],
    ['/api/canopycms/*', '/api/canopycms/main/content', true],
    ['/api/canopycms/*', '/api/canopycmsx', false],
    ['/edit*', '/editorial', true],
    ['/edit*', '/edit-assets/logo.png', true],
    ['edit/*', '/edit/x', true],
    ['/ed?t', '/edit', true],
    ['/EDIT', '/edit', false],
    ['/a.b', '/axb', false],
    ['/a*b*c', '/aXbYbc', true],
    ['/a*c', '/abcd', false],
    ['/*/x', '/a/b/x', true],
    ['/edit/**', '/edit/', true],
  ])('%s matching %s is %s', (pattern, path, expected) => {
    expect(cloudFrontPathPatternMatches(pattern, path)).toBe(expected)
  })

  it('the editor patterns cover the editor and nothing that merely starts with /edit', () => {
    const covered = (path: string) =>
      EDITOR_PATH_PATTERNS.some((pattern) => cloudFrontPathPatternMatches(pattern, path))
    for (const path of ['/edit', '/edit/', '/edit/x', '/api/canopycms/branches']) {
      expect(covered(path), path).toBe(true)
    }
    for (const path of ['/editorial', '/edit-assets/logo.png', '/editor', '/api/other']) {
      expect(covered(path), path).toBe(false)
    }
  })
})

describe('CanopyCmsService.attachTo', () => {
  it('attaches exactly /edit, /edit/*, /api/canopycms/* after the existing behaviors, in that order', () => {
    const { stack, service } = buildStack('AttachOrderStack')
    const site = siteDistribution(stack, {
      additionalBehaviors: {
        '/docs/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(new s3.Bucket(stack, 'Docs')),
        },
      },
    })
    service.attachTo(site)

    const patterns = distributionConfig(Template.fromStack(stack)).CacheBehaviors!.map(
      (b) => b.PathPattern,
    )
    expect(EDITOR_PATH_PATTERNS).toEqual(EDITOR_PATTERNS)
    expect(patterns).toEqual(['/docs/*', ...EDITOR_PATTERNS])
    expect(patterns).not.toContain('/edit*')
  })

  it('routes every editor behavior to an OAC Function URL origin whose read timeout is the Lambda timeout', () => {
    const { stack, service } = buildStack('AttachTimeoutStack', { timeout: Duration.seconds(45) })
    service.attachTo(siteDistribution(stack))

    const config = distributionConfig(Template.fromStack(stack))
    const editorBehaviors = config.CacheBehaviors!.filter((b) =>
      EDITOR_PATTERNS.includes(b.PathPattern),
    )
    expect(editorBehaviors).toHaveLength(3)
    const originIds = new Set(editorBehaviors.map((b) => b.TargetOriginId))
    expect(originIds.size).toBe(1)
    const origin = config.Origins.find((o) => originIds.has(o.Id))
    expect(origin?.CustomOriginConfig?.OriginReadTimeout).toBe(45)
  })

  it('gives each editor behavior the policies CanopyCmsDistribution uses for the Lambda', () => {
    const { stack, service } = buildStack('AttachPoliciesStack')
    service.attachTo(siteDistribution(stack))
    const template = Template.fromStack(stack)

    for (const behavior of distributionConfig(template).CacheBehaviors!) {
      // Managed CachingDisabled + AllViewerExceptHostHeader.
      expect(behavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
      expect(behavior.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac')
      expect(behavior.AllowedMethods).toEqual(
        expect.arrayContaining(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']),
      )
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https')
      expect(behavior.FunctionAssociations).toEqual([
        { EventType: 'viewer-request', FunctionARN: expect.anything() },
      ])
      expectEditorHeaders(template, behavior)
    }

    const codes = Object.values(template.findResources('AWS::CloudFront::Function')).map(
      (fn) => fn.Properties.FunctionCode as string,
    )
    expect(codes).toHaveLength(1)
    expect(codes[0]).toContain('x-forwarded-host')
    expect(codes[0]).not.toContain('x-forwarded-proto')
  })

  it('uses a caller viewerRequestFunction instead of its own x-forwarded-host function', () => {
    const { stack, service } = buildStack('AttachViewerFnStack')
    const fn = new cloudfront.Function(stack, 'Mine', {
      code: cloudfront.FunctionCode.fromInline('function handler(e){return e.request}'),
    })
    service.attachTo(siteDistribution(stack), { viewerRequestFunction: fn })
    const template = Template.fromStack(stack)

    expect(template.findResources('AWS::CloudFront::Function')).toEqual({
      [stack.getLogicalId(fn.node.defaultChild as cloudfront.CfnFunction)]: expect.anything(),
    })
    for (const behavior of distributionConfig(template).CacheBehaviors!) {
      expect(behavior.FunctionAssociations).toEqual([
        {
          EventType: 'viewer-request',
          FunctionARN: { 'Fn::GetAtt': [expect.stringMatching(/^Mine/), 'FunctionARN'] },
        },
      ])
    }
  })

  it('merges behaviorOverrides into all three behaviors, ignoring undefined values', () => {
    const { stack, service } = buildStack('AttachOverridesStack')
    service.attachTo(siteDistribution(stack), {
      behaviorOverrides: { compress: false, viewerProtocolPolicy: undefined },
    })

    const behaviors = distributionConfig(Template.fromStack(stack)).CacheBehaviors!
    expect(behaviors).toHaveLength(3)
    for (const behavior of behaviors) {
      expect(behavior.Compress).toBe(false)
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https')
    }
  })

  it('lets behaviorOverrides replace the response headers policy', () => {
    const { stack, service } = buildStack('AttachHeadersOverrideStack')
    service.attachTo(siteDistribution(stack), {
      behaviorOverrides: {
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
    })
    const template = Template.fromStack(stack)
    for (const behavior of distributionConfig(template).CacheBehaviors!) {
      expect(behavior.ResponseHeadersPolicyId).toBe('67f7725c-6f97-4210-82d7-5512b31e9d03')
    }
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0)
  })

  it('creates no forwarded-host function when behaviorOverrides supplies the associations', () => {
    const { stack, service } = buildStack('AttachOverrideFnStack')
    const fn = new cloudfront.Function(stack, 'Mine', {
      code: cloudfront.FunctionCode.fromInline('function handler(e){return e.request}'),
    })
    service.attachTo(siteDistribution(stack), {
      behaviorOverrides: {
        functionAssociations: [
          { function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
    })
    const template = Template.fromStack(stack)
    expect(Object.keys(template.findResources('AWS::CloudFront::Function'))).toEqual([
      stack.getLogicalId(fn.node.defaultChild as cloudfront.CfnFunction),
    ])
    for (const behavior of distributionConfig(template).CacheBehaviors!) {
      expect(behavior.FunctionAssociations).toHaveLength(1)
    }
  })

  it('refuses viewerRequestFunction together with behaviorOverrides.functionAssociations', () => {
    const { stack, service } = buildStack('AttachBothFnStack')
    const fn = new cloudfront.Function(stack, 'Mine', {
      code: cloudfront.FunctionCode.fromInline('function handler(e){return e.request}'),
    })
    expect(() =>
      service.attachTo(siteDistribution(stack), {
        viewerRequestFunction: fn,
        behaviorOverrides: {
          functionAssociations: [
            { function: fn, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
          ],
        },
      }),
    ).toThrow(/viewerRequestFunction.*functionAssociations/)
  })

  it('refuses a second attachTo on the same distribution', () => {
    const { stack, service } = buildStack('AttachTwiceStack')
    const site = siteDistribution(stack)
    service.attachTo(site)
    expect(() => service.attachTo(site)).toThrow(/already called for this distribution/)
  })

  it('refuses a Lambda timeout CloudFront cannot match', () => {
    const { stack, service } = buildStack('AttachTooLongStack', { timeout: Duration.seconds(90) })
    expect(() => service.attachTo(siteDistribution(stack))).toThrow(/service-quota increase/)
  })

  it.each([
    ['/edit*', /'\/edit\*'.*'\/edit'/],
    ['edit/*', /'edit\/\*'.*'\/edit\/\*'/],
    ['/api/*', /'\/api\/\*'.*'\/api\/canopycms\/\*'/],
  ])('fails synth when an earlier behavior %s shadows an editor route', (pattern, message) => {
    const { stack, service } = buildStack(`AttachShadow${pattern.replace(/\W/g, '')}Stack`)
    const fnUrlOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    service.attachTo(
      siteDistribution(stack, { additionalBehaviors: { [pattern]: { origin: fnUrlOrigin } } }),
    )
    expect(() => Template.fromStack(stack)).toThrow(message)
  })

  it('fails synth when the editor pattern itself is already hand-wired', () => {
    const { stack, service } = buildStack('AttachDuplicateStack')
    const fnUrlOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    service.attachTo(
      siteDistribution(stack, { additionalBehaviors: { '/edit': { origin: fnUrlOrigin } } }),
    )
    expect(() => Template.fromStack(stack)).toThrow(/'\/edit' behavior is listed before/)
  })

  it('attaches to a distribution in another stack', () => {
    const { stack, service } = buildStack('AttachServiceStack')
    const siteStack = new Stack(stack.node.scope as Construct, 'AttachSiteStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    service.attachTo(
      siteDistribution(siteStack, {
        errorResponses: [
          { httpStatus: 404, responsePagePath: '/404.html', responseHttpStatus: 404 },
        ],
      }),
    )
    const patterns = distributionConfig(Template.fromStack(siteStack)).CacheBehaviors!.map(
      (b) => b.PathPattern,
    )
    expect(patterns).toEqual(EDITOR_PATTERNS)
  })

  it('does not flag a behavior that only shares the /edit prefix', () => {
    const { stack, service } = buildStack('AttachLaterStack')
    const site = siteDistribution(stack)
    service.attachTo(site)
    site.addBehavior(
      '/edit-assets/*',
      origins.S3BucketOrigin.withOriginAccessControl(new s3.Bucket(stack, 'More')),
    )
    expect(() => Template.fromStack(stack)).not.toThrow()
  })

  it('composes with AssetSupport.attachTo in either order', () => {
    const { stack, service } = buildStack('AttachWithAssetsStack')
    const assetSupport = new AssetSupport(stack, 'Assets', {
      editorOrigins: ['https://site.example.org'],
      requireDeployableBundle: false,
    })
    const site = siteDistribution(stack)
    service.attachTo(site)
    assetSupport.attachTo(site)

    const patterns = distributionConfig(Template.fromStack(stack)).CacheBehaviors!.map(
      (b) => b.PathPattern,
    )
    expect(patterns).toEqual([
      ...EDITOR_PATTERNS,
      ASSETS_TRANSFORM_PATH_PATTERN,
      ASSETS_PATH_PATTERN,
    ])
  })

  it('warns when the distribution rewrites error responses, since that rewrites the API too', () => {
    const { stack, service } = buildStack('AttachErrorResponsesStack')
    service.attachTo(
      siteDistribution(stack, {
        errorResponses: [
          { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html' },
        ],
      }),
    )
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('404.*distribution-wide'))
  })

  it('does not warn for a TTL-only error response, which rewrites nothing', () => {
    const { stack, service } = buildStack('AttachTtlOnlyStack')
    service.attachTo(
      siteDistribution(stack, { errorResponses: [{ httpStatus: 503, ttl: Duration.seconds(0) }] }),
    )
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('distribution-wide'))
  })
})

describe('CanopyCmsService.attachTo: editorAssetPrefix', () => {
  it('adds a long-cached /<prefix>/* behavior on the same Lambda origin, after the editor routes', () => {
    const { stack, service } = buildStack('PrefixStack')
    service.attachTo(siteDistribution(stack), { editorAssetPrefix: '/edit-assets' })
    const template = Template.fromStack(stack)
    const behaviors = distributionConfig(template).CacheBehaviors!

    expect(behaviors.map((b) => b.PathPattern)).toEqual([...EDITOR_PATTERNS, '/edit-assets/*'])
    const prefixed = behaviors[3]
    expect(prefixed.TargetOriginId).toBe(behaviors[0].TargetOriginId)
    expect(prefixed.FunctionAssociations).toBeUndefined()
    expect(prefixed.ViewerProtocolPolicy).toBe('redirect-to-https')
    // Omitted means CloudFront's default, GET and HEAD.
    expect(prefixed.AllowedMethods).toBeUndefined()
    expect(prefixed.ResponseHeadersPolicyId).toEqual(behaviors[0].ResponseHeadersPolicyId)
    const policyRef = (prefixed.CachePolicyId as { Ref?: string }).Ref
    expect(policyRef, 'a custom cache policy, not a managed id').toEqual(expect.any(String))
    const cacheConfig = template.findResources('AWS::CloudFront::CachePolicy')[policyRef!]
      .Properties.CachePolicyConfig
    expect(cacheConfig.MinTTL).toBe(31536000)
    expect(cacheConfig.DefaultTTL).toBe(31536000)
  })

  it('does not apply behaviorOverrides to the asset behavior', () => {
    const { stack, service } = buildStack('PrefixOverridesStack')
    service.attachTo(siteDistribution(stack), {
      editorAssetPrefix: '/edit-assets',
      behaviorOverrides: { allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS },
    })
    const behaviors = distributionConfig(Template.fromStack(stack)).CacheBehaviors!
    expect(behaviors[0].AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS'])
    expect(behaviors[3].AllowedMethods).toBeUndefined()
  })

  it.each([
    ['edit-assets', /start with '\/'/],
    ['/edit-assets/', /trailing '\/'/],
    ['/', /start with '\/'/],
    ['/edit*', /\* or \?/],
    ['/edit', /overlaps/],
    ['/edit/assets', /overlaps/],
    ['/api/canopycms/static', /overlaps/],
    ['/api', /overlaps/],
    ['/_next', /overlaps/],
    ['/_next/static', /overlaps/],
    ['/assets', /overlaps/],
    ['/assets/t', /overlaps/],
  ])('refuses editorAssetPrefix %s', (prefix, message) => {
    const { stack, service } = buildStack(`PrefixBad${prefix.replace(/[^A-Za-z0-9]/g, '')}Stack`)
    expect(() => service.attachTo(siteDistribution(stack), { editorAssetPrefix: prefix })).toThrow(
      message,
    )
  })

  it('fails synth when an earlier behavior shadows the asset prefix', () => {
    const { stack, service } = buildStack('PrefixShadowStack')
    const fnUrlOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
    service.attachTo(
      siteDistribution(stack, {
        additionalBehaviors: { '/edit-assets/*': { origin: fnUrlOrigin } },
      }),
      { editorAssetPrefix: '/edit-assets' },
    )
    expect(() => Template.fromStack(stack)).toThrow(/'\/edit-assets\/\*' behavior is listed before/)
  })
})

describe('CanopyCmsService.attachTo: previewPrefix', () => {
  it('routes <prefix> and <prefix>/* to the Lambda with the editor-route options', () => {
    const { stack, service } = buildStack('PreviewStack')
    service.attachTo(siteDistribution(stack), {
      previewPrefix: '/preview',
      behaviorOverrides: { compress: false },
    })
    const template = Template.fromStack(stack)
    const behaviors = distributionConfig(template).CacheBehaviors!

    expect(behaviors.map((b) => b.PathPattern)).toEqual([
      ...EDITOR_PATTERNS,
      '/preview',
      '/preview/*',
    ])
    const [edit] = behaviors
    for (const preview of behaviors.slice(3)) {
      expect(preview.TargetOriginId).toBe(edit.TargetOriginId)
      expect(preview.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
      expect(preview.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac')
      expect(preview.FunctionAssociations).toEqual(edit.FunctionAssociations)
      expect(preview.Compress).toBe(false)
      expectEditorHeaders(template, preview)
    }
  })

  it('places the preview routes before the asset prefix when both are set', () => {
    const { stack, service } = buildStack('PreviewAndAssetsStack')
    service.attachTo(siteDistribution(stack), {
      previewPrefix: '/preview',
      editorAssetPrefix: '/edit-assets',
    })
    const patterns = distributionConfig(Template.fromStack(stack)).CacheBehaviors!.map(
      (b) => b.PathPattern,
    )
    expect(patterns).toEqual([...EDITOR_PATTERNS, '/preview', '/preview/*', '/edit-assets/*'])
  })

  it.each([
    ['preview', undefined, /start with '\/'/],
    ['https://site.example.org/preview', undefined, /start with '\/'/],
    ['/preview/', undefined, /trailing '\/'/],
    ['/pre*', undefined, /\* or \?/],
    ['/edit', undefined, /overlaps/],
    ['/edit/preview', undefined, /overlaps/],
    ['/api', undefined, /overlaps/],
    ['/_next', undefined, /overlaps/],
    ['/assets', undefined, /overlaps/],
    ['/edit-assets', '/edit-assets', /overlaps '\/edit-assets\/\*'/],
    ['/edit-assets/preview', '/edit-assets', /overlaps/],
    ['/p', '/p/assets', /overlaps/],
  ])('refuses previewPrefix %s (asset prefix %s)', (previewPrefix, editorAssetPrefix, message) => {
    const { stack, service } = buildStack(
      `PreviewBad${previewPrefix.replace(/[^A-Za-z0-9]/g, '')}${String(editorAssetPrefix).replace(/[^A-Za-z0-9]/g, '')}Stack`,
    )
    expect(() =>
      service.attachTo(siteDistribution(stack), { previewPrefix, editorAssetPrefix }),
    ).toThrow(message)
  })

  it('names the option in its error', () => {
    const { stack, service } = buildStack('PreviewNameStack')
    expect(() => service.attachTo(siteDistribution(stack), { previewPrefix: 'preview' })).toThrow(
      /previewPrefix 'preview'/,
    )
  })

  it.each(['/preview*', '/preview'])(
    'fails synth when an earlier %s behavior shadows the preview route',
    (pattern) => {
      const { stack, service } = buildStack(`PreviewShadow${pattern.replace(/\W/g, '')}Stack`)
      const fnUrlOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(service.functionUrl)
      service.attachTo(
        siteDistribution(stack, { additionalBehaviors: { [pattern]: { origin: fnUrlOrigin } } }),
        { previewPrefix: '/preview' },
      )
      expect(() => Template.fromStack(stack)).toThrow(
        /behavior is listed before the editor's '\/preview/,
      )
    },
  )
})

describe('CanopyCmsDistribution: editor response headers', () => {
  it('puts the editor headers policy on its default and /_next/static/* behaviors', () => {
    const { stack, service } = buildStack('DistHeadersStack')
    new CanopyCmsDistribution(stack, 'Dist', {
      functionUrl: service.functionUrl,
      domainName: 'cms.example.org',
      hostedZoneDomain: 'example.org',
      hostedZone: route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
        hostedZoneId: 'Z123456789',
        zoneName: 'example.org',
      }),
      certificate: acm.Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      ),
    })
    const template = Template.fromStack(stack)
    const config = distributionConfig(template)

    expectEditorHeaders(template, config.DefaultCacheBehavior)
    const nextStatic = config.CacheBehaviors!.find((b) => b.PathPattern === '/_next/static/*')
    expect(nextStatic).toBeDefined()
    expectEditorHeaders(template, nextStatic!)
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 1)
  })
})
