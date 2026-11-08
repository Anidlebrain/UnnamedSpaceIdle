import { describe, expect, it } from 'vitest'
import { GALAXY_MOD_DEFINITIONS } from '../src/shared/galaxy-mod-catalog'
import { commonConfigSchema, type NodeConfig, type OptimizerConfig } from '../src/shared/schemas'
import { preserveModSelectorFormat, resolveModSelector, catalogMods } from '../src/shared/mod-catalog'
import {
  commonForGalaxy,
  hasCrf,
  nodeSlotOptions,
  setGalaxyMod,
  TM_MOD,
  validateGalaxyLoadouts,
} from '../src/shared/galaxy-mods'
const common = { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 1, health_scale: 1 } }
describe('0.90 scoped unlocks', () => {
  for (const galaxy of [12, 13]) {
    const mods = GALAXY_MOD_DEFINITIONS.filter(mod => mod.galaxy === galaxy)
    const primary = mods.find(mod => mod.slot === 'primary')!
    const tertiary = mods.find(mod => mod.slot === 'tertiary')!
    it(`G${galaxy} validates, expands, preserves numeric mapping and round trips the stable ID`, () => {
      const legacy = setGalaxyMod(setGalaxyMod(common, primary.id, true), tertiary.id, true)
      const unlocked = { galaxy, travel_mod_unlocked: true }
      const config = {
        allowed_mod_slots: { [primary.ship]: { primary: [null, primary.id, 'ExistingMod'], secondary: [null] } },
      } as unknown as OptimizerConfig
      expect(commonForGalaxy(legacy, `g${galaxy}`).galaxy_mods).toEqual([tertiary.id])
      expect(() => commonForGalaxy(legacy, 'g11')).toThrow(`G${galaxy}`)
      expect(nodeSlotOptions(config, unlocked, primary.ship, 'primary')).toEqual([null, 'ExistingMod', primary.id])
      expect(nodeSlotOptions(config, { galaxy }, primary.ship, 'primary')).toEqual([null, 'ExistingMod'])
      expect(nodeSlotOptions(config, { ...unlocked, galaxy: 11 }, primary.ship, 'primary')).not.toContain(primary.id)
      expect(preserveModSelectorFormat(0, primary.id, config.allowed_mod_slots[primary.ship].primary)).toBe(primary.id)
      const node = { ...unlocked, baseline: { loadouts: { [primary.ship]: { primary: 1 } } } } as unknown as NodeConfig
      expect(() => validateGalaxyLoadouts(node, common, config)).not.toThrow()
      expect(() => validateGalaxyLoadouts({ ...node, travel_mod_unlocked: false }, legacy, config)).toThrow(
        primary.label,
      )
      node.baseline.loadouts[primary.ship] = { primary: null, secondary: primary.id }
      expect(() => validateGalaxyLoadouts(node, common, config)).toThrow(primary.label)
    })
  }
})
describe('Galaxy Mods contract', () => {
  it('defaults old Common to locked and validates supported IDs', () => {
    expect(hasCrf(commonConfigSchema.parse(common), 11)).toBe(false)
    for (const galaxy_mods of [['UnknownMod'], ['CorvetteRapidFire', 'CorvetteRapidFire'], 'CorvetteRapidFire', [1]])
      expect(commonConfigSchema.safeParse({ ...common, galaxy_mods }).success).toBe(false)
    const unlocked = commonForGalaxy({ ...common, galaxy_mods: ['CorvetteRapidFire'] }, 'g11')
    expect(hasCrf(unlocked, 11)).toBe(true)
    expect(hasCrf(unlocked, 10)).toBe(false)
    expect(commonForGalaxy({ ...common, galaxy_mods: [] }, 'g10').galaxy_mods).toEqual([])
  })
})

const optimizer = {
  allowed_mod_slots: {
    Corvette: { primary: [null, 'CorvetteChargeLaserMod', TM_MOD, 'ExistingMod'], secondary: [null, 'ShieldMod'] },
  },
} as unknown as OptimizerConfig
const baseline = (primary: unknown, galaxy = 11) =>
  ({ galaxy, baseline: { loadouts: { Corvette: { primary } } } }) as unknown as NodeConfig
describe('TM travel unlock', () => {
  it('discards legacy Common TM while preserving permanent unlocks and validating IDs', () => {
    const crf = setGalaxyMod(common, 'CorvetteRapidFire', true)
    const both = setGalaxyMod(crf, TM_MOD, true)
    expect(commonForGalaxy(both, 'g11').galaxy_mods).toEqual(['CorvetteRapidFire'])
    expect(setGalaxyMod(both, 'CorvetteRapidFire', false).galaxy_mods).toEqual([TM_MOD])
    expect(setGalaxyMod(both, TM_MOD, false).galaxy_mods).toEqual(['CorvetteRapidFire'])
    expect(commonConfigSchema.safeParse({ ...common, galaxy_mods: [TM_MOD, TM_MOD] }).success).toBe(false)
    expect(() => commonForGalaxy(both, 'g12')).toThrow('仅适用于 G11')
    expect(catalogMods('Corvette', 'primary').map(mod => mod.id)).not.toContain(TM_MOD)
  })
  it('filters or appends TM without moving the original numeric selectors', () => {
    const unlocked = { galaxy: 11, travel_mod_unlocked: true }
    expect(nodeSlotOptions(optimizer, { galaxy: 11 }, 'Corvette', 'primary')).toEqual([
      null,
      'CorvetteChargeLaserMod',
      'ExistingMod',
    ])
    expect(nodeSlotOptions(optimizer, unlocked, 'Corvette', 'primary')).toEqual([
      null,
      'CorvetteChargeLaserMod',
      'ExistingMod',
      TM_MOD,
    ])
    expect(nodeSlotOptions(optimizer, { ...unlocked, galaxy: 10 }, 'Corvette', 'primary')).not.toContain(TM_MOD)
    const original = optimizer.allowed_mod_slots.Corvette.primary
    expect(resolveModSelector(3, original)).toBe('ExistingMod')
    expect(resolveModSelector('2', original)).toBe(TM_MOD)
    expect(preserveModSelectorFormat(3, TM_MOD, original)).toBe(TM_MOD)
    expect(preserveModSelectorFormat('3', TM_MOD, original)).toBe(TM_MOD)
    expect(preserveModSelectorFormat(0, 'ExistingMod', original)).toBe(3)
    expect(preserveModSelectorFormat('0', 'ExistingMod', original)).toBe('3')
    expect(optimizer.allowed_mod_slots.Corvette.primary).toEqual([
      null,
      'CorvetteChargeLaserMod',
      TM_MOD,
      'ExistingMod',
    ])
    const onlyTm = { ...optimizer, allowed_mod_slots: { Corvette: { primary: [TM_MOD], secondary: [null] } } }
    expect(nodeSlotOptions(onlyTm, { galaxy: 11 }, 'Corvette', 'primary')).toEqual([null])
    expect(nodeSlotOptions(onlyTm, unlocked, 'Corvette', 'primary')).toEqual([TM_MOD])
  })
  it('rejects locked TM baseline IDs and raw numeric selectors while allowing unlocked loadouts', () => {
    for (const primary of [TM_MOD, 2, '2']) {
      expect(() => validateGalaxyLoadouts(baseline(primary), common, optimizer)).toThrow('Baseline 仍选择 TM')
      expect(() =>
        validateGalaxyLoadouts({ ...baseline(primary), travel_mod_unlocked: true }, common, optimizer),
      ).not.toThrow()
      expect(() => validateGalaxyLoadouts(baseline(primary, 10), common, optimizer)).toThrow('Baseline 仍选择 TM')
    }
    expect(() => validateGalaxyLoadouts(baseline(3), common, optimizer)).not.toThrow()
  })
  it('rejects TM in the wrong slot even when unlocked', () => {
    const wrongSlot = baseline(null)
    wrongSlot.baseline.loadouts.Corvette.secondary = TM_MOD
    expect(() => validateGalaxyLoadouts({ ...wrongSlot, travel_mod_unlocked: true }, common, optimizer)).toThrow(
      '只能装备在护卫舰 Primary',
    )
  })
})
