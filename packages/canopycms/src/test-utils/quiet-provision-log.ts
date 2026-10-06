import { beforeEach } from 'vitest'

import { setProvisionLogSink } from '../utils/provision-log'

// Node-project setup file: provisioning step lines are unconditional, and most
// suites provision a workspace incidentally. A test that asserts on them
// installs its own sink.
beforeEach(() => {
  setProvisionLogSink(() => {})
})
