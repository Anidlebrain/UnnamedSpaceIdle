import { canonicalShipRecord } from './ship-selectors'
import type { CommonConfig, NodeConfig } from './schemas'

export function effectiveShipCounts(node: NodeConfig, common: CommonConfig): Record<string, number> {
  const extra = canonicalShipRecord(node.player_state.ships)
  if (!common.ships) return extra
  const total = { ...canonicalShipRecord(common.ships) }
  for (const [ship, count] of Object.entries(extra)) total[ship] = (total[ship] ?? 0) + count
  return total
}
