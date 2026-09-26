import { describe, expect, it } from 'vitest'
import { commonConfigSchema, nodeConfigSchema, optimizerConfigSchema } from '../src/shared/schemas'
import { effectiveShipCounts } from '../src/shared/ship-counts'
import { runErrorSummary } from '../src/shared/run-errors'
import { restoreContexts } from '../src/renderer/state-model'
import type { Catalog } from '../src/shared/contracts'
import { resultFormationColumns } from '../src/shared/formation-grid'

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
  it('supports configured formation columns and rejects occupied positions outside the grid', () => {
    const source = {
      galaxy: 6,
      node: 'B46',
      formation_columns: 3,
      player_state: { fleet_resources: 10, ships: { Fighter: 1 } },
      baseline: { enabled: true, formation: { C5: 'Fighter' }, loadouts: {} },
      search: {
        profile: 'fast',
        goal: 'best',
        simulation_clock: 'offline_fixed_step',
        max_wall_seconds: 1,
        max_simulations: 1,
        workers: 1,
      },
    }
    expect(nodeConfigSchema.parse(source).baseline.formation.C5).toBe('Fighter')
    expect(nodeConfigSchema.safeParse({ ...source, formation_columns: 2 }).success).toBe(false)
    expect(
      nodeConfigSchema.safeParse({ ...source, baseline: { ...source.baseline, formation: { C6: 'Fighter' } } }).success,
    ).toBe(false)
    expect(nodeConfigSchema.safeParse({ ...source, formation_columns: 27 }).success).toBe(false)
    expect(resultFormationColumns({ grid_size: [3, 5] }, 2)).toBe(3)
    expect(resultFormationColumns(undefined, 3)).toBe(3)
    expect(resultFormationColumns(undefined)).toBe(2)
  })
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
  it('adds Galaxy ships to Node extras and keeps legacy absolute counts', () => {
    const node = nodeConfigSchema.parse({
      galaxy: 6,
      node: 'B13',
      hazards: [],
      supports: [],
      player_state: { fleet_resources: 190, ships: { Fighter: 0, HeavyCruiser: 1 } },
      baseline: { enabled: true, formation: {}, loadouts: {} },
      search: {
        profile: 'fast',
        goal: 'best',
        simulation_clock: 'offline_fixed_step',
        max_wall_seconds: 1,
        max_simulations: 1,
        workers: 1,
      },
    })
    const common = commonConfigSchema.parse({
      permanent: { damage_scale: 1, health_scale: 1 },
      temporary: { damage_scale: 0, health_scale: 0 },
      ships: { Fighter: 1, Corvette: 2, 'Heavy Cruiser': 0 },
    })
    expect(effectiveShipCounts(node, common)).toEqual({ Fighter: 1, Corvette: 2, HeavyCruiser: 1 })
    expect(effectiveShipCounts(node, { ...common, ships: undefined })).toEqual({ Fighter: 0, HeavyCruiser: 1 })
    expect(() => commonConfigSchema.parse({ ...common, ships: { Fighter: -1 } })).toThrow()
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
