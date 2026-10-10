/**
 * `workerCode: { source: 'parameter' }`: the worker bundle a parameter-only
 * change set can roll, and the deterministic bundle the npm package ships for it.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { aws_ecr as ecr, aws_lambda as lambda } from 'aws-cdk-lib'

import { CanopyCmsService } from './cms-service'
import { WORKER_CONTRACT_ENV, WORKER_CONTRACT_VERSION } from './worker-lifecycle'
import type { CanopyCmsServiceProps } from './cms-service'
import { newTestApp } from '../../test-support/test-synth'

const PACKAGE_ROOT = path.join(__dirname, '../..')
const BUNDLE = path.join(PACKAGE_ROOT, 'worker/dist/index.js')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function synth(overrides: Partial<CanopyCmsServiceProps> = {}): Template {
  const app = newTestApp()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  new CanopyCmsService(stack, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
    ...overrides,
  })
  return Template.fromStack(stack)
}

const assetMode = synth()
const parameterMode = synth({ workerCode: { source: 'parameter' } })

function only(resources: Record<string, { Properties?: unknown }>) {
  const entries = Object.entries(resources)
  expect(entries).toHaveLength(1)
  return { id: entries[0][0], props: (entries[0][1].Properties ?? {}) as Record<string, unknown> }
}

/** The sha256 parameter's logical id (the template's only String parameter). */
function shaParameterId(t: Template): string {
  const ids = Object.entries(t.toJSON().Parameters ?? {})
    .filter(([, p]) => (p as { Type: string }).Type === 'String')
    .map(([id]) => id)
  expect(ids).toHaveLength(1)
  return ids[0]
}

/**
 * User data with each `Ref` rendered `<LogicalId>`, and each `Fn::If` taking
 * the branch `conditions` names for it.
 */
function userData(t: Template, conditions: Record<string, boolean> = {}): string[] {
  const render = (node: unknown): string => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(render).join('')
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (typeof obj.Ref === 'string') return `<${obj.Ref}>`
      const join = obj['Fn::Join']
      if (Array.isArray(join)) {
        const [sep, parts] = join as [string, unknown[]]
        return parts.map(render).join(sep)
      }
      const cond = obj['Fn::If']
      if (Array.isArray(cond)) {
        const [name, whenTrue, whenFalse] = cond as [string, unknown, unknown]
        if (!(name in conditions)) throw new Error(`userData: no branch given for ${name}`)
        return render(conditions[name] ? whenTrue : whenFalse)
      }
      if ('Fn::Base64' in obj) return render(obj['Fn::Base64'])
    }
    throw new Error(`userData: unhandled node ${JSON.stringify(node)}`)
  }
  const lt = only(t.findResources('AWS::EC2::LaunchTemplate')).props
  return render((lt.LaunchTemplateData as { UserData: unknown }).UserData).split('\n')
}

const conditionId = (t: Template) => {
  const ids = Object.keys(t.toJSON().Conditions ?? {})
  expect(ids).toHaveLength(1)
  return ids[0]
}

const bundleLines = (lines: string[]) => ({
  copy: lines.find((l) => l.includes('aws s3 cp s3://')),
  check: lines.find((l) => l.includes('sha256sum -c -')),
})

describe("workerCode: { source: 'asset' } (the default)", () => {
  it('adds no parameter, condition, bucket or output', () => {
    const types = Object.values(assetMode.toJSON().Parameters ?? {}).map(
      (p) => (p as { Type: string }).Type,
    )
    // Only the SSM-backed ones CDK adds (the AMI, the bootstrap version).
    expect(types.length).toBeGreaterThan(0)
    expect(types.every((type) => type.startsWith('AWS::SSM::Parameter::Value<'))).toBe(true)
    expect(assetMode.toJSON().Conditions).toBeUndefined()
    expect(assetMode.findResources('AWS::S3::Bucket')).toEqual({})
    expect(assetMode.toJSON().Outputs).toBeUndefined()
  })
})

describe("workerCode: { source: 'parameter' }", () => {
  const paramId = shaParameterId(parameterMode)
  const bucket = only(parameterMode.findResources('AWS::S3::Bucket'))

  it('takes the bundle sha256 as a parameter, empty by default', () => {
    expect(parameterMode.toJSON().Parameters[paramId]).toMatchObject({
      Type: 'String',
      Default: '',
      AllowedPattern: '^([0-9a-f]{64})?$',
    })
  })

  it('outputs the parameter logical id and the bucket, for a CI change-set gate', () => {
    const outputs = Object.values(parameterMode.toJSON().Outputs ?? {}) as Array<{ Value: unknown }>
    expect(outputs.map((o) => o.Value)).toEqual(
      expect.arrayContaining([paramId, { Ref: bucket.id }]),
    )
  })

  it("outputs the template's worker contract version, for the same gate", () => {
    const outputs = Object.entries(parameterMode.toJSON().Outputs ?? {}) as Array<
      [string, { Value: unknown }]
    >
    const contract = outputs.filter(([id]) => id.includes('WorkerContract'))
    expect(contract).toHaveLength(1)
    expect(contract[0][1].Value).toBe(String(WORKER_CONTRACT_VERSION))
  })

  it('runs the bundle keyed by the parameter, checked against the same value', () => {
    const { copy, check } = bundleLines(
      userData(parameterMode, { [conditionId(parameterMode)]: true }),
    )
    expect(copy).toBe(
      `retry 'worker bundle download' aws s3 cp s3://<${bucket.id}>/canopy-worker/<${paramId}>.js /tmp/canopy-worker.js`,
    )
    expect(check).toBe(`echo '<${paramId}>  /tmp/canopy-worker.js' | sha256sum -c -`)
  })

  it("falls back to the template's own asset while the parameter is empty", () => {
    expect(parameterMode.toJSON().Conditions[conditionId(parameterMode)]).toEqual({
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: paramId }, ''] }],
    })
    const fallback = bundleLines(userData(parameterMode, { [conditionId(parameterMode)]: false }))
    expect(fallback).toEqual(bundleLines(userData(assetMode)))
    expect(fallback.check).toContain(sha256(readFileSync(BUNDLE)))
  })

  it('keeps bundles in a versioned, private, TLS-only bucket nobody may delete from', () => {
    expect(parameterMode.toJSON().Resources[bucket.id].DeletionPolicy).toBe('Retain')
    expect(bucket.props).toMatchObject({
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    })
    // An overwrite of `<sha>.js` leaves a version that is the same bytes or
    // wrong ones; nothing a launch template names is ever noncurrent.
    expect(bucket.props.LifecycleConfiguration).toEqual({
      Rules: [{ NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: 'Enabled' }],
    })
    const statements = (
      only(parameterMode.findResources('AWS::S3::BucketPolicy')).props.PolicyDocument as {
        Statement: Array<Record<string, unknown>>
      }
    ).Statement
    expect(statements).toContainEqual(
      expect.objectContaining({
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      }),
    )
    expect(statements).toContainEqual(
      expect.objectContaining({
        Effect: 'Deny',
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    )
  })

  it('lets the worker read bundles in that bucket and its own asset, nothing else', () => {
    const roleId = only(
      parameterMode.findResources('AWS::IAM::Role', {
        Properties: { Description: 'CanopyCMS EC2 Worker role' },
      }),
    ).id
    const statements = Object.values(parameterMode.findResources('AWS::IAM::Policy'))
      .filter((p) => JSON.stringify((p.Properties as { Roles: unknown }).Roles).includes(roleId))
      .flatMap(
        (p) =>
          (p.Properties as { PolicyDocument: { Statement: Array<Record<string, unknown>> } })
            .PolicyDocument.Statement,
      )
      .filter((s) => JSON.stringify(s.Action).includes('s3:'))
    expect(statements).toHaveLength(1)
    expect(statements[0].Action).toBe('s3:GetObject')
    const resources = JSON.stringify(statements[0].Resource)
    expect(resources).toContain(`{"Fn::GetAtt":["${bucket.id}","Arn"]},"/canopy-worker/*"`)
    const { copy } = bundleLines(userData(assetMode))
    const assetKey = /\/([0-9a-f]{64}\.js) /.exec(copy ?? '')?.[1]
    expect(assetKey).toBeDefined()
    expect(resources).toContain(`/${assetKey}`)
  })
})

describe('the bundle the npm package ships', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'canopy-worker-bundle-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  /** `build:worker` exactly as package.json has it, writing to `outfile`. */
  function buildTo(outfile: string): Buffer {
    const script = (
      JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>
      }
    ).scripts['build:worker']
    const target = '--outfile=worker/dist/index.js'
    expect(script).toContain(target)
    execFileSync('sh', ['-c', script.replace(target, `--outfile=${outfile}`)], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        PATH: `${path.join(PACKAGE_ROOT, 'node_modules/.bin')}:${process.env.PATH}`,
      },
      stdio: 'pipe',
    })
    return readFileSync(outfile)
  }

  it('is byte-for-byte reproducible', () => {
    const first = buildTo(path.join(scratch, 'a.js'))
    const second = buildTo(path.join(scratch, 'b.js'))
    expect(first.equals(second)).toBe(true)
    expect(first.equals(readFileSync(BUNDLE))).toBe(true)
  }, 60_000)

  it('ships its sha256 beside it, in `sha256sum -c` format', () => {
    expect(readFileSync(`${BUNDLE}.sha256`, 'utf-8')).toBe(
      `${sha256(readFileSync(BUNDLE))}  index.js\n`,
    )
  })

  it('ships the worker contract version it needs beside it', () => {
    expect(readFileSync(`${BUNDLE}.contract`, 'utf-8')).toBe(`${WORKER_CONTRACT_VERSION}\n`)
  })

  it('is in the published files', () => {
    const files = (
      JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
        files: string[]
      }
    ).files
    expect(files).toContain('worker/dist')
  })
})

describe('the worker contract', () => {
  const stamp = `Environment=${WORKER_CONTRACT_ENV}=${WORKER_CONTRACT_VERSION}`

  it.each([
    ['asset', assetMode],
    ['parameter', parameterMode],
  ])('is stamped into the unit %s mode writes', (_mode, t) => {
    const conditions = Object.fromEntries(
      Object.keys(t.toJSON().Conditions ?? {}).map((id) => [id, true]),
    )
    expect(userData(t, conditions)).toContain(stamp)
  })

  it('is stamped into the checked-in unit', () => {
    expect(
      readFileSync(path.join(PACKAGE_ROOT, 'worker/canopy-worker.service'), 'utf-8').split('\n'),
    ).toContain(stamp)
  })
})
