import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRepository } from '../src/main/services/data-repository'
import { OptimizerRunner } from '../src/main/services/optimizer-runner'
const node = {
  galaxy: 6,
  node: 'B1',
  hazards: [],
  supports: [],
  player_state: { fleet_resources: 1, ships: {} },
  baseline: { enabled: true, formation: {}, loadouts: {} },
  search: {
    profile: 'fast',
    goal: 'beat_baseline',
    simulation_clock: 'offline_fixed_step' as const,
    max_wall_seconds: 1,
    max_simulations: 1,
    workers: 1,
  },
}
const common = { permanent: { damage_scale: 1, health_scale: 1 }, temporary: { damage_scale: 0, health_scale: 0 } }
const result = {
  base_config: { resolver: { friendly_input: { galaxy: 6, node: 'B1' } } },
  best_result: { formation: [] },
  verified_baseline: { formation: [] },
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'runner-'))
  const base = join(root, 'data', 'galaxies', 'g6')
  await mkdir(join(base, 'nodes', 'B1', 'versions'), { recursive: true })
  await mkdir(join(base, 'common', 'versions'), { recursive: true })
  await mkdir(join(root, 'map', 'g6'), { recursive: true })
  await writeFile(join(base, 'nodes', 'B1', 'versions', 'default.json'), JSON.stringify(node))
  await writeFile(
    join(base, 'nodes', 'B1', 'meta.json'),
    JSON.stringify({ default_version: 'default', versions: [{ id: 'default', name: '默认' }] }),
  )
  await writeFile(join(base, 'common', 'versions', 'default.json'), JSON.stringify(common))
  await writeFile(
    join(base, 'common', 'meta.json'),
    JSON.stringify({ default_profile: 'default', profiles: [{ id: 'default', name: '默认' }] }),
  )
  return {
    root,
    map: join(root, 'map', 'g6'),
    repo: new DataRepository(join(root, 'data'), join(root, 'map')),
    s: { galaxy: 'g6', node: 'B1', version: 'default', common: 'default' },
  }
}
describe('OptimizerRunner', () => {
  it('success, nonzero, stale, malformed and association failures release lock', async () => {
    const x = await setup()
    let calls = 0
    const r = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async () => {
        calls++
        throw Error('spawn error')
      },
    )
    await expect(r.run(x.s)).rejects.toThrow('spawn error')
    await expect(r.run(x.s)).rejects.toThrow('spawn error')
    expect(calls).toBe(2)
    await rm(x.root, { recursive: true, force: true })
  })
  it('locks concurrent tasks and releases after task completion', async () => {
    const x = await setup()
    let release!: () => void
    const r = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      () =>
        new Promise(n => {
          release = () => n(0)
        }),
    )
    const first = r.run(x.s)
    await new Promise(n => setTimeout(n, 50))
    await expect(r.run(x.s)).rejects.toThrow('already running')
    release()
    await first
    await rm(x.root, { recursive: true, force: true })
  })
  it('forwards stdout stderr and accepts a new valid result', async () => {
    const x = await setup(),
      out: string[] = []
    const r = new OptimizerRunner(
      x.repo,
      x.root,
      v => out.push(v),
      async () => {
        out.push('stdout', 'stderr')
        await writeFile(join(x.map, 'B1.result.json'), JSON.stringify(result))
        return 0
      },
    )
    expect((await r.run(x.s)).result).toBeTruthy()
    expect(out.join()).toContain('stderr')
    await rm(x.root, { recursive: true, force: true })
  })
})

describe('Best Found copy transaction', () => {
  it('stages, runs copy mode, validates and updates only the selected Version', async () => {
    const x = await setup()
    const other = await x.repo.createVersion(x.s, 'Other')
    const otherSelection = { ...x.s, version: other }
    let mode = ''
    const changed = { ...node, baseline: { ...node.baseline, formation: { A1: 'Fighter' } } }
    const runner = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async (_selection, nextMode) => {
        mode = nextMode
        await writeFile(join(x.map, 'B1.json'), JSON.stringify(changed))
        return 0
      },
    )
    const applied = await runner.useBest(x.s)
    expect(mode).toBe('copy')
    expect(applied.error).toBeUndefined()
    expect((await x.repo.load(x.s)).node.baseline.formation).toEqual({ A1: 'Fighter' })
    expect((await x.repo.load(otherSelection)).node.baseline.formation).toEqual({})
    await rm(x.root, { recursive: true, force: true })
  })
  it('does not modify Manager data when --c fails or writes invalid JSON', async () => {
    const x = await setup()
    const managerPath = join(x.root, 'data', 'galaxies', 'g6', 'nodes', 'B1', 'versions', 'default.json')
    const before = await readFile(managerPath, 'utf8')
    const failed = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async () => {
        await writeFile(join(x.map, 'B1.json'), JSON.stringify({ ...node, hazards: ['workspace-only'] }))
        return 7
      },
    )
    expect((await failed.useBest(x.s)).error).toContain('code 7')
    expect(await readFile(managerPath, 'utf8')).toBe(before)
    const invalid = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async () => {
        await writeFile(join(x.map, 'B1.json'), '{ invalid')
        return 0
      },
    )
    expect((await invalid.useBest(x.s)).error).toContain('invalid')
    expect(await readFile(managerPath, 'utf8')).toBe(before)
    await rm(x.root, { recursive: true, force: true })
  })
})
