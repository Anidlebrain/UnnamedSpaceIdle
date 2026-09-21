import type { OptimizerConfig } from './schemas'

export type ModSlot = 'primary' | 'secondary' | 'tertiary'

type ModDefinition = {
  id: string
  ship: string
  slot: ModSlot
  zh: string
  en: string
  manuallySelectable: boolean
}

// Derived from game_data.cdb UnlockFleetShipMod effects and the recovered
// Fleet.get_ship_mods slot rules. Scoped tertiary Mods are automatic in
// Standard Galaxy battles, so they are documented but not manually selectable.
export const MOD_CATALOG: readonly ModDefinition[] = [
  {
    id: 'FighterMiniRailgunMod',
    ship: 'Fighter',
    slot: 'primary',
    zh: '小型轨道炮',
    en: 'Fighter Mini Railgun',
    manuallySelectable: true,
  },
  {
    id: 'CorvetteChargeLaserMod',
    ship: 'Corvette',
    slot: 'primary',
    zh: '充能激光',
    en: 'Corvette Charge Laser',
    manuallySelectable: true,
  },
  { id: 'ShieldMod', ship: 'Corvette', slot: 'secondary', zh: '护盾强化', en: 'Shields', manuallySelectable: true },
  {
    id: 'FrigateMissileMod',
    ship: 'Frigate',
    slot: 'primary',
    zh: '导弹',
    en: 'Frigate Missiles',
    manuallySelectable: true,
  },
  { id: 'ArmorMod', ship: 'Frigate', slot: 'secondary', zh: '装甲强化', en: 'Armor', manuallySelectable: true },
  {
    id: 'CruiserParticleCannonMod',
    ship: 'Cruiser',
    slot: 'primary',
    zh: '粒子炮',
    en: 'Cruiser Particle Cannon',
    manuallySelectable: true,
  },
  {
    id: 'CruiserSingleArmorTank',
    ship: 'Cruiser',
    slot: 'secondary',
    zh: '单舰装甲坦克',
    en: 'Single Armored Cruiser',
    manuallySelectable: true,
  },
  {
    id: 'HeavyCruiserBeamMod',
    ship: 'HeavyCruiser',
    slot: 'primary',
    zh: '光束激光',
    en: 'Heavy Cruiser Beam Laser',
    manuallySelectable: true,
  },
  {
    id: 'CorvetteRapidFire',
    ship: 'Corvette',
    slot: 'tertiary',
    zh: '快速射击',
    en: 'Rapid Fire',
    manuallySelectable: false,
  },
] as const

const byId = new Map(MOD_CATALOG.map(mod => [mod.id, mod]))

export function modDisplayName(id: string, includeId = false) {
  const mod = byId.get(id)
  if (!mod) return id
  return `${mod.zh}（${mod.en}${includeId ? ` · ${id}` : ''}）`
}

export function catalogMods(ship: string, slot: ModSlot) {
  return MOD_CATALOG.filter(mod => mod.ship === ship && mod.slot === slot && mod.manuallySelectable)
}

export function slotOptions(config: OptimizerConfig, ship: string, slot: ModSlot): Array<string | null> {
  const slots = config.allowed_mod_slots[ship]
  const options = slots?.[slot]
  return Array.isArray(options) ? options : [null]
}

export function resolveModSelector(value: unknown, options: Array<string | null>): string | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    return options[Number(value)] ?? null
  }
  return String(value)
}

export function preserveModSelectorFormat(
  previous: unknown,
  next: string | null,
  options: Array<string | null>,
): string | number | null {
  if (typeof previous === 'number' || (typeof previous === 'string' && /^\d+$/.test(previous.trim()))) {
    const index = options.findIndex(option => option === next)
    const numeric = index >= 0 ? index : 0
    return typeof previous === 'number' ? numeric : String(numeric)
  }
  return next
}
