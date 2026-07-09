import { describe, it, expect } from 'vitest'
import { App, Stack } from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import {
  aws_ecr as ecr,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_certificatemanager as acm,
} from 'aws-cdk-lib'
import { CanopyCmsService } from './cms-service'
import { CanopyCmsDistribution } from './cms-distribution'

/**
 * Synthesizes a stack with the CMS service (and optionally the distribution) so
 * the emitted CloudFormation template can be asserted against. Guards the
 * Cluster B deploy blockers: Lambda↔EFS egress (DEP-C1) and the CloudFront-only
 * Function URL (DEP-H2).
 */
function synth(withDistribution = false): Template {
  const app = new App()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  const service = new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
  })

  if (withDistribution) {
    new CanopyCmsDistribution(stack, 'Dist', {
      functionUrl: service.functionUrl,
      domainName: 'cms.example.org',
      hostedZoneDomain: 'example.org',
      // Provide overrides so the test never performs a Route53/ACM lookup.
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
  }

  return Template.fromStack(stack)
}

describe('CanopyCmsService deploy blockers', () => {
  it('DEP-C1: the Lambda security group has egress to EFS on 2049', () => {
    const template = synth()
    // The Lambda SG is allowAllOutbound:false, so a dedicated egress rule to the
    // EFS SG on the NFS port must exist or the mount is blocked at request time.
    template.hasResourceProperties(
      'AWS::EC2::SecurityGroupEgress',
      Match.objectLike({
        IpProtocol: 'tcp',
        FromPort: 2049,
        ToPort: 2049,
        GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('LambdaSg'), 'GroupId'] },
      }),
    )
  })

  it('DEP-H2: the Function URL requires AWS_IAM (not public)', () => {
    const template = synth()
    template.hasResourceProperties('AWS::Lambda::Url', Match.objectLike({ AuthType: 'AWS_IAM' }))
    // Guard against regressing to a publicly reachable URL.
    const urls = template.findResources('AWS::Lambda::Url')
    for (const url of Object.values(urls)) {
      expect(url.Properties.AuthType).not.toBe('NONE')
    }
  })
})

describe('CanopyCmsDistribution origin access control', () => {
  it('DEP-H2: CloudFront reaches the Function URL through an OAC that signs with SigV4', () => {
    const template = synth(true)
    template.hasResourceProperties(
      'AWS::CloudFront::OriginAccessControl',
      Match.objectLike({
        OriginAccessControlConfig: Match.objectLike({
          OriginAccessControlOriginType: 'lambda',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        }),
      }),
    )
  })

  it('DEP-H2: only CloudFront may invoke the Function URL', () => {
    const template = synth(true)
    template.hasResourceProperties(
      'AWS::Lambda::Permission',
      Match.objectLike({
        Action: 'lambda:InvokeFunctionUrl',
        Principal: 'cloudfront.amazonaws.com',
      }),
    )
  })
})
