import { afterEach, expect, it } from 'vitest'
import { createBrowserApi } from '../../src/renderer/web-runtime-api'
import { setGalaxyMod, TM_MOD } from '../../src/shared/galaxy-mods'

afterEach(() => localStorage.clear())
it('persists both unlocks and rejects locked baseline TM in browser run, queue, and rerun', async () => {
  const api = createBrowserApi()
  const source = { galaxy: 'g6', node: 'B12', version: 'default', common: 'default' }
  await api.createGalaxy({ galaxy: 'g11', node: 'B1', versionName: '默认', source })
  const selection = { galaxy: 'g11', node: 'B1', version: 'default', common: 'default' }
  const loaded = await api.load(selection)
  const both = setGalaxyMod(setGalaxyMod(loaded.common, 'CorvetteRapidFire', true), TM_MOD, true)
  await api.saveCommon(selection, both)
  expect((await createBrowserApi().load(selection)).common.galaxy_mods).toEqual(['CorvetteRapidFire', TM_MOD])
  await expect(api.saveCommon(source, both)).rejects.toThrow('仅适用于 G11')
  await api.save(selection, {
    ...loaded.node,
    baseline: {
      ...loaded.node.baseline,
      loadouts: { ...loaded.node.baseline.loadouts, Corvette: { primary: TM_MOD, secondary: 'ShieldMod' } },
    },
  })
  const request = { ...selection, versionName: '默认', commonName: '默认', search: loaded.node.search }
  await expect(api.run(request)).resolves.toBeDefined()
  await api.saveCommon(selection, setGalaxyMod(both, TM_MOD, false))
  expect((await api.load(selection)).common.galaxy_mods).toEqual(['CorvetteRapidFire'])
  await expect(api.run(request)).rejects.toThrow('Baseline 仍选择 TM')
  await expect(api.enqueueSearch(request)).rejects.toThrow('Baseline 仍选择 TM')
  await expect(api.rerunGalaxy('g11')).rejects.toThrow('Baseline 仍选择 TM')
  expect((await api.load(selection)).node.baseline.loadouts.Corvette.primary).toBe(TM_MOD)
})
