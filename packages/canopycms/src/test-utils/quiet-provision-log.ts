import { beforeEach } from 'vitest'

import { setBranchAccessLogSink } from '../api/branch-access'
import { setProvisionLogSink } from '../utils/provision-log'

// Node-project setup file: provisioning step lines and access-change lines are unconditional,
// and many suites provision a workspace or share a branch incidentally. A test that asserts on
// them installs its own sink.
beforeEach(() => {
  setProvisionLogSink(() => {})
  setBranchAccessLogSink(() => {})
})
