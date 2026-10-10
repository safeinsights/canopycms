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
import { mockConsole } from 'canopycms/test-utils'
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

describe('alarmTopic', () => {
  it('creates no metric filter, alarm, or action without a topic', () => {
    const template = synth(false)
    template.resourceCountIs('AWS::Logs::MetricFilter', 0)
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0)
  })

  it('counts the worker per-cycle sync line in the worker log group', () => {
    const template = synth(true)
    template.resourceCountIs('AWS::Logs::MetricFilter', 1)
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
    const filters = synth(true, 8).findResources('AWS::Logs::MetricFilter')
    const names = Object.values(filters).map(
      (filter) =>
        (filter.Properties as { MetricTransformations: Array<{ MetricName: string }> })
          .MetricTransformations[0].MetricName,
    )
    expect(names).toHaveLength(1)
    expect(names[0].length).toBeLessThanOrEqual(255)
  })

  it('alarms when 3 consecutive 10-minute periods have no sync, missing data included', () => {
    const template = synth(true)
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1)
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
    const template = synth(true)
    const [filter] = Object.values(template.findResources('AWS::Logs::MetricFilter'))
    const [alarm] = Object.values(template.findResources('AWS::CloudWatch::Alarm'))
    const filterName = (
      filter.Properties as { MetricTransformations: Array<{ MetricName: string }> }
    ).MetricTransformations[0].MetricName
    expect((alarm.Properties as { MetricName: string }).MetricName).toBe(filterName)
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
    type Internals = { running: boolean; buildGitHubUrl(): Promise<string> }
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
    internals.buildGitHubUrl = async () => path.join(tmpDir, 'no-such-github.git')
    internals.running = true

    await expect(worker.syncGit()).rejects.toThrow()

    const lines = consoleSpy.all().log
    expect(lines.filter((line) => line.includes(WORKER_SYNC_LOG_PHRASE))).toHaveLength(1)
  })
})
