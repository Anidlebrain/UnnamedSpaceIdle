import { describe, expect, it } from 'vitest'
import {
  diffFormation,
  hasFormationOrLoadoutChange,
  hasRerunChange,
  usedFrIntegerChange,
} from '../src/shared/formation-diff'
type Entry = {
  position: string
  ship: string
  primary_mod?: string | null
  secondary_mod?: string | null
  tertiary_mods?: string[]
}
const candidate = (entry: Entry, fr = 10) => ({ formation: [entry], fleet_resources_used: fr })
describe('diffFormation', () => {
  it('ignores only Used FR changes', () =>
    expect(
      diffFormation(
        candidate({ position: 'A1', ship: 'Fighter', primary_mod: null, secondary_mod: null, tertiary_mods: [] }, 10),
        candidate({ position: 'A1', ship: 'Fighter', primary_mod: null, secondary_mod: null, tertiary_mods: [] }, 8),
      ),
    ).toEqual([]))
  it.each([
    ['position', { position: 'A2', ship: 'Fighter' }],
    ['ship', { position: 'A1', ship: 'Corvette' }],
    ['primary', { position: 'A1', ship: 'Fighter', primary_mod: 'Laser' }],
    ['secondary', { position: 'A1', ship: 'Fighter', secondary_mod: 'Shield' }],
    ['tertiary', { position: 'A1', ship: 'Fighter', tertiary_mods: ['A'] }],
  ])('detects %s changes', (_, next) =>
    expect(
      diffFormation(
        candidate({ position: 'A1', ship: 'Fighter', primary_mod: null, secondary_mod: null, tertiary_mods: [] }),
        candidate(next),
      ).length,
    ).toBeGreaterThan(0),
  )
})

describe('hasFormationOrLoadoutChange', () => {
  it('prefers standardized formation_key and ignores FR-only changes', () => {
    const baseline = { ...candidate({ position: 'A1', ship: 'Fighter' }, 10), formation_key: 'same-key' }
    const best = { ...candidate({ position: 'A1', ship: 'Fighter' }, 5), formation_key: 'same-key' }
    expect(hasFormationOrLoadoutChange(baseline, best)).toBe(false)
    expect(hasFormationOrLoadoutChange(baseline, { ...best, formation_key: 'changed-key' })).toBe(true)
  })
  it('falls back to structured Formation and Loadout fields when keys are absent', () => {
    expect(
      hasFormationOrLoadoutChange(
        candidate({ position: 'A1', ship: 'Fighter', secondary_mod: null }),
        candidate({ position: 'A1', ship: 'Fighter', secondary_mod: 'Shield' }),
      ),
    ).toBe(true)
  })
})

describe('Used FR integer comparison', () => {
  const formation = { position: 'A1', ship: 'Fighter' }
  it('ignores decimals within the same integer, even when formation changes', () => {
    const baseline = candidate(formation, 15.89)
    const best = candidate({ ...formation, ship: 'Corvette' }, 15.01)
    expect(usedFrIntegerChange(baseline, best)).toEqual({ baselineUsed: 15, bestUsed: 15, saved: 0 })
    expect(hasRerunChange(baseline, best)).toBe(false)
  })
  it('counts crossing an integer boundary as one FR of change', () => {
    const baseline = candidate(formation, 15.01)
    const best = candidate(formation, 14.99)
    expect(usedFrIntegerChange(baseline, best)).toEqual({ baselineUsed: 15, bestUsed: 14, saved: 1 })
    expect(hasRerunChange(baseline, best)).toBe(true)
  })
  it('falls back to configuration changes if Used FR is unavailable', () => {
    expect(hasRerunChange({ formation: [formation] }, { formation: [{ ...formation, ship: 'Corvette' }] })).toBe(true)
  })
})
