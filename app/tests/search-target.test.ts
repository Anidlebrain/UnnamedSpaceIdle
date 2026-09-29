import { describe, expect, it } from 'vitest'
import { nodeConfigSchema, searchConfigSchema } from '../src/shared/schemas'
import { searchForNode, withoutNodeTarget } from '../src/shared/search-target'

const search = searchConfigSchema.parse({
  profile: 'fast',
  goal: 'best',
  simulation_clock: 'offline_fixed_step',
  max_wall_seconds: 240,
  max_simulations: 1_000_000,
  workers: 1,
})
const node = nodeConfigSchema.parse({
  galaxy: 8,
  node: 'B4',
  hazards: [],
  supports: [],
  player_state: { fleet_resources: 100, ships: {} },
  baseline: { enabled: true, formation: {}, loadouts: {} },
  search: { ...search, target_used_fr: 27.3 },
})

describe('per-node Used FR target', () => {
  it('uses the saved normal node target while keeping shared search preferences target-free', () => {
    expect(searchForNode(search, node).target_used_fr).toBe(27.3)
    expect(searchForNode({ ...search, target_used_fr: 12 }, node).target_used_fr).toBe(27.3)
    expect(withoutNodeTarget({ ...search, target_used_fr: 12 })).toEqual(search)
    expect(searchForNode(search, { ...node, search: search }).target_used_fr).toBeUndefined()
  })

  it('omits the target for Boss and rejects invalid target values', () => {
    expect(searchForNode(search, { ...node, boss: { alive: true } }).target_used_fr).toBeUndefined()
    expect(nodeConfigSchema.safeParse({ ...node, search: { ...search, target_used_fr: -1 } }).success).toBe(false)
    expect(nodeConfigSchema.safeParse({ ...node, search: { ...search, target_used_fr: null } }).success).toBe(true)
  })
})
