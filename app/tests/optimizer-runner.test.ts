import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRepository } from '../src/main/services/data-repository'
import { OptimizerRunner } from '../src/main/services/optimizer-runner'
import type { SearchTaskSnapshot } from '../src/shared/contracts'
import type { NodeConfig } from '../src/shared/schemas'
const node: NodeConfig = {
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
const optimizer = {
  objective: 'normal',
  mode: 'realistic',
  ship_types: ['Fighter'],
  group_ranges: { Fighter: { min: 0, max: 1 } },
  allowed_mod_slots: { Fighter: { primary: [null], secondary: [null] } },
  max_total_groups: 1,
  max_groups_per_ship: { Fighter: 1 },
  max_simulations: 1,
  max_wall_seconds: 1,
  top_n: 1,
  kill_refine_top_n: 1,
  kill_sequence_max_battles: 1,
}
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
  await mkdir(join(root, 'poc'), { recursive: true })
  await writeFile(join(root, 'poc', 'optimizer_v2_daily.json'), JSON.stringify(optimizer))
  await writeFile(join(root, 'poc', 'search_config.json'), JSON.stringify(node.search))
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
  it('runs enqueued searches serially and keeps each result', async () => {
    const x = await setup()
    let release!: () => void
    let calls = 0
    const runner = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async () => {
        calls++
        if (calls === 1)
          await new Promise<void>(resolve => {
            release = resolve
          })
        await writeFile(join(x.map, 'B1.result.json'), JSON.stringify({ ...result, sequence: calls }))
        return 0
      },
    )
    const request = { ...x.s, versionName: '默认', commonName: '默认', search: node.search }
    await runner.enqueue(request)
    await runner.enqueue(request)
    await vi.waitFor(() => expect(calls).toBe(1))
    expect(calls).toBe(1)
    expect(runner.getQueue().map(item => item.status)).toEqual(['running', 'waiting'])
    release()
    await vi.waitFor(() => expect(runner.getQueue().map(item => item.status)).toEqual(['success', 'success']))
    expect(calls).toBe(2)
    expect(runner.getQueue()[0].run?.task?.taskId).not.toBe(runner.getQueue()[1].run?.task?.taskId)
    expect((await runner.useBest(runner.getQueue()[0].snapshot.taskId)).error).toContain('后续搜索覆盖')
    await rm(x.root, { recursive: true, force: true })
  })
  it('stops current or all queued tasks and releases the runner lock', async () => {
    const x = await setup()
    const releases: Array<() => void> = []
    const runner = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      () =>
        new Promise(resolve => {
          releases.push(() => resolve(1))
        }),
    )
    const request = { ...x.s, versionName: '默认', commonName: '默认', search: node.search }
    await runner.enqueue(request)
    await runner.enqueue(request)
    await vi.waitFor(() => expect(releases.length).toBe(1))
    await runner.stopCurrentTask()
    releases.shift()!()
    await vi.waitFor(() => expect(runner.getQueue().map(item => item.status)).toEqual(['canceled', 'running']))
    await vi.waitFor(() => expect(releases.length).toBe(1))
    await runner.enqueue(request)
    await runner.stopAllTasks()
    releases.shift()!()
    await vi.waitFor(() =>
      expect(runner.getQueue().map(item => item.status)).toEqual(['canceled', 'canceled', 'canceled']),
    )
    await runner.enqueue(request)
    await vi.waitFor(() => expect(runner.getQueue().at(-1)?.status).toBe('running'))
    await vi.waitFor(() => expect(releases.length).toBe(1))
    releases.shift()!()
    await vi.waitFor(() => expect(runner.getQueue().at(-1)?.status).toBe('failed'))
    await rm(x.root, { recursive: true, force: true })
  })
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
  it('holds the same global lock for an entire serial queue', async () => {
    const x = await setup()
    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => {
      signalStarted = resolve
    })
    const runner = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      () =>
        new Promise(resolve => {
          release = () => resolve(3)
          signalStarted()
        }),
    )
    const queue = runner.runQueue(
      [x.s],
      () => {},
      () => {},
    )
    await started
    await expect(runner.run(x.s)).rejects.toThrow('already running')
    await expect(runner.useBest('task')).rejects.toThrow('already running')
    await expect(
      runner.runQueue(
        [x.s],
        () => {},
        () => {},
      ),
    ).rejects.toThrow('already running')
    release()
    await queue
    await rm(x.root, { recursive: true, force: true })
  })
  it('publishes an immutable task snapshot and applies targeted write locks only while running', async () => {
    const x = await setup()
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    let task: SearchTaskSnapshot | undefined
    const runner = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      () =>
        new Promise(resolve => {
          release = () => resolve(3)
          markStarted()
        }),
      snapshot => {
        task = snapshot
      },
    )
    const running = runner.run({ ...x.s, versionName: '默认', commonName: '默认' })
    await started
    expect(task).toMatchObject({ galaxy: 'g6', node: 'B1', versionName: '默认', commonName: '默认' })
    expect(task).toHaveProperty('taskId')
    expect(task).toHaveProperty('nodeConfigHash')
    expect(task).toHaveProperty('stagedNodeConfigHash')
    expect(task).toHaveProperty('commonConfigHash')
    expect(task).toHaveProperty('optimizerConfigHash')
    expect(task).toHaveProperty('optimizerConfigVersion')
    expect(task).toHaveProperty('search.max_wall_seconds', 1)
    expect(() => runner.assertNodeWritable(x.s)).toThrow('being used')
    expect(() => runner.assertNodeWritable({ ...x.s, node: 'B2' })).not.toThrow()
    expect(() => runner.assertCommonWritable(x.s)).toThrow('being used')
    expect(() => runner.assertCommonWritable({ ...x.s, galaxy: 'g7' })).not.toThrow()
    expect(() => runner.assertOptimizerWritable()).toThrow('being used')
    release()
    await running
    expect(() => runner.assertNodeWritable(x.s)).not.toThrow()
    await rm(x.root, { recursive: true, force: true })
  })
  it('auto-saves and stages the exact Search draft used by the task snapshot', async () => {
    const x = await setup()
    const requested = { ...node.search, max_simulations: 200, max_wall_seconds: 200, workers: 4 }
    const runner = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async () => {
        const staged = JSON.parse(await readFile(join(x.map, 'B1.json'), 'utf8'))
        expect(staged.search).toEqual(requested)
        await writeFile(join(x.map, 'B1.result.json'), JSON.stringify(result))
        return 0
      },
    )
    const run = await runner.run({ ...x.s, versionName: '默认', commonName: '默认', search: requested })
    expect(run.task?.search).toEqual(requested)
    expect(run.task?.environment).toEqual({
      boss: undefined,
      hazards: [],
      supports: [],
      player_state: { fleet_resources: 1, ships: {} },
    })
    expect(JSON.parse(await readFile(join(x.root, 'map', 'search_config.json'), 'utf8'))).toEqual(requested)
    expect(run.task?.nodeConfigHash).not.toBe(run.task?.stagedNodeConfigHash)
    await rm(x.root, { recursive: true, force: true })
  })
  it('does not start the executor when Search auto-save fails', async () => {
    const x = await setup()
    const execute = vi.fn(async () => 0)
    vi.spyOn(x.repo, 'saveSearchConfig').mockRejectedValueOnce(new Error('disk full'))
    const runner = new OptimizerRunner(x.repo, x.root, () => {}, execute)
    await expect(runner.run({ ...x.s, versionName: '默认', commonName: '默认', search: node.search })).rejects.toThrow(
      'disk full',
    )
    expect(execute).not.toHaveBeenCalled()
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
        if (nextMode === 'search') await writeFile(join(x.map, 'B1.result.json'), JSON.stringify(result))
        else await writeFile(join(x.map, 'B1.json'), JSON.stringify(changed))
        return 0
      },
    )
    const searched = await runner.run(x.s)
    const applied = await runner.useBest(searched.task!.taskId)
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
      async (_selection, mode) => {
        if (mode === 'search') {
          await writeFile(join(x.map, 'B1.result.json'), JSON.stringify(result))
          return 0
        }
        await writeFile(join(x.map, 'B1.json'), JSON.stringify({ ...node, hazards: ['workspace-only'] }))
        return 7
      },
    )
    const failedSearch = await failed.run(x.s)
    expect((await failed.useBest(failedSearch.task!.taskId)).error).toContain('code 7')
    expect(await readFile(managerPath, 'utf8')).toBe(before)
    await rm(join(x.map, 'B1.result.json'), { force: true })
    const invalid = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async (_selection, mode) => {
        if (mode === 'search') await writeFile(join(x.map, 'B1.result.json'), JSON.stringify(result))
        else await writeFile(join(x.map, 'B1.json'), '{ invalid')
        return 0
      },
    )
    const invalidSearch = await invalid.run(x.s)
    expect((await invalid.useBest(invalidSearch.task!.taskId)).error).toContain('invalid')
    expect(await readFile(managerPath, 'utf8')).toBe(before)
    await rm(x.root, { recursive: true, force: true })
  })
  it('refuses to overwrite a target Version changed after the search', async () => {
    const x = await setup()
    const runner = new OptimizerRunner(
      x.repo,
      x.root,
      () => {},
      async (_selection, mode) => {
        if (mode === 'search') await writeFile(join(x.map, 'B1.result.json'), JSON.stringify(result))
        return 0
      },
    )
    const searched = await runner.run(x.s)
    await x.repo.save(x.s, { ...node, hazards: ['changed-after-search'] })
    const applied = await runner.useBest(searched.task!.taskId)
    expect(applied.error).toContain('changed after this search')
    expect((await x.repo.load(x.s)).node.hazards).toEqual(['changed-after-search'])
    await rm(x.root, { recursive: true, force: true })
  })
})
