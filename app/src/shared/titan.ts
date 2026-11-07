import { z } from 'zod'
export const TITAN_LAYERS = ['surface', 'antumbra', 'penumbra', 'umbra'] as const
export const TITAN_CORES = ['TitanLaser', 'TitanCannon', 'TitanShockwaveCannon', 'TitanShield', 'TitanArray'] as const
const layerSchema = z.enum(TITAN_LAYERS)
const nonnegativeInteger = z.number().finite().int().nonnegative()
const positive = z.number().finite().positive()
const capsSchema = z
  .object({
    TitanLaser: nonnegativeInteger.optional(),
    TitanCannon: nonnegativeInteger.optional(),
    TitanShockwaveCannon: nonnegativeInteger.optional(),
    TitanShield: nonnegativeInteger,
    TitanArray: nonnegativeInteger,
  })
  .strict()
  .refine(caps => TITAN_CORES.slice(0, 3).some(key => key in caps), '至少需要一种已解锁的普通武器。')
export const titanPlayerSchema = z
  .object({
    statistics: z
      .object({
        game_version: z.enum(['0.90.0.1', '0.85.1.0']).optional(),
        reference_layer: layerSchema,
        temporary_combat_effects_active: z.literal(false),
        summary_stats: z
          .object({ titan_damage: positive, titan_max_shields: positive, array_capacity: positive })
          .strict(),
        alignment: z
          .object({ antumbra: z.number().finite().nonnegative(), penumbra: z.number().finite().nonnegative() })
          .strict(),
        reference_array_level: nonnegativeInteger,
        reference_array_base_damage: positive,
        core_level_caps: capsSchema,
      })
      .strict(),
    progress: z
      .object({
        highest_sectors: z
          .object({
            surface: nonnegativeInteger.min(160),
            antumbra: nonnegativeInteger,
            penumbra: nonnegativeInteger,
            umbra: nonnegativeInteger,
          })
          .strict(),
        umbra_sector_number: nonnegativeInteger,
        reintegration: z.boolean(),
        galaxy12_unlocked: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((player, context) => {
    if (player.statistics.core_level_caps.TitanArray < player.statistics.reference_array_level)
      context.addIssue({
        code: 'custom',
        path: ['statistics', 'core_level_caps', 'TitanArray'],
        message: '阵列可达等级不得低于读数等级。',
      })
    if (!player.progress.reintegration && player.progress.umbra_sector_number !== 0)
      context.addIssue({
        code: 'custom',
        path: ['progress', 'umbra_sector_number'],
        message: '未解锁再整合时本影合并边界必须为 0。',
      })
    if (player.statistics.game_version === '0.90.0.1' && player.progress.galaxy12_unlocked === undefined)
      context.addIssue({
        code: 'custom',
        path: ['progress', 'galaxy12_unlocked'],
        message: '0.90 档案必须明确填写 Galaxy 12 解锁状态。',
      })
  })
const executablePath = z
  .string()
  .max(4096)
  .refine(value => !/[\r\n\x00"%]/.test(value), '路径包含不支持的字符。')
export const titanSettingsSchema = z
  .object({
    godotPath: executablePath,
    sourcePath: executablePath,
    sector: z.string().regex(/^[A-Za-z0-9_-]+$/, '区域只能包含字母、数字、下划线和连字符。'),
    layer: layerSchema,
    mode: z.enum(['boss_once', 'farm_distance']),
    budgetSeconds: positive,
    clock: z.enum(['fixed', 'realtime']),
    seed: nonnegativeInteger.max(2147483647),
    distanceStep: positive.int(),
    bossSeconds: positive,
    farmSeconds: positive.min(120),
    farmCycles: nonnegativeInteger.min(10),
  })
  .strict()
const titanCoreSchema = z.object({ id: z.string(), level: nonnegativeInteger, milestones: z.record(z.string()) })
export const titanCandidateSchema = z.object({
  weapons: z
    .array(
      titanCoreSchema.extend({
        id: z.enum(['TitanLaser', 'TitanCannon', 'TitanShockwaveCannon']),
        targeting: z.object({ type: z.string(), priority: z.string(), swapping: z.string(), overlap: z.string() }),
      }),
    )
    .length(3),
  shield: titanCoreSchema.extend({ id: z.literal('TitanShield') }),
  array_core: titanCoreSchema.extend({ id: z.literal('TitanArray') }),
  array_capacity: z.number().finite().nonnegative(),
  sequence: z.array(z.object({ id: z.string(), targets: z.array(z.string()) })).min(1),
})
export type TitanPlayer = z.infer<typeof titanPlayerSchema>
export type TitanSettings = z.infer<typeof titanSettingsSchema>
export type TitanLayer = (typeof TITAN_LAYERS)[number]
export const DEFAULT_TITAN_SETTINGS: TitanSettings = {
  godotPath: '',
  sourcePath: '',
  sector: '160',
  layer: 'surface',
  mode: 'boss_once',
  budgetSeconds: 180,
  clock: 'fixed',
  seed: 12345,
  distanceStep: 20,
  bossSeconds: 90,
  farmSeconds: 120,
  farmCycles: 10,
}
export type TitanWorkspace = {
  player: TitanPlayer | null
  settings: TitanSettings
  playerSource: 'manager' | 'local' | 'none'
  importError?: string
}
export type TitanInspection = {
  status: string
  game_version: string
  cores: Record<string, { name?: string; [key: string]: unknown }>
  milestones: Record<string, Record<string, Array<{ id: string; name?: string; [key: string]: unknown }>>>
  array_elements: Record<string, { name?: string; [key: string]: unknown }>
  targeting: Record<string, string[]>
  region: {
    sector: number
    sector_id: string
    layer: TitanLayer
    distance_start: number
    distance_end: number
    array_targets: Array<{ id: string; system: string; number: number }>
    [key: string]: unknown
  }
  [key: string]: unknown
}
export type TitanResult = {
  status: string
  mode: TitanSettings['mode']
  region: TitanInspection['region']
  trials?: number
  wall_seconds?: number
  best?: {
    distance: number
    candidate: Record<string, unknown>
    battle?: Record<string, unknown>
    validation?: Array<{ seed: number; battle: Record<string, unknown> }>
    [key: string]: unknown
  } | null
  [key: string]: unknown
}
export type TitanRequest = { player: TitanPlayer; settings: TitanSettings }
export type TitanTask = {
  id: string
  status: 'running' | 'success' | 'no_result' | 'failed' | 'canceled'
  startedAt: string
  finishedAt?: string
  request: TitanRequest
  logs: string
  inspection?: TitanInspection
  result?: TitanResult
  resultText?: string
  resultDirectory: string
  exitCode?: number
  error?: string
}
export type TitanApi = {
  load(): Promise<TitanWorkspace>
  savePlayer(player: TitanPlayer): Promise<TitanPlayer>
  saveSettings(settings: TitanSettings): Promise<TitanSettings>
  inspect(request: { sector: string; layer: TitanLayer; source?: string }): Promise<TitanInspection>
  start(request: TitanRequest): Promise<TitanTask>
  current(): Promise<TitanTask | null>
  stop(): Promise<void>
  onTask(listener: (task: TitanTask) => void): () => void
}
