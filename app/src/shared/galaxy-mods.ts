import { commonConfigSchema, type CommonConfig, type NodeConfig, type OptimizerConfig } from './schemas'
import { resolveModSelector, slotOptions, type ModSlot } from './mod-catalog'
export const TM_MOD = 'CorvetteChargeLaserBurst'
type GalaxyMod = NonNullable<CommonConfig['galaxy_mods']>[number]
export function commonForGalaxy(common: CommonConfig, galaxy: string): CommonConfig {
  const parsed = commonConfigSchema.parse(common)
  if (Number(galaxy.slice(1)) !== 11 && parsed.galaxy_mods?.length)
    throw new Error(
      'CRF / TM 星系 Mod 仅适用于 G11。请先在来源 Common 关闭 CRF 和 TM，再复制到其他 Galaxy；或移除 galaxy_mods 后保存。',
    )
  return parsed
}
export function hasCrf(common: CommonConfig | null | undefined, galaxy: number): boolean {
  return galaxy === 11 && Boolean(common?.galaxy_mods?.includes('CorvetteRapidFire'))
}
export function hasTm(common: CommonConfig | null | undefined, galaxy: number): boolean {
  return galaxy === 11 && Boolean(common?.galaxy_mods?.includes(TM_MOD))
}
export function setGalaxyMod(common: CommonConfig, mod: GalaxyMod, unlocked: boolean): CommonConfig {
  const mods = (common.galaxy_mods ?? []).filter(item => item !== mod)
  return { ...common, galaxy_mods: unlocked ? [...mods, mod] : mods }
}
// These are selectable IDs only. Decode existing numeric selectors with raw slotOptions.
export function nodeSlotOptions(
  optimizer: OptimizerConfig,
  common: CommonConfig | null,
  galaxy: number,
  ship: string,
  slot: ModSlot,
): Array<string | null> {
  const original = slotOptions(optimizer, ship, slot)
  const options = original.filter(mod => mod !== TM_MOD)
  if (ship === 'Corvette' && slot === 'primary' && hasTm(common, galaxy)) return [...options, TM_MOD]
  return options.length === 0 && original.includes(TM_MOD) ? [null] : options
}
export function validateGalaxyLoadouts(node: NodeConfig, common: CommonConfig, optimizer: OptimizerConfig): void {
  commonForGalaxy(common, `g${node.galaxy}`)
  for (const [ship, loadout] of Object.entries(node.baseline.loadouts)) {
    if (
      resolveModSelector(loadout.secondary, slotOptions(optimizer, ship, 'secondary')) === TM_MOD ||
      loadout.tertiary?.includes(TM_MOD) ||
      loadout.tertiary_mods?.includes(TM_MOD)
    )
      throw new Error('TM（CorvetteChargeLaserBurst）只能装备在护卫舰 Primary，不能放入 Secondary 或 Tertiary。')
    if (
      resolveModSelector(loadout.primary, slotOptions(optimizer, ship, 'primary')) === TM_MOD &&
      (ship !== 'Corvette' || !hasTm(common, node.galaxy))
    )
      throw new Error(
        'Baseline 仍选择 TM（CorvetteChargeLaserBurst），但当前 G11 Common 的本次旅行 TM 未解锁。请开启并保存 TM，或将护卫舰 Primary 改为其他模组。',
      )
  }
}
