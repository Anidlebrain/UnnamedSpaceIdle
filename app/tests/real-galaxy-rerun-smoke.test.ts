import { describe, it } from 'vitest'

describe.runIf(process.env.FLEET_MANAGER_REAL_GALAXY_SMOKE === '1')('real Galaxy rerun smoke', () => {
  it('runs two real Nodes with a tiny budget and restores the Optimizer workspace', async () => {
    // The explicit extension lets Vitest include this opt-in script while the normal test glob ignores it.
    // @ts-expect-error TypeScript requires allowImportingTsExtensions for an .mts dynamic import.
    await import('./real-galaxy-rerun-smoke.mts')
  }, 120_000)
})
