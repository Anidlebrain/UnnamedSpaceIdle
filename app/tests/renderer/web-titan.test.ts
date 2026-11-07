import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserTitanApi } from '../../src/renderer/web-titan-api'
import { DEFAULT_TITAN_SETTINGS } from '../../src/shared/titan'
import type { TitanPlayer } from '../../src/shared/titan'

const player: TitanPlayer = {
  statistics: {
    game_version: '0.90.0.1',
    reference_layer: 'surface',
    temporary_combat_effects_active: false,
    summary_stats: { titan_damage: 2.2e20, titan_max_shields: 3e21, array_capacity: 1 },
    alignment: { antumbra: 0, penumbra: 0 },
    reference_array_level: 0,
    reference_array_base_damage: 4e20,
    core_level_caps: { TitanLaser: 0, TitanShield: 0, TitanArray: 0 },
  },
  progress: {
    highest_sectors: { surface: 160, antumbra: 0, penumbra: 0, umbra: 0 },
    umbra_sector_number: 0,
    reintegration: false,
    galaxy12_unlocked: false,
  },
}

afterEach(() => localStorage.clear())

describe('browser Titan workspace', () => {
  it('starts without synthetic player data and never pretends to execute native searches', async () => {
    const api = createBrowserTitanApi()
    expect((await api.load()).player).toBeNull()
    expect((await api.load()).playerSource).toBe('none')
    await expect(api.start({ player, settings: DEFAULT_TITAN_SETTINGS })).rejects.toThrow('桌面应用')
    await expect(api.inspect({ sector: '160', layer: 'surface' })).rejects.toThrow('桌面应用')
    await expect(api.stop()).rejects.toThrow('桌面应用')
    expect(await api.current()).toBeNull()
  })

  it('persists player data and independent target settings across browser sessions', async () => {
    const api = createBrowserTitanApi()
    await api.savePlayer(player)
    await api.saveSettings({ ...DEFAULT_TITAN_SETTINGS, sector: '160A', mode: 'farm_distance', budgetSeconds: 600 })
    const restored = await createBrowserTitanApi().load()
    expect(restored.player).toEqual(player)
    expect(restored.settings).toMatchObject({ sector: '160A', mode: 'farm_distance', budgetSeconds: 600 })
    expect(restored.playerSource).toBe('manager')
    restored.player!.statistics.summary_stats.titan_damage = 1
    expect((await api.load()).player!.statistics.summary_stats.titan_damage).toBe(2.2e20)
  })

  it('rejects invalid drafts without overwriting the previously saved player', async () => {
    const api = createBrowserTitanApi()
    await api.savePlayer(player)
    const invalid = structuredClone(player)
    invalid.statistics.summary_stats.titan_damage = Infinity
    await expect(api.savePlayer(invalid)).rejects.toThrow()
    expect((await createBrowserTitanApi().load()).player).toEqual(player)
    await expect(api.saveSettings({ ...DEFAULT_TITAN_SETTINGS, farmSeconds: 119 })).rejects.toThrow()
  })

  it('surfaces malformed local storage instead of silently adding a sample player', async () => {
    localStorage.setItem('fleet-manager-web-titan-v1', '{')
    const workspace = await createBrowserTitanApi().load()
    expect(workspace.player).toBeNull()
    expect(workspace.importError).toContain('读取失败')
  })
})
