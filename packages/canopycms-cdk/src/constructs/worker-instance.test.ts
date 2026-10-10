/**
 * The worker instance: its capacity (`workerCapacity`), the terminating
 * lifecycle hook its worker completes after draining, the IAM that completion
 * needs, and the systemd lines that let a stop actually drain.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Duration, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { aws_ec2 as ec2, aws_ecr as ecr, aws_lambda as lambda } from 'aws-cdk-lib'

import { CanopyCmsService } from './cms-service'
import type { CanopyCmsServiceProps } from './cms-service'
import { newTestApp } from '../../test-support/test-synth'
import {
  EXIT_DRAINED_FOR_TERMINATION,
  EXIT_WORKER_SELF_STOPPED,
  WORKER_CAPACITY_ENV,
  WORKER_DRAIN_HOOK_NAME,
} from './worker-lifecycle'

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

const onDemand = synth()
const spot = synth({ workerCapacity: { type: 'spot' } })

function launchTemplateData(template: Template): Record<string, unknown> {
  const [lt] = Object.values(template.findResources('AWS::EC2::LaunchTemplate'))
  return (lt.Properties as { LaunchTemplateData: Record<string, unknown> }).LaunchTemplateData
}

function asgProperties(template: Template): Record<string, unknown> {
  const [asg] = Object.values(template.findResources('AWS::AutoScaling::AutoScalingGroup'))
  return asg.Properties as Record<string, unknown>
}

const userData = (template: Template) => JSON.stringify(launchTemplateData(template).UserData)

describe('workerCapacity', () => {
  it('defaults to one on-demand t4g.nano: no spot options, no mixed-instances policy', () => {
    const data = launchTemplateData(onDemand)
    expect(data.InstanceType).toBe('t4g.nano')
    expect(data.InstanceMarketOptions).toBeUndefined()
    const asg = asgProperties(onDemand)
    expect(asg.LaunchTemplate).toBeDefined()
    expect(asg.MixedInstancesPolicy).toBeUndefined()
    expect(userData(onDemand)).not.toContain(WORKER_CAPACITY_ENV)
  })

  it('takes another Graviton on-demand type', () => {
    const template = synth({
      workerCapacity: { type: 'on-demand', instanceType: new ec2.InstanceType('t4g.micro') },
    })
    expect(launchTemplateData(template).InstanceType).toBe('t4g.micro')
  })

  it('opts into spot through a price-capacity-optimized mixed-instances policy', () => {
    expect(launchTemplateData(spot).InstanceMarketOptions).toBeUndefined()
    const asg = asgProperties(spot)
    expect(asg.LaunchTemplate).toBeUndefined()
    expect(asg.CapacityRebalance).toBe(true)
    expect(asg.MixedInstancesPolicy).toMatchObject({
      LaunchTemplate: {
        Overrides: [
          { InstanceType: 't4g.nano' },
          { InstanceType: 't4g.micro' },
          { InstanceType: 't4g.small' },
        ],
      },
      InstancesDistribution: {
        OnDemandBaseCapacity: 0,
        OnDemandPercentageAboveBaseCapacity: 0,
        SpotAllocationStrategy: 'price-capacity-optimized',
      },
    })
    expect(userData(spot)).toContain(`${WORKER_CAPACITY_ENV}=spot`)
  })

  it('passes a spot max price and a capacity-rebalance opt-out through', () => {
    const asg = asgProperties(
      synth({ workerCapacity: { type: 'spot', maxPrice: '0.003', capacityRebalance: false } }),
    )
    expect(asg.CapacityRebalance).toBe(false)
    expect(asg.MixedInstancesPolicy).toMatchObject({
      InstancesDistribution: { SpotMaxPrice: '0.003' },
    })
  })

  it.each([
    ['an x86 on-demand type', { type: 'on-demand', instanceType: new ec2.InstanceType('t3.nano') }],
    [
      'an x86 type among the spot pools',
      {
        type: 'spot',
        instanceTypes: [new ec2.InstanceType('t4g.nano'), new ec2.InstanceType('c7a.medium')],
      },
    ],
  ] as const)('refuses %s', (_label, workerCapacity) => {
    expect(() => synth({ workerCapacity })).toThrow(/not Graviton/)
  })

  it('accepts every Graviton family shape', () => {
    expect(() =>
      synth({
        workerCapacity: {
          type: 'spot',
          instanceTypes: ['a1.medium', 'c7gn.medium', 'm8gd.medium', 'g5g.xlarge'].map(
            (name) => new ec2.InstanceType(name),
          ),
        },
      }),
    ).not.toThrow()
  })

  it('refuses an empty spot pool list and an unusable max price', () => {
    expect(() => synth({ workerCapacity: { type: 'spot', instanceTypes: [] } })).toThrow(
      /at least one instance type/,
    )
    expect(() => synth({ workerCapacity: { type: 'spot', maxPrice: 'cheap' } })).toThrow(
      /maxPrice must be a positive/,
    )
  })

  it('no longer accepts spotMaxPrice', () => {
    // @ts-expect-error -- folded into workerCapacity.spot.maxPrice
    const props: Partial<CanopyCmsServiceProps> = { spotMaxPrice: '0.0042' }
    expect(props).toBeDefined()
  })
})

describe('the worker drain lifecycle hook', () => {
  it.each([
    ['on-demand', onDemand],
    ['spot', spot],
  ])('holds a terminating %s instance for the worker, continuing after 5 minutes', (_l, t) => {
    t.resourceCountIs('AWS::AutoScaling::LifecycleHook', 1)
    t.hasResourceProperties('AWS::AutoScaling::LifecycleHook', {
      LifecycleHookName: WORKER_DRAIN_HOOK_NAME,
      LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
      HeartbeatTimeout: 300,
      DefaultResult: 'CONTINUE',
      NotificationTargetARN: Match.absent(),
      RoleARN: Match.absent(),
    })
  })

  it('takes a heartbeat within its bounds and refuses one outside them', () => {
    synth({ workerTerminationHeartbeat: Duration.minutes(10) }).hasResourceProperties(
      'AWS::AutoScaling::LifecycleHook',
      { HeartbeatTimeout: 600 },
    )
    expect(() => synth({ workerTerminationHeartbeat: Duration.minutes(1) })).toThrow(
      /between 210 and 7200 seconds/,
    )
    expect(() => synth({ workerTerminationHeartbeat: Duration.hours(3) })).toThrow(
      /between 210 and 7200 seconds/,
    )
  })

  it('is created after the group, so an upgrade rolls the old worker before the hook exists', () => {
    const [hook] = Object.values(onDemand.findResources('AWS::AutoScaling::LifecycleHook'))
    const [asgId] = Object.keys(onDemand.findResources('AWS::AutoScaling::AutoScalingGroup'))
    expect(JSON.stringify(hook.Properties)).toContain(asgId)
  })

  // No cycle test: Template.fromStack refuses a template with a dependency
  // cycle, so every synth above would fail if the policy below made one.
  it('lets the worker role complete the hook on its own group only', () => {
    const [asgId] = Object.keys(onDemand.findResources('AWS::AutoScaling::AutoScalingGroup'))
    const policies = Object.values(onDemand.findResources('AWS::IAM::Policy'))
    const statements = policies.flatMap(
      (p) =>
        (p.Properties as { PolicyDocument: { Statement: Array<Record<string, unknown>> } })
          .PolicyDocument.Statement,
    )
    const complete = statements.filter((s) => s.Action === 'autoscaling:CompleteLifecycleAction')
    expect(complete).toHaveLength(1)
    const resource = JSON.stringify(complete[0].Resource)
    expect(resource).toContain('autoScalingGroupName/')
    expect(resource).toContain(asgId)
    expect(statements).toContainEqual(
      expect.objectContaining({
        Action: 'autoscaling:DescribeAutoScalingInstances',
        Resource: '*',
      }),
    )
  })
})

describe('the worker systemd unit drains on stop', () => {
  const drainLines = [
    'KillMode=mixed',
    'TimeoutStopSec=120',
    `RestartPreventExitStatus=${EXIT_DRAINED_FOR_TERMINATION}`,
    `SuccessExitStatus=${EXIT_DRAINED_FOR_TERMINATION}`,
  ]

  it.each(drainLines)('the deployed unit carries %s', (line) => {
    expect(userData(onDemand)).toContain(line)
  })

  it.each(drainLines)('the checked-in copy of the unit carries %s', (line) => {
    expect(checkedInUnit()).toContain(line)
  })

  // A worker that stopped itself exits EXIT_WORKER_SELF_STOPPED and must be
  // restarted: it is in neither exit-status list, and the unit restarts always.
  const units: Array<[string, () => string[]]> = [
    // `userData` is JSON, so the script's newlines are the two characters `\n`.
    ['deployed', () => userData(onDemand).split('\\n')],
    ['checked-in', checkedInUnit],
  ]

  describe.each(units)('the %s unit restarts a worker that stopped itself', (_name, lines) => {
    it('restarts always', () => {
      expect(lines()).toContain('Restart=always')
    })

    it.each(['RestartPreventExitStatus=', 'SuccessExitStatus='])(
      'does not list the self-stop status in %s',
      (key) => {
        const listed = lines().filter((line) => line.startsWith(key))
        expect(listed.length).toBeGreaterThan(0)
        for (const line of listed) {
          expect(line.slice(key.length).split(/\s+/)).not.toContain(
            String(EXIT_WORKER_SELF_STOPPED),
          )
        }
      },
    )
  })
})

function checkedInUnit(): string[] {
  return readFileSync(path.join(__dirname, '../../worker/canopy-worker.service'), 'utf-8').split(
    '\n',
  )
}
