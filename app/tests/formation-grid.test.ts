import { describe, expect, it } from 'vitest'
import { formationResultError } from '../src/shared/formation-grid'

describe('result formation application boundary', () => {
  it('accepts all fifteen slots for a three-column target and legacy two-column results', () => {
    const formation = ['A', 'B', 'C'].flatMap(column => [1, 2, 3, 4, 5].map(row => ({ position: `${column}${row}` })))
    expect(formationResultError(formation, { grid_size: [3, 5] }, 3)).toBeNull()
    expect(formationResultError([{ position: 'B5' }], undefined, 2)).toBeNull()
  })

  it('rejects mismatched metadata even when the rear column is empty', () => {
    expect(formationResultError([{ position: 'A1' }], { grid_size: [3, 5] }, 2)).toMatch(/不一致/)
    expect(formationResultError([{ position: 'C1' }], undefined, 2)).toMatch(/超出/)
  })

  it('rejects duplicate and invalid cells before a result can overwrite a ship', () => {
    expect(formationResultError([{ position: 'C3' }, { position: 'C3' }], undefined, 3)).toMatch(/重复/)
    expect(formationResultError([{ position: 'C6' }], undefined, 3)).toMatch(/超出/)
  })
})
