import { z } from 'zod'

export const jsonObject = z.object({}).passthrough()
const scaleSchema = jsonObject.extend({ damage_scale: z.number(), health_scale: z.number() })
// The Optimizer accepts both internal Mod IDs and the documented numeric Mod
// indexes in Manager node configurations. Results themselves remain string IDs.
const loadoutSchema = jsonObject.extend({
  primary: z.union([z.string(), z.number()]).nullable().optional(),
  secondary: z.union([z.string(), z.number()]).nullable().optional(),
  tertiary_mods: z.array(z.string()).optional(),
})
export const nodeConfigSchema = jsonObject.extend({
  galaxy: z.number().int(),
  node: z.string().min(1),
  boss: jsonObject.optional(),
  hazards: z.array(z.unknown()).default([]),
  supports: z.array(z.unknown()).default([]),
  player_state: jsonObject.extend({
    fleet_resources: z.number(),
    ships: z.record(z.union([z.number(), jsonObject.extend({ available: z.number(), enabled: z.boolean() })])),
  }),
  baseline: jsonObject.extend({
    enabled: z.boolean(),
    formation: z.record(z.union([z.string(), z.number()])),
    loadouts: z.record(loadoutSchema),
    observed: jsonObject.optional(),
  }),
  search: jsonObject.extend({
    profile: z.string(),
    goal: z.string(),
    simulation_clock: z.enum(['realtime', 'offline_fixed_step']),
    max_wall_seconds: z.number(),
    max_simulations: z.number(),
    workers: z.number(),
  }),
})
export const commonConfigSchema = jsonObject.extend({ permanent: scaleSchema, temporary: scaleSchema })
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
export const candidateSchema = z
  .object({
    formation_key: z.string().optional(),
    formation: z.array(formationEntrySchema).default([]),
    fleet_resources_used: z.number().nullable().optional(),
    outcome: z.string().optional(),
  })
  .passthrough()
export const optimizerResultSchema = jsonObject.extend({
  best_result: candidateSchema.nullable().optional(),
  verified_baseline: candidateSchema.nullable().optional(),
  improvement_vs_baseline: jsonObject.optional(),
  objective: z.string().optional(),
  recommendation_status: z.string().optional(),
  base_config: jsonObject.optional(),
})

export type NodeConfig = z.infer<typeof nodeConfigSchema>
export type CommonConfig = z.infer<typeof commonConfigSchema>
export type OptimizerResult = z.infer<typeof optimizerResultSchema>
