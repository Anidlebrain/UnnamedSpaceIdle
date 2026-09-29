import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const fleetRoot = join('..', 'fleetSimulation')

describe('daily search source of truth', () => {
  it('keeps all six staged Node search fields on the Resolver and Godot path', async () => {
    const runner = await readFile(join(fleetRoot, 'poc', 'fleet_test_runner.gd'), 'utf8')
    const optimizer = await readFile(join(fleetRoot, 'poc', 'fleet_optimizer_v2.gd'), 'utf8')
    const resolver = await readFile(join(fleetRoot, 'poc', 'friendly_config_resolver.gd'), 'utf8')
    const searchV3 = await readFile(join(fleetRoot, 'poc', 'fleet_optimizer_search.gd'), 'utf8')
    const bat = await readFile(join(fleetRoot, 'run_optimizer.bat'), 'utf8')
    const godotLauncher = await readFile(join(fleetRoot, 'tools', 'run_godot_optimizer.ps1'), 'utf8')

    expect(runner).toContain('optimizer_settings.search = config.optimizer.get("search", {}).duplicate(true)')
    expect(resolver).toContain('"profile": profile')
    expect(resolver).toContain('"goal": goal')
    expect(resolver).toContain('"simulation_clock": simulation_clock')
    expect(resolver).toContain('"max_wall_seconds": float(search.get("max_wall_seconds", 300.0))')
    expect(resolver).toContain('"max_simulations": int(search.get("max_simulations", 1000000))')
    expect(resolver).toContain('"workers": clampi(int(search.get("workers", 1)), 1, 4)')
    expect(resolver).toContain('var target_used_fr = search.get("target_used_fr")')
    expect(optimizer).toContain('_profile = str(search.get("profile"')
    expect(optimizer).toContain('_goal = str(search.get("goal"')
    expect(optimizer).toContain('_settings.max_simulations = int(search.max_simulations)')
    expect(optimizer).toContain('_settings.max_wall_seconds = float(search.max_wall_seconds)')
    expect(optimizer).toContain('search.get("workers", _settings.get("workers", 1))')
    expect(optimizer).toMatch(/search\.get\(\s*"simulation_clock"/)
    expect(bat).toContain('$value.search.simulation_clock')
    expect(godotLauncher).toContain('"--fixed-fps", "60"')
    expect(searchV3).toContain('"search_goal": _goal')
  })

  it('persists shared Search independently and merges the Node target before staging', async () => {
    const manager = await readFile(join('src', 'main', 'services', 'optimizer-runner.ts'), 'utf8')
    const repository = await readFile(join('src', 'main', 'services', 'data-repository.ts'), 'utf8')
    const bat = await readFile(join(fleetRoot, 'run_optimizer.bat'), 'utf8')
    const searchDefault = JSON.parse(await readFile(join(fleetRoot, 'poc', 'search_config.json'), 'utf8'))

    expect(manager).toContain('await this.repo.saveSearchConfig(request.search)')
    expect(manager).toContain('searchForNode(savedSearch, prepared.node)')
    expect(manager).toContain('search: structuredClone(stagedNode.search)')
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
