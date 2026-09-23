import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DataRepository } from '../src/main/services/data-repository'
import { GalaxyRerunService } from '../src/main/services/galaxy-rerun'
import { OptimizerRunner } from '../src/main/services/optimizer-runner'
import type { Selection } from '../src/shared/contracts'
import type { NodeConfig } from '../src/shared/schemas'

const roots: string[] = []
const common = (damage: number) => ({
  permanent: { damage_scale: damage, health_scale: 1 },
  temporary: { damage_scale: 0, health_scale: 0 },
})
const node = (id: string, marker: string): NodeConfig => ({
  galaxy: 6,
  node: id,
  hazards: [marker],
  supports: [],
  player_state: { fleet_resources: 10, ships: {} },
  baseline: { enabled: true, formation: {}, loadouts: {} },
  search: {
    profile: 'fast',
    goal: 'beat_baseline',
    simulation_clock: 'offline_fixed_step' as const,
    max_wall_seconds: 1,
    max_simulations: 1,
    workers: 1,
  },
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'galaxy-rerun-'))
  roots.push(root)
  const galaxy = join(root, 'data', 'galaxies', 'g6')
  await mkdir(join(galaxy, 'common', 'versions'), { recursive: true })
  await mkdir(join(root, 'map', 'g6'), { recursive: true })
  await mkdir(join(root, 'poc'), { recursive: true })
  await writeFile(join(root, 'poc', 'search_config.json'), JSON.stringify(node('B1', 'default').search))
  await writeFile(
    join(root, 'poc', 'optimizer_v2_daily.json'),
    JSON.stringify({
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
    }),
  )
  await writeFile(join(galaxy, 'common', 'versions', 'old.json'), JSON.stringify(common(1)))
  await writeFile(join(galaxy, 'common', 'versions', 'buff.json'), JSON.stringify(common(2)))
  await writeFile(
    join(galaxy, 'common', 'meta.json'),
    JSON.stringify({
      default_profile: 'buff',
      profiles: [
        { id: 'old', name: 'Old' },
        { id: 'buff', name: 'Buff' },
      ],
    }),
  )
  for (const id of ['B1', 'B2', 'B3']) {
    const directory = join(galaxy, 'nodes', id)
    await mkdir(join(directory, 'versions'), { recursive: true })
    await writeFile(join(directory, 'versions', 'default.json'), JSON.stringify(node(id, `${id}-default`)))
    await writeFile(join(directory, 'versions', 'special.json'), JSON.stringify(node(id, `${id}-special`)))
    await writeFile(
      join(directory, 'meta.json'),
      JSON.stringify({
        default_version: id === 'B2' ? 'special' : 'default',
        versions: [
          { id: 'default', name: 'Default' },
          { id: 'special', name: 'Special' },
        ],
      }),
    )
  }
  return {
    root,
    repo: new DataRepository(join(root, 'data'), join(root, 'map')),
    managerGalaxy: galaxy,
    mapGalaxy: join(root, 'map', 'g6'),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('GalaxyRerunService', () => {
  it('runs selected nodes in requested order with one frozen Search draft', async () => {
    const fixture = await setup()
    const staged: Array<{ node: string; max: number }> = []
    const runner = new OptimizerRunner(
      fixture.repo,
      fixture.root,
      () => {},
      async selection => {
        const config = JSON.parse(await readFile(join(fixture.mapGalaxy, `${selection.node}.json`), 'utf8'))
        staged.push({ node: selection.node, max: config.search.max_simulations })
        await writeFile(
          join(fixture.mapGalaxy, `${selection.node}.result.json`),
          JSON.stringify({
            base_config: { resolver: { friendly_input: { galaxy: 6, node: selection.node } } },
            verified_baseline: { formation: [] },
            best_result: { formation: [] },
          }),
        )
        return 0
      },
    )
    const service = new GalaxyRerunService(fixture.repo, runner, () => {})
    const search = { ...node('B1', 'x').search, max_simulations: 7 }
    const progress = await service.run({ galaxy: 'g6', nodes: ['B3', 'B1'], search })
    expect(staged).toEqual([
      { node: 'B3', max: 7 },
      { node: 'B1', max: 7 },
    ])
    expect(progress.nodes.map(item => item.node)).toEqual(['B3', 'B1'])
    expect(progress.nodes.every(item => item.run?.task?.search.max_simulations === 7)).toBe(true)
  })
  it('uses only Galaxy defaults, runs serially, filters FR-only changes, continues failures, and never writes Manager data', async () => {
    const fixture = await setup()
    const managerPaths = [
      join(fixture.managerGalaxy, 'common', 'versions', 'buff.json'),
      ...['B1', 'B2', 'B3'].map(id =>
        join(fixture.managerGalaxy, 'nodes', id, 'versions', id === 'B2' ? 'special.json' : 'default.json'),
      ),
    ]
    const before = await Promise.all(managerPaths.map(path => readFile(path, 'utf8')))
    const calls: Array<{ selection: Selection; mode: string }> = []
    let active = 0
    let maxActive = 0
    const runner = new OptimizerRunner(
      fixture.repo,
      fixture.root,
      () => {},
      async (selection, mode) => {
        calls.push({ selection: { ...selection }, mode })
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        if (selection.node === 'B2') return 9
        const changed = selection.node === 'B3'
        const formation = [
          {
            position: 'A1',
            ship: changed ? 'Corvette' : 'Fighter',
            primary_mod: null,
            secondary_mod: null,
            tertiary_mods: [],
          },
        ]
        await writeFile(
          join(fixture.mapGalaxy, `${selection.node}.result.json`),
          JSON.stringify({
            base_config: { resolver: { friendly_input: { galaxy: 6, node: selection.node } } },
            verified_baseline: {
              formation_key: 'baseline-key',
              formation: [{ ...formation[0], ship: 'Fighter' }],
              fleet_resources_used: 10,
            },
            best_result: {
              formation_key: changed ? 'changed-key' : 'baseline-key',
              formation,
              fleet_resources_used: 5,
            },
          }),
        )
        return 0
      },
    )
    const events: number[] = []
    const service = new GalaxyRerunService(fixture.repo, runner, progress => events.push(progress.completed))
    const result = await service.run('g6')

    expect(calls.map(call => call.selection)).toEqual([
      { galaxy: 'g6', node: 'B1', version: 'default', common: 'buff' },
      { galaxy: 'g6', node: 'B2', version: 'special', common: 'buff' },
      { galaxy: 'g6', node: 'B3', version: 'default', common: 'buff' },
    ])
    expect(calls.every(call => call.mode === 'search')).toBe(true)
    expect(maxActive).toBe(1)
    expect(result.status).toBe('completed')
    expect(result.completed).toBe(3)
    expect(result.nodes.map(item => ({ node: item.node, status: item.status, changed: item.changed }))).toEqual([
      { node: 'B1', status: 'succeeded', changed: false },
      { node: 'B2', status: 'failed', changed: undefined },
      { node: 'B3', status: 'succeeded', changed: true },
    ])
    expect(result.nodes[1].run?.result).toBeUndefined()
    expect(result.nodes[1].error).toContain('code 9')
    expect(result.nodes[0].run?.task?.search).toEqual(node('B1', 'default').search)
    expect(events).toContain(1)
    expect(events.at(-1)).toBe(3)
    expect(await Promise.all(managerPaths.map(path => readFile(path, 'utf8')))).toEqual(before)
  })
})
