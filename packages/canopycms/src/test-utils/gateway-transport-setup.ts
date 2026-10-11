import { afterEach } from 'vitest'

import { closeServedGateways } from './worker-gateway'

// The `worker-http` project's setup: close the gateways each test served (gatewayUnderTest).
afterEach(closeServedGateways)
