import { describe, expect, it } from 'vitest'
import { preserveShipSelectorFormat, shipDisplayName, shipSelectorToId } from '../src/shared/ship-selectors'

describe('Formation ship selectors', () => {
  it('normalizes Optimizer numeric and string selectors for display', () => {
    expect(shipSelectorToId(4)).toBe('Cruiser')
    expect(shipSelectorToId('4')).toBe('Cruiser')
    expect(shipSelectorToId('Cruiser')).toBe('Cruiser')
    expect(shipSelectorToId('Heavy Cruiser')).toBe('HeavyCruiser')
    expect(shipSelectorToId(0)).toBe('')
  })

  it('preserves the existing representation family when edited', () => {
    expect(preserveShipSelectorFormat(4, 'Frigate')).toBe(3)
    expect(preserveShipSelectorFormat('4', 'Frigate')).toBe('3')
    expect(preserveShipSelectorFormat('Cruiser', 'Frigate')).toBe('Frigate')
    expect(preserveShipSelectorFormat(4, '')).toBe(0)
  })

  it('provides readable Chinese labels without changing stored values', () => {
    expect(shipDisplayName(4)).toBe('巡洋舰（Cruiser · 4）')
    expect(shipDisplayName('Fighter', false)).toBe('战斗机')
  })
})
