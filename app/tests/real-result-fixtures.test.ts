import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { optimizerResultSchema } from '../src/shared/schemas'
import { diffFormation } from '../src/shared/formation-diff'
async function fixture(name: string) {
  return optimizerResultSchema.parse(JSON.parse(await readFile(join('tests', 'fixtures', name), 'utf8')))
}
describe('real Optimizer Result fixtures', () => {
  it.each(['normal.result.json', 'boss.result.json'])('parses %s and exposes formation/loadout/key', async name => {
    const r = await fixture(name)
    for (const c of [r.best_result, r.verified_baseline]) {
      expect(c?.formation.length).toBeGreaterThan(0)
      expect(c?.formation_key).toBeTruthy()
      expect(c?.formation[0]).toHaveProperty('primary_mod')
      expect(c?.formation[0]).toHaveProperty('secondary_mod')
      expect(c?.formation[0]).toHaveProperty('tertiary_mods')
    }
    expect(diffFormation(r.verified_baseline, r.best_result)).toBeInstanceOf(Array)
  })
})
