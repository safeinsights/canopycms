/**
 * The worker-down alarm (`alarmTopic`): a metric filter on the worker's
 * per-cycle git-sync log line, and an alarm that fires when that line has not
 * appeared for 30 minutes. The last describe runs the real `syncGit` and checks
 * that the line the filter counts is the line the worker writes.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Stack } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { aws_ecr as ecr, aws_lambda as lambda, aws_sns as sns } from 'aws-cdk-lib'
import { CmsWorker } from 'canopycms/worker/cms-worker'
import { mockConsole, useLocalGitHubGateway } from 'canopycms/test-utils'
import type { MockConsole } from 'canopycms/test-utils'

import { CanopyCmsService } from './cms-service'
import { newTestApp } from '../../test-support/test-synth'
import { WORKER_SYNC_LOG_PHRASE } from './worker-lifecycle'

function synth(withTopic: boolean, nesting = 0): Template {
  const app = newTestApp()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  let scope: Construct = stack
  for (let i = 0; i < nesting; i++) scope = new Construct(scope, `Level${i}${'x'.repeat(40)}`)
  new CanopyCmsService(scope, 'Cms', {
    cmsDockerImage: lambda.DockerImageCode.fromEcr(
      ecr.Repository.fromRepositoryName(stack, 'Repo', 'cms'),
    ),
    githubOwner: 'acme',
    githubRepo: 'site',
    ...(withTopic ? { alarmTopic: new sns.Topic(stack, 'Alerts') } : {}),
  })
  return Template.fromStack(stack)
}

/** The resource whose logical id starts with `idPrefix` (CDK appends a hash). */
function resourceById(template: Template, type: string, idPrefix: string): Record<string, unknown> {
  const matches = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(`Cms${idPrefix}`),
  )
  expect(matches).toHaveLength(1)
  return matches[0][1].Properties as Record<string, unknown>
}

function expectAlarmCountsFilter(template: Template, filterId: string, alarmId: string): void {
  const filter = resourceById(template, 'AWS::Logs::MetricFilter', filterId) as {
    MetricTransformations: Array<{ MetricName: string }>
  }
  const alarm = resourceById(template, 'AWS::CloudWatch::Alarm', alarmId)
  expect(alarm.MetricName).toBe(filter.MetricTransformations[0].MetricName)
}

describe('alarmTopic', () => {
  it('creates no metric filter, alarm, or action without a topic', () => {
    const template = synth(false)
    template.resourceCountIs('AWS::Logs::MetricFilter', 0)
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0)
  })

  it('counts the worker per-cycle sync line in the worker log group', () => {
    const template = synth(true)
    template.resourceCountIs('AWS::Logs::MetricFilter', 2)
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      LogGroupName: { Ref: Match.stringLikeRegexp('CmsWorkerLogs') },
      FilterPattern: `"${WORKER_SYNC_LOG_PHRASE}"`,
      MetricTransformations: [
        {
          MetricNamespace: 'CanopyCMS',
          MetricName: Match.stringLikeRegexp('^WorkerGitSyncCycles'),
          MetricValue: '1',
        },
      ],
    })
  })

  it("keeps the metric name within CloudWatch's 255 characters under a deep construct path", () => {
    // A path this deep also gives every resource a Name tag past CloudFormation's 256
    // characters, which synth reports as a template-validation warning.
    const consoleSpy = mockConsole()
    let filters: ReturnType<Template['findResources']>
    try {
      filters = synth(true, 8).findResources('AWS::Logs::MetricFilter')
      expect(consoleSpy).toHaveErrored('Template validation found issues')
    } finally {
      consoleSpy.restore()
    }
    const names = Object.values(filters).map(
      (filter) =>
        (filter.Properties as { MetricTransformations: Array<{ MetricName: string }> })
          .MetricTransformations[0].MetricName,
    )
    expect(names).toHaveLength(2)
    for (const name of names) expect(name.length).toBeLessThanOrEqual(255)
  })

  it('alarms when 3 consecutive 10-minute periods have no sync, missing data included', () => {
    const template = synth(true)
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2)
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'CanopyCMS',
      MetricName: Match.stringLikeRegexp('^WorkerGitSyncCycles'),
      Statistic: 'Sum',
      Period: 600,
      Threshold: 1,
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: 'breaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('Alerts') }],
      OKActions: [{ Ref: Match.stringLikeRegexp('Alerts') }],
    })
  })

  it('uses the same metric name in the filter and the alarm', () => {
    expectAlarmCountsFilter(synth(true), 'WorkerSyncCycles', 'WorkerDownAlarm')
  })
})

describe('the unpatched-boot alarm', () => {
  it("counts user data's unpatched line in the worker log group", () => {
    const filter = resourceById(synth(true), 'AWS::Logs::MetricFilter', 'WorkerUnpatchedBoots')
    expect(filter).toMatchObject({
      LogGroupName: { Ref: expect.stringMatching(/CmsWorkerLogs/) },
      FilterPattern: expect.stringMatching(/^"running unpatched on the AMI packages/),
      MetricTransformations: [
        {
          MetricNamespace: 'CanopyCMS',
          MetricName: expect.stringMatching(/^WorkerUnpatchedBoots/),
          MetricValue: '1',
        },
      ],
    })
  })

  it('alarms on one line, notifying the topic of the alarm only', () => {
    const template = synth(true)
    const alarm = resourceById(template, 'AWS::CloudWatch::Alarm', 'WorkerUnpatchedAlarm')
    expect(alarm).toMatchObject({
      Namespace: 'CanopyCMS',
      Statistic: 'Sum',
      Period: 600,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: expect.stringMatching(/Alerts/) }],
    })
    expect(alarm.OKActions).toBeUndefined()
    expectAlarmCountsFilter(template, 'WorkerUnpatchedBoots', 'WorkerUnpatchedAlarm')
  })
})

describe('the line the alarm counts', () => {
  let tmpDir: string
  let consoleSpy: MockConsole

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-down-alarm-'))
    execFileSync('git', ['init', '--bare', path.join(tmpDir, 'remote.git')])
  })

  afterEach(async () => {
    consoleSpy.restore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('is written by the real syncGit() at the start of a cycle', async () => {
    type Internals = { running: boolean }
    const worker = new CmsWorker({
      workspacePath: tmpDir,
      githubOwner: 'test-owner',
      githubRepo: 'test-repo',
      githubToken: 'fake-token',
      baseBranch: 'main',
    })
    const internals = worker as unknown as Internals
    // The fetch fails against a missing remote after the line is logged, which
    // is all this test needs.
    useLocalGitHubGateway(worker, {
      remoteUrl: async () => path.join(tmpDir, 'no-such-github.git'),
    })
    internals.running = true

    await expect(worker.syncGit()).rejects.toThrow()

    const lines = consoleSpy.all().log
    expect(lines.filter((line) => line.includes(WORKER_SYNC_LOG_PHRASE))).toHaveLength(1)
  })
})
