import type { FleetManagerApi } from '../shared/contracts'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'

declare global { interface Window { [FLEET_MANAGER_BRIDGE_NAME]?: FleetManagerApi } }
