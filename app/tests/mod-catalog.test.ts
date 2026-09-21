import { describe, expect, it } from 'vitest'
import { preserveModSelectorFormat, resolveModSelector } from '../src/shared/mod-catalog'

describe('Optimizer Mod selectors', () => {
  const options = [null, 'FirstMod', 'SecondMod']

  it('resolves None and numeric indexes against ordered allowed_mod_slots arrays', () => {
    expect(resolveModSelector(null, options)).toBeNull()
    expect(resolveModSelector(0, options)).toBeNull()
    expect(resolveModSelector(1, options)).toBe('FirstMod')
    expect(resolveModSelector('2', options)).toBe('SecondMod')
  })

  it('writes real IDs for ID configs and preserves numeric legacy representation', () => {
    expect(preserveModSelectorFormat(null, 'FirstMod', options)).toBe('FirstMod')
    expect(preserveModSelectorFormat('FirstMod', null, options)).toBeNull()
    expect(preserveModSelectorFormat(0, 'SecondMod', options)).toBe(2)
    expect(preserveModSelectorFormat('1', null, options)).toBe('0')
  })
})
