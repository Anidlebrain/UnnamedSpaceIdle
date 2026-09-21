import { describe, it } from 'vitest'

describe.runIf(process.env.FLEET_MANAGER_REAL_OPTIMIZER_SMOKE === '1')('real Optimizer smoke', () => {
  it('runs one real Node, applies Best Found in isolation, and restores the Optimizer workspace', async () => {
    // The explicit extension lets Vitest include this opt-in script while normal runs keep it skipped.
    // @ts-expect-error TypeScript requires allowImportingTsExtensions for an .mts dynamic import.
    await import('./real-optimizer-smoke.mts')
  }, 120_000)
})
