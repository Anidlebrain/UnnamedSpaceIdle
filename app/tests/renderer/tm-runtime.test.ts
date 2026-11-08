import { afterEach, expect, it } from 'vitest'
import { createBrowserApi } from '../../src/renderer/web-runtime-api'
import { setGalaxyMod, TM_MOD } from '../../src/shared/galaxy-mods'

afterEach(() => localStorage.clear())
it('persists node TM, removes legacy Common TM and rejects locked baseline TM across browser entry points', async () => {
  const api = createBrowserApi()
  const source = { galaxy: 'g6', node: 'B12', version: 'default', common: 'default' }
  await api.createGalaxy({ galaxy: 'g11', node: 'B1', versionName: '默认', source })
  const selection = { galaxy: 'g11', node: 'B1', version: 'default', common: 'default' }
  const loaded = await api.load(selection)
  const both = setGalaxyMod(setGalaxyMod(loaded.common, 'CorvetteRapidFire', true), TM_MOD, true)
  await api.saveCommon(selection, both)
  expect((await createBrowserApi().load(selection)).common.galaxy_mods).toEqual(['CorvetteRapidFire'])
  await expect(api.saveCommon(source, both)).rejects.toThrow('仅适用于 G11')
  const tmNode = {
    ...loaded.node,
    baseline: {
      ...loaded.node.baseline,
      loadouts: { ...loaded.node.baseline.loadouts, Corvette: { primary: TM_MOD, secondary: 'ShieldMod' } },
    },
  }
  await api.save(selection, tmNode)
  const request = { ...selection, versionName: '默认', commonName: '默认', search: loaded.node.search }
  await expect(api.run(request)).rejects.toThrow('Baseline 仍选择 TM')
  await api.save(selection, { ...tmNode, travel_mod_unlocked: true })
  expect((await createBrowserApi().load(selection)).node.travel_mod_unlocked).toBe(true)
  await expect(api.run(request)).resolves.toBeDefined()
  await api.save(selection, { ...tmNode, travel_mod_unlocked: false })
  await expect(api.run(request)).rejects.toThrow('Baseline 仍选择 TM')
  await expect(api.enqueueSearch(request)).rejects.toThrow('Baseline 仍选择 TM')
  await expect(api.rerunGalaxy('g11')).rejects.toThrow('Baseline 仍选择 TM')
  expect((await api.load(selection)).node.baseline.loadouts.Corvette.primary).toBe(TM_MOD)
})
