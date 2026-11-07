// Native 0.90.0.1 upgrades2 UnlockFleetShipMod targets. No player progress inferred.
export const GALAXY_MOD_IDS = [
  'CorvetteRapidFire',
  'CorvetteChargeLaserBurst',
  'FrigateHealthBoost',
  'FrigateRapidMissileMod',
  'FighterBarrier',
  'FighterJumpGatling',
] as const
export const GALAXY_MOD_DEFINITIONS = [
  { id: 'CorvetteRapidFire', galaxy: 11, ship: 'Corvette', slot: 'tertiary', label: 'CRF 快速开火' },
  { id: 'CorvetteChargeLaserBurst', galaxy: 11, ship: 'Corvette', slot: 'primary', label: 'TM 连发充能激光' },
  { id: 'FrigateHealthBoost', galaxy: 12, ship: 'Frigate', slot: 'tertiary', label: 'FHB Frigate Health Boost' },
  { id: 'FrigateRapidMissileMod', galaxy: 12, ship: 'Frigate', slot: 'primary', label: 'TM Frigate Rapid Missiles' },
  { id: 'FighterBarrier', galaxy: 13, ship: 'Fighter', slot: 'tertiary', label: 'FB Fighter Barrier' },
  { id: 'FighterJumpGatling', galaxy: 13, ship: 'Fighter', slot: 'primary', label: 'TM Fighter Jump Gatling' },
] as const
export function isGalaxyPrimary(id: unknown): boolean {
  return GALAXY_MOD_DEFINITIONS.some(mod => mod.id === id && mod.slot === 'primary')
}
