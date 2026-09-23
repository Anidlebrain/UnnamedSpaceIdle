import { describe, expect, it } from 'vitest'
import { nodeConfigSchema, optimizerConfigSchema } from '../src/shared/schemas'
import { runErrorSummary } from '../src/shared/run-errors'
import { restoreContexts } from '../src/renderer/state-model'
import type { Catalog } from '../src/shared/contracts'

const catalog: Catalog = {
  galaxies: [
    {
      id: 'g6',
      nodes: [
        { id: 'B1', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] },
        { id: 'B2', defaultVersion: 'default', versions: [{ id: 'default', name: '默认', isDefault: true }] },
      ],
      commons: [{ id: 'default', name: '默认', isDefault: true }],
      defaultCommon: 'default',
    },
  ],
  templates: [],
}

describe('V1.2 shared contracts', () => {
  it('normalizes ship aliases and rejects conflicting duplicate values', () => {
    const source = {
      galaxy: 6,
      node: 'B1',
      hazards: [],
      supports: [],
      player_state: { fleet_resources: 10, ships: { HeavyCruiser: 2, 'Heavy Cruiser': 2 } },
      baseline: {
        enabled: true,
        formation: { A1: 'Heavy Cruiser' },
        loadouts: { 'Heavy Cruiser': { primary: null, secondary: null } },
      },
      search: {
        profile: 'fast',
        goal: 'best',
        simulation_clock: 'offline_fixed_step',
        max_wall_seconds: 1,
        max_simulations: 1,
        workers: 1,
      },
    }
    const normalized = nodeConfigSchema.parse(source)
    expect(normalized.player_state.ships).toEqual({ HeavyCruiser: 2 })
    expect(normalized.baseline.formation.A1).toBe('HeavyCruiser')
    expect(normalized.baseline.loadouts).toHaveProperty('HeavyCruiser')
    expect(() =>
      nodeConfigSchema.parse({
        ...source,
        player_state: { ...source.player_state, ships: { HeavyCruiser: 2, 'Heavy Cruiser': 3 } },
      }),
    ).toThrow(/冲突/)
  })
  it('normalizes Optimizer public ship-key maps', () => {
    const parsed = optimizerConfigSchema.parse({
      objective: 'normal',
      mode: 'realistic',
      ship_types: ['Heavy Cruiser', 'HeavyCruiser'],
      group_ranges: { 'Heavy Cruiser': { min: 0, max: 1 } },
      allowed_mod_slots: { 'Heavy Cruiser': { primary: [null], secondary: [null] } },
      max_total_groups: 1,
      max_groups_per_ship: { 'Heavy Cruiser': 1 },
      max_simulations: 1,
      max_wall_seconds: 1,
      top_n: 1,
      kill_refine_top_n: 1,
      kill_sequence_max_battles: 1,
    })
    expect(parsed.ship_types).toEqual(['HeavyCruiser'])
    expect(parsed.allowed_mod_slots).toHaveProperty('HeavyCruiser')
  })
  it('classifies raw failures into short Chinese summaries', () => {
    expect(runErrorSummary('BASELINE VALIDATION FAILED')).toBe('基线配置无效')
    expect(runErrorSummary('invalid Hazards B10')).toBe('Hazards 配置无效')
    expect(runErrorSummary('New result is invalid')).toBe('结果文件格式无效')
    expect(runErrorSummary('anything', true)).toBe('搜索被用户中止')
  })
  it('restores page selections and falls back for deleted versions', () => {
    const restored = restoreContexts(catalog, {
      node: { galaxy: 'g6', node: 'B2', version: 'deleted', common: 'default' },
      search: { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' },
      rerunGalaxy: 'g6',
    })
    expect(restored.node).toEqual({ galaxy: 'g6', node: 'B2', version: 'default', common: 'default' })
    expect(restored.search.node).toBe('B1')
    expect(restored.rerunGalaxy).toBe('g6')
  })
})
