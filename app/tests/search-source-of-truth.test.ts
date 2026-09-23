import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const fleetRoot = join('..', 'fleetSimulation')

describe('daily search source of truth', () => {
  it('keeps staged Node search as the final Godot budget, clock, and worker input', async () => {
    const runner = await readFile(join(fleetRoot, 'poc', 'fleet_test_runner.gd'), 'utf8')
    const optimizer = await readFile(join(fleetRoot, 'poc', 'fleet_optimizer_v2.gd'), 'utf8')
    const bat = await readFile(join(fleetRoot, 'run_optimizer.bat'), 'utf8')

    expect(runner).toContain('optimizer_settings.search = config.optimizer.get("search", {}).duplicate(true)')
    expect(optimizer).toContain('_settings.max_simulations = int(search.max_simulations)')
    expect(optimizer).toContain('_settings.max_wall_seconds = float(search.max_wall_seconds)')
    expect(optimizer).toContain('search.get("workers", _settings.get("workers", 1))')
    expect(optimizer).toMatch(/search\.get\(\s*"simulation_clock"/)
    expect(bat).toContain('$value.search.simulation_clock')
  })

  it('persists Manager Search independently and selects local Optimizer config before fallback', async () => {
    const manager = await readFile(join('src', 'main', 'services', 'optimizer-runner.ts'), 'utf8')
    const repository = await readFile(join('src', 'main', 'services', 'data-repository.ts'), 'utf8')
    const bat = await readFile(join(fleetRoot, 'run_optimizer.bat'), 'utf8')
    const searchDefault = JSON.parse(await readFile(join(fleetRoot, 'poc', 'search_config.json'), 'utf8'))

    expect(manager).toContain('await this.repo.saveSearchConfig(request.search)')
    expect(manager).toContain('search: structuredClone(savedSearch)')
    expect(manager).toContain('stagedNodeConfigHash')
    expect(repository).toContain("join(mapRoot, 'search_config.json')")
    expect(repository).toContain("join(fleetRoot, 'poc', 'search_config.json')")
    expect(bat).toContain('map\\optimizer_v2_daily.json')
    expect(bat).toContain('poc\\optimizer_v2_daily.json')
    expect(searchDefault).toMatchObject({ profile: 'fast', goal: 'beat_baseline' })
  })

  it('derives objective from Boss state while daily mode remains deployment semantics', async () => {
    const resolver = await readFile(join(fleetRoot, 'poc', 'friendly_config_resolver.gd'), 'utf8')
    const daily = JSON.parse(await readFile(join(fleetRoot, 'poc', 'optimizer_v2_daily.json'), 'utf8'))

    expect(resolver).toContain('if boss_alive:')
    expect(resolver).toContain('objective = "boss"')
    expect(resolver).toContain('"objective": objective')
    expect(daily.mode).toBe('realistic')
    expect(daily).toHaveProperty('max_simulations')
    expect(daily).toHaveProperty('kill_refine_top_n')
    expect(daily).toHaveProperty('kill_sequence_max_battles')
  })
})
