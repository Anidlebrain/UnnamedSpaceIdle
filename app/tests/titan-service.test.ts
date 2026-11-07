import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { TitanService, type TitanExecutor } from '../src/main/services/titan-service'
import {
  DEFAULT_TITAN_SETTINGS,
  titanPlayerSchema,
  titanSettingsSchema,
  type TitanPlayer,
  type TitanResult,
  type TitanTask,
} from '../src/shared/titan'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const player: TitanPlayer = {
  statistics: {
    game_version: '0.90.0.1',
    reference_layer: 'surface',
    temporary_combat_effects_active: false,
    summary_stats: { titan_damage: 1e20, titan_max_shields: 2e20, array_capacity: 20 },
    alignment: { antumbra: 0, penumbra: 0 },
    reference_array_level: 0,
    reference_array_base_damage: 3e20,
    core_level_caps: { TitanLaser: 0, TitanShield: 0, TitanArray: 0 },
  },
  progress: {
    highest_sectors: { surface: 170, antumbra: 165, penumbra: 165, umbra: 160 },
    umbra_sector_number: 160,
    reintegration: true,
    galaxy12_unlocked: false,
  },
}
const validCandidate = {
  weapons: Array.from({ length: 3 }, () => ({
    id: 'TitanLaser',
    level: 0,
    milestones: {},
    targeting: { type: 'None', priority: 'Closest', swapping: 'Keep Target', overlap: 'Allow' },
  })),
  shield: { id: 'TitanShield', level: 0, milestones: {} },
  array_core: { id: 'TitanArray', level: 0, milestones: {} },
  array_capacity: 20,
  sequence: [{ id: 'laser_shot', targets: [] }],
}
const region = {
  sector: 164,
  sector_id: 'Sector164',
  layer: 'antumbra' as const,
  distance_start: 1000,
  distance_end: 1100,
  array_targets: [],
}
const inspection = {
  status: 'RESEARCH_ONLY',
  game_version: '0.90.0.1',
  region,
  cores: {},
  milestones: {},
  array_elements: {},
  targeting: {},
}
const settings = {
  ...DEFAULT_TITAN_SETTINGS,
  godotPath: 'C:\\Test Godot\\godot.exe',
  sector: '164',
  layer: 'antumbra' as const,
}
async function fixture(executor?: TitanExecutor, stop?: () => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'titan-manager-'))
  folders.push(folder)
  const root = join(folder, 'titanSimulation')
  const data = join(folder, 'data')
  await mkdir(root, { recursive: true })
  const events: TitanTask[] = []
  const service = new TitanService(data, root, task => events.push(task), executor, stop)
  return { root, data, service, events }
}
function simulated(root: () => string, exit = 0, change?: (result: TitanResult) => void): TitanExecutor {
  return async (args, output) => {
    if (args[0] === 'inspect') {
      output(JSON.stringify(inspection))
      return 0
    }
    const value = (key: string) => args[args.indexOf(key) + 1]
    const directory = join(root(), 'results', value('--label'))
    await mkdir(directory, { recursive: true })
    const bytes = await readFile(value('--player'))
    const result: TitanResult = {
      status: exit === 0 ? 'KILL_FOUND' : 'NO_KILL_FOUND_WITHIN_BUDGET',
      mode: 'boss_once',
      region,
      trials: 2,
      player_sha256: createHash('sha256').update(bytes).digest('hex'),
      output_directory: directory,
      best: exit === 0 ? { distance: 1099, candidate: validCandidate, battle: { boss_killed: true } } : null,
    }
    change?.(result)
    await writeFile(join(directory, 'result.json'), JSON.stringify(result))
    await writeFile(join(directory, 'result.txt'), '权威结果文本')
    output('原生试验已完成\n')
    return exit
  }
}
async function complete(service: TitanService) {
  for (let i = 0; i < 200; i++) {
    const task = service.current()
    if (task?.status !== 'running') return task
    await new Promise(done => setTimeout(done, 5))
  }
  throw new Error('Task did not finish')
}
describe('Titan player and settings contracts', () => {
  it('accepts source-valid level zero and route/internal sector IDs', () => {
    expect(titanPlayerSchema.parse(player)).toEqual(player)
    expect(titanSettingsSchema.parse({ ...settings, sector: 'Sector164A' }).sector).toBe('Sector164A')
  })
  it('rejects nonfinite readings, unknown fields, incomplete version progress, and weakened farm gates', () => {
    expect(titanPlayerSchema.safeParse({ ...player, unknown: 1 }).success).toBe(false)
    expect(
      titanPlayerSchema.safeParse({
        ...player,
        statistics: {
          ...player.statistics,
          summary_stats: { ...player.statistics.summary_stats, titan_damage: Infinity },
        },
      }).success,
    ).toBe(false)
    expect(
      titanPlayerSchema.safeParse({ ...player, progress: { ...player.progress, galaxy12_unlocked: undefined } })
        .success,
    ).toBe(false)
    expect(titanSettingsSchema.safeParse({ ...settings, farmSeconds: 119 }).success).toBe(false)
    expect(titanSettingsSchema.safeParse({ ...settings, sourcePath: '%UNTRUSTED%' }).success).toBe(false)
  })
})
describe('Titan service', () => {
  it('imports local input read-only and saves a separate manager profile', async () => {
    const { root, service } = await fixture()
    await mkdir(join(root, 'local'))
    const path = join(root, 'local', 'player.json')
    const original = JSON.stringify(player)
    await writeFile(path, original)
    expect((await service.load()).playerSource).toBe('local')
    await service.savePlayer({ ...player, progress: { ...player.progress, galaxy12_unlocked: true } })
    expect((await service.load()).playerSource).toBe('manager')
    expect(await readFile(path, 'utf8')).toBe(original)
  })
  it('keeps a missing or invalid local player editable without filling synthetic values', async () => {
    const { root, service } = await fixture()
    expect((await service.load()).player).toBeNull()
    await mkdir(join(root, 'local'))
    await writeFile(join(root, 'local', 'player.json'), '{}')
    expect((await service.load()).importError).toBeTruthy()
    expect((await service.load()).player).toBeNull()
  })
  it('freezes the input and returns only the matching verified current result', async () => {
    let root = ''
    const f = await fixture(simulated(() => root))
    root = f.root
    const request = { player: structuredClone(player), settings }
    const task = await f.service.start(request)
    request.player.statistics.summary_stats.titan_damage = 1
    expect(task.request.player.statistics.summary_stats.titan_damage).toBe(1e20)
    const result = await complete(f.service)
    expect(result?.status).toBe('success')
    expect(result?.resultText).toBe('权威结果文本')
    expect(result?.logs).toContain('原生试验已完成')
    expect(await readFile(join(f.data, 'titan', 'tasks', task.id, 'player.json'), 'utf8')).toContain(
      '100000000000000000000',
    )
  })
  it('distinguishes exit 3 from errors and never presents it as a recommendation', async () => {
    let root = ''
    const f = await fixture(simulated(() => root, 3))
    root = f.root
    await f.service.start({ player, settings })
    expect((await complete(f.service))?.status).toBe('no_result')
  })
  it.each(['identity', 'hash', 'evidence'])('rejects mismatched %s instead of publishing success', async kind => {
    let root = ''
    const f = await fixture(
      simulated(
        () => root,
        0,
        result => {
          if (kind === 'identity') result.region = { ...result.region, sector_id: 'old' }
          if (kind === 'hash') result.player_sha256 = 'stale'
          if (kind === 'evidence') result.best!.battle = { boss_killed: false }
        },
      ),
    )
    root = f.root
    await f.service.start({ player, settings })
    const result = await complete(f.service)
    expect(result?.status).toBe('failed')
    expect(result?.result).toBeUndefined()
  })
  it('checks access before launching any search', async () => {
    let launched = false
    const f = await fixture(async (args, output) => {
      if (args[0] === 'inspect') output(JSON.stringify(inspection))
      else launched = true
      return 0
    })
    await expect(
      f.service.start({
        player: {
          ...player,
          progress: { ...player.progress, highest_sectors: { ...player.progress.highest_sectors, antumbra: 160 } },
        },
        settings,
      }),
    ).rejects.toThrow('尚未到达')
    expect(launched).toBe(false)
  })
  it('prevents concurrent starts and kills before releasing the task', async () => {
    let release!: (code: number) => void
    let killed = false
    const f = await fixture(
      async (args, output) => {
        if (args[0] === 'inspect') {
          output(JSON.stringify(inspection))
          return 0
        }
        return new Promise(done => {
          release = done
        })
      },
      async () => {
        killed = true
        release(1)
      },
    )
    await f.service.start({ player, settings })
    await expect(f.service.start({ player, settings })).rejects.toThrow('正在运行')
    await f.service.stop()
    expect(killed).toBe(true)
    expect((await complete(f.service))?.status).toBe('canceled')
  })
})
// Opt-in read-only CLI contract check; never starts Godot or writes player files.
it.skipIf(!process.env.TITAN_TEST_REAL_INSPECT)(
  'reads real recovered catalog through the existing BAT entry',
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'titan-inspect-'))
    folders.push(folder)
    const service = new TitanService(folder, join(process.cwd(), '..', 'titanSimulation'))
    const report = await service.inspect({ sector: '164', layer: 'antumbra' })
    expect(report.status).toBe('RESEARCH_ONLY')
    expect(report.game_version).toBe('0.90.0.1')
    expect(report.region.sector).toBe(164)
    expect(report.cores.TitanArray).toBeTruthy()
  },
)
it.each([false, true])('publishes farm results only after complete long holdouts (depleting=%s)', async depleting => {
  let root = ''
  const f = await fixture(
    simulated(
      () => root,
      0,
      result => {
        result.mode = 'farm_distance'
        result.status = 'BEST_VALIDATED_DISTANCE_FOUND'
        result.best = {
          candidate: validCandidate,
          distance: 1099,
          validation: [0, 1, 2].map(index => ({
            seed: 1012348 + index * 1000033,
            battle: {
              status: 'NATIVE_SMOKE_ONLY',
              observation_complete: true,
              seconds: 120,
              colossal_kills: 10,
              deaths: 0,
              distance_min: 1099,
              distance_max: 1099,
              cycle_shield_fractions: depleting ? [1, 1, 1, 1, 0.9, 0.9, 0.9, 0.8, 0.8, 0.8] : Array(10).fill(0.9),
            },
          })),
        }
      },
    ),
  )
  root = f.root
  await f.service.start({ player, settings: { ...settings, mode: 'farm_distance' } })
  expect((await complete(f.service))?.status).toBe(depleting ? 'failed' : 'success')
})
it('does not publish a failed native process or reuse a previous result', async () => {
  let root = ''
  let calls = 0
  const good = simulated(() => root)
  const f = await fixture((args, output) =>
    args[0] === 'search' && calls++ > 0 ? Promise.resolve(2) : good(args, output),
  )
  root = f.root
  await f.service.start({ player, settings })
  expect((await complete(f.service))?.status).toBe('success')
  await f.service.start({ player, settings })
  const failure = await complete(f.service)
  expect(failure?.status).toBe('failed')
  expect(failure?.result).toBeUndefined()
})
it('saves encounter preferences separately from player readings', async () => {
  const f = await fixture()
  await f.service.savePlayer(player)
  await f.service.saveSettings({ ...settings, mode: 'farm_distance', sector: '165A' })
  const workspace = await f.service.load()
  expect(workspace.player).toEqual(player)
  expect(workspace.settings.sector).toBe('165A')
})
it.each(['BUDGET_EXHAUSTED', 'CANCELLED'])('does not publish residual best for terminal status %s', async status => {
  let root = ''
  const f = await fixture(
    simulated(
      () => root,
      0,
      result => {
        result.status = status
      },
    ),
  )
  root = f.root
  await f.service.start({ player, settings })
  const result = await complete(f.service)
  expect(result?.status).toBe(status === 'CANCELLED' ? 'canceled' : 'no_result')
  expect(result?.result).toBeUndefined()
  expect(result?.resultText).toBeUndefined()
})
it('rejects malformed candidate structures before sending any recommendation to React', async () => {
  let root = ''
  const f = await fixture(
    simulated(
      () => root,
      0,
      result => {
        result.best!.candidate = { weapons: [null] }
      },
    ),
  )
  root = f.root
  await f.service.start({ player, settings })
  expect((await complete(f.service))?.status).toBe('failed')
})
it('freezes catalog labels from the same inspected source in each task', async () => {
  let root = ''
  const f = await fixture(simulated(() => root))
  root = f.root
  const task = await f.service.start({ player, settings })
  expect(task.inspection?.region.sector_id).toBe('Sector164')
  expect(task.inspection?.game_version).toBe('0.90.0.1')
  await complete(f.service)
})
