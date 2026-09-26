import { z } from 'zod'
import { canonicalShipRecord, shipSelectorToId } from './ship-selectors'
import { formationColumns, MAX_FORMATION_COLUMNS, validFormationPosition } from './formation-grid'

const normalizeNodeShips = (input: unknown): unknown => {
  if (!input || typeof input !== 'object') return input
  const value = structuredClone(input) as Record<string, any>
  if (value.player_state?.ships) value.player_state.ships = canonicalShipRecord(value.player_state.ships)
  if (value.baseline?.loadouts) value.baseline.loadouts = canonicalShipRecord(value.baseline.loadouts)
  if (value.baseline?.formation)
    value.baseline.formation = Object.fromEntries(
      Object.entries(value.baseline.formation).map(([position, ship]) => [
        position,
        typeof ship === 'string' && !/^\d+$/.test(ship.trim()) ? shipSelectorToId(ship) || ship : ship,
      ]),
    )
  if (value.baseline?.formation && value.baseline?.loadouts) {
    const numeric = Object.values(value.baseline.formation).some(
      ship => typeof ship === 'number' || (typeof ship === 'string' && /^[0-5]$/.test(ship.trim())),
    )
    for (const selector of Object.values(value.baseline.formation)) {
      const ship = shipSelectorToId(selector)
      if (ship && !Object.hasOwn(value.baseline.loadouts, ship))
        value.baseline.loadouts[ship] = { primary: numeric ? 0 : null, secondary: numeric ? 0 : null }
    }
  }
  return value
}

const normalizeCommonShips = (input: unknown): unknown => {
  if (!input || typeof input !== 'object') return input
  const value = structuredClone(input) as Record<string, any>
  if (value.ships) value.ships = canonicalShipRecord(value.ships)
  return value
}

export const jsonObject = z.object({}).passthrough()
const scaleSchema = jsonObject.extend({ damage_scale: z.number(), health_scale: z.number() })
// The Optimizer accepts both internal Mod IDs and the documented numeric Mod
// indexes in Manager node configurations. Results themselves remain string IDs.
const loadoutSchema = jsonObject.extend({
  primary: z.union([z.string(), z.number()]).nullable().optional(),
  secondary: z.union([z.string(), z.number()]).nullable().optional(),
  tertiary: z.array(z.union([z.string(), z.number()])).optional(),
  tertiary_mods: z.array(z.string()).optional(),
})
export const searchConfigSchema = jsonObject.extend({
  profile: z.enum(['fast', 'balanced', 'exhaustive']),
  goal: z.enum(['best', 'beat_baseline']),
  simulation_clock: z.enum(['realtime', 'offline_fixed_step']),
  max_wall_seconds: z.number().positive(),
  max_simulations: z.number().int().positive(),
  workers: z.number().int().min(1).max(4),
})
const rawNodeConfigSchema = jsonObject
  .extend({
    galaxy: z.number().int(),
    node: z.string().min(1),
    formation_columns: z.number().int().min(1).max(MAX_FORMATION_COLUMNS).optional(),
    boss: jsonObject.optional(),
    hazards: z.array(z.unknown()).default([]),
    supports: z.array(z.unknown()).default([]),
    player_state: jsonObject.extend({
      fleet_resources: z.number(),
      ships: z.record(z.number().int().nonnegative()),
    }),
    baseline: jsonObject.extend({
      enabled: z.boolean(),
      formation: z.record(z.union([z.string(), z.number()])),
      loadouts: z.record(loadoutSchema),
      observed: jsonObject.optional(),
    }),
    // Kept in Friendly Nodes for direct CLI and legacy-data compatibility.
    // Fleet Manager replaces this object from its independent Search config only while staging a task.
    search: searchConfigSchema,
  })
  .superRefine((value, context) => {
    const columns = formationColumns(value.formation_columns)
    for (const [position, ship] of Object.entries(value.baseline.formation)) {
      if (ship === '' || ship === 0 || ship === '0' || validFormationPosition(position, columns)) continue
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseline', 'formation', position],
        message: `阵型位置 ${position} 超出 ${columns} 列 × 5 行范围`,
      })
    }
  })
export const nodeConfigSchema = z.preprocess(normalizeNodeShips, rawNodeConfigSchema)
export const commonConfigSchema = z.preprocess(
  normalizeCommonShips,
  jsonObject.extend({
    permanent: scaleSchema,
    temporary: scaleSchema,
    // Absent in older Galaxy data: those Nodes keep their original absolute ship counts.
    ships: z.record(z.number().int().nonnegative()).optional(),
  }),
)
const optimizerRangeSchema = jsonObject.extend({
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
})
const optimizerModOptionsSchema = z.array(z.string().min(1).nullable()).min(1)
const optimizerShipSlotsSchema = jsonObject.extend({
  primary: optimizerModOptionsSchema,
  secondary: optimizerModOptionsSchema,
  tertiary: optimizerModOptionsSchema.optional(),
})
const rawOptimizerConfigSchema = jsonObject.extend({
  objective: z.string().min(1),
  mode: z.string().min(1),
  ship_types: z.array(z.string().min(1)).min(1),
  group_ranges: z.record(optimizerRangeSchema),
  allowed_mod_slots: z.record(optimizerShipSlotsSchema),
  max_total_groups: z.number().int().positive(),
  max_groups_per_ship: z.record(z.number().int().nonnegative()),
  max_simulations: z.number().int().positive(),
  max_wall_seconds: z.number().positive(),
  top_n: z.number().int().positive(),
  kill_refine_top_n: z.number().int().positive(),
  kill_sequence_max_battles: z.number().int().positive(),
})
export const optimizerConfigSchema = z.preprocess(input => {
  if (!input || typeof input !== 'object') return input
  const value = structuredClone(input) as Record<string, any>
  if (Array.isArray(value.ship_types))
    value.ship_types = [...new Set(value.ship_types.map((ship: string) => shipSelectorToId(ship) || ship))]
  for (const field of ['group_ranges', 'allowed_mod_slots', 'max_groups_per_ship'])
    if (value[field]) value[field] = canonicalShipRecord(value[field])
  return value
}, rawOptimizerConfigSchema)
export const versionMetaSchema = z.object({
  default_version: z.string().min(1),
  versions: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
})
export const commonMetaSchema = z.object({
  default_profile: z.string().min(1),
  profiles: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
})
export const templateMetaSchema = z.object({
  templates: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
})
export const formationEntrySchema = z
  .object({
    position: z.string(),
    ship: z.string(),
    primary_mod: z.string().nullable().optional(),
    secondary_mod: z.string().nullable().optional(),
    tertiary_mods: z.array(z.string()).optional(),
  })
  .passthrough()
const rawCandidateSchema = z
  .object({
    formation_key: z.string().optional(),
    formation: z.array(formationEntrySchema).default([]),
    ship_loadouts: z.record(loadoutSchema).optional(),
    fleet_resources_committed: z.number().nullable().optional(),
    fleet_resources_used: z.number().nullable().optional(),
    boss_damage: z.number().nullable().optional(),
    boss_damage_per_fr: z.number().nullable().optional(),
    refined_battles_to_kill: z.number().nullable().optional(),
    refined_total_kill_fr: z.number().nullable().optional(),
    outcome: z.string().optional(),
  })
  .passthrough()
export const candidateSchema = z.preprocess(input => {
  if (!input || typeof input !== 'object') return input
  const value = structuredClone(input) as Record<string, any>
  if (value.ship_loadouts) value.ship_loadouts = canonicalShipRecord(value.ship_loadouts)
  if (Array.isArray(value.formation))
    value.formation = value.formation.map((entry: Record<string, unknown>) => ({
      ...entry,
      ship: shipSelectorToId(entry.ship) || entry.ship,
    }))
  return value
}, rawCandidateSchema)
export const optimizerResultSchema = jsonObject.extend({
  best_result: candidateSchema.nullable().optional(),
  per_battle_best_result: candidateSchema.nullable().optional(),
  affordable_best_result: candidateSchema.nullable().optional(),
  affordable_kill_status: z.string().optional(),
  current_fleet_resources: z.number().optional(),
  verified_baseline: candidateSchema.nullable().optional(),
  improvement_vs_baseline: jsonObject.optional(),
  objective: z.string().optional(),
  recommendation_status: z.string().optional(),
  base_config: jsonObject.optional(),
})

export type NodeConfig = z.infer<typeof nodeConfigSchema>
export type SearchConfig = z.infer<typeof searchConfigSchema>
export type CommonConfig = z.infer<typeof commonConfigSchema>
export type OptimizerConfig = z.infer<typeof optimizerConfigSchema>
export type OptimizerResult = z.infer<typeof optimizerResultSchema>
