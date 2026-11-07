import { describe, it } from 'vitest'

describe.runIf(process.env.FLEET_MANAGER_REAL_TITAN_SMOKE === '1')('real Titan service smoke', () => {
  it('uses the existing BAT and native Godot to publish a matching verified synthetic boss result', async () => {
    // @ts-expect-error TypeScript requires allowImportingTsExtensions for an .mts dynamic import.
    await import('./real-titan-smoke.mts')
  }, 310_000)
})
