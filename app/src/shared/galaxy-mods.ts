import { commonConfigSchema, type CommonConfig, type NodeConfig, type OptimizerConfig } from './schemas'
import { resolveModSelector, slotOptions, type ModSlot } from './mod-catalog'
import { GALAXY_MOD_DEFINITIONS, isGalaxyPrimary } from './galaxy-mod-catalog'
export const TM_MOD = 'CorvetteChargeLaserBurst'
type GalaxyMod = NonNullable<CommonConfig['galaxy_mods']>[number]
type TravelModState = Pick<NodeConfig, 'galaxy' | 'travel_mod_unlocked'>

export function travelModForGalaxy(galaxy: number) {
  return GALAXY_MOD_DEFINITIONS.find(mod => mod.galaxy === galaxy && mod.slot === 'primary')
}

export function commonWithTravelMod(node: TravelModState, common: CommonConfig): CommonConfig {
  const mod = travelModForGalaxy(node.galaxy)
  return mod && node.travel_mod_unlocked ? setGalaxyMod(common, mod.id, true) : common
}

export function commonForGalaxy(common: CommonConfig, galaxy: string): CommonConfig {
  const parsed = commonConfigSchema.parse(common)
  for (const id of parsed.galaxy_mods ?? []) {
    const mod = GALAXY_MOD_DEFINITIONS.find(item => item.id === id)!
    if (Number(galaxy.slice(1)) !== mod.galaxy)
      throw new Error(`${mod.label} 星系 Mod 仅适用于 G${mod.galaxy}。请在来源 Common 关闭后再复制到其他 Galaxy。`)
  }
  return parsed
}

export function nodeForCopy(source: NodeConfig, galaxy: string, node: string): NodeConfig {
  const galaxyNumber = Number(galaxy.slice(1))
  const copy = { ...source, galaxy: galaxyNumber, node: node.replace(/_num$/i, '') }
  if (source.galaxy !== galaxyNumber) delete copy.travel_mod_unlocked
  return copy
}

export function hasCrf(common: CommonConfig | null | undefined, galaxy: number): boolean {
  return galaxy === 11 && Boolean(common?.galaxy_mods?.includes('CorvetteRapidFire'))
}
export function setGalaxyMod(common: CommonConfig, mod: GalaxyMod, unlocked: boolean): CommonConfig {
  const mods = (common.galaxy_mods ?? []).filter(item => item !== mod)
  return { ...common, galaxy_mods: unlocked ? [...mods, mod] : mods }
}
// These are selectable IDs only. Decode existing numeric selectors with raw slotOptions.
export function nodeSlotOptions(
  optimizer: OptimizerConfig,
  node: TravelModState,
  ship: string,
  slot: ModSlot,
): Array<string | null> {
  const original = slotOptions(optimizer, ship, slot)
  const options = original.filter(mod => !GALAXY_MOD_DEFINITIONS.some(def => def.id === mod))
  const mod = travelModForGalaxy(node.galaxy)
  if (mod?.ship === ship && slot === 'primary' && node.travel_mod_unlocked) options.push(mod.id)
  return options.length === 0 && original.some(isGalaxyPrimary) ? [null] : options
}
export function validateGalaxyLoadouts(node: NodeConfig, common: CommonConfig, optimizer: OptimizerConfig): void {
  commonForGalaxy(common, `g${node.galaxy}`)
  for (const [ship, loadout] of Object.entries(node.baseline.loadouts)) {
    for (const slot of ['primary', 'secondary', 'tertiary'] as const) {
      const ids =
        slot === 'tertiary'
          ? [...(loadout.tertiary ?? []), ...(loadout.tertiary_mods ?? [])]
          : [resolveModSelector(loadout[slot], slotOptions(optimizer, ship, slot))]
      for (const id of ids) {
        // G11 messages below remain specific to the existing controls.
        if (id === TM_MOD) continue
        const mod = GALAXY_MOD_DEFINITIONS.find(item => item.id === id)
        if (
          mod &&
          (mod.ship !== ship ||
            mod.slot !== slot ||
            mod.galaxy !== node.galaxy ||
            !(mod.slot === 'primary' ? node.travel_mod_unlocked : common.galaxy_mods?.includes(mod.id)))
        )
          throw new Error(
            `${mod.label} 需要在 G${mod.galaxy} ${mod.slot === 'primary' ? '节点环境' : 'Common'}中解锁，且只能用于 ${mod.ship} ${mod.slot}。`,
          )
      }
    }
    if (
      resolveModSelector(loadout.secondary, slotOptions(optimizer, ship, 'secondary')) === TM_MOD ||
      loadout.tertiary?.includes(TM_MOD) ||
      loadout.tertiary_mods?.includes(TM_MOD)
    )
      throw new Error('TM（CorvetteChargeLaserBurst）只能装备在护卫舰 Primary，不能放入 Secondary 或 Tertiary。')
    if (
      resolveModSelector(loadout.primary, slotOptions(optimizer, ship, 'primary')) === TM_MOD &&
      (ship !== 'Corvette' || node.galaxy !== 11 || !node.travel_mod_unlocked)
    )
      throw new Error(
        'Baseline 仍选择 TM（CorvetteChargeLaserBurst），但当前节点的本次旅行 TM 未解锁。请在 G11 节点环境开启并保存 TM，或将护卫舰 Primary 改为其他模组。',
      )
  }
}
