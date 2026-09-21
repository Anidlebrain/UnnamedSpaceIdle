import { describe, expect, it } from 'vitest'
import { diffFormation, hasFormationOrLoadoutChange } from '../src/shared/formation-diff'
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
