import { canonicalShipRecord } from './ship-selectors'
import type { CommonConfig, NodeConfig } from './schemas'

export function effectiveShipCounts(node: NodeConfig, common: CommonConfig): Record<string, number> {
  const extra = canonicalShipRecord(node.player_state.ships)
  if (!common.ships) return Object.fromEntries(Object.entries(extra).map(([ship, count]) => [ship, Math.max(0, count)]))
  const total = { ...canonicalShipRecord(common.ships) }
  for (const [ship, count] of Object.entries(extra)) total[ship] = Math.max(0, (total[ship] ?? 0) + count)
  return total
}
