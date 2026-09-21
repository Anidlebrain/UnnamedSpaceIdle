import type { OptimizerResult } from './schemas'

export type FormationChange = {
  position: string
  field: 'ship' | 'primary' | 'secondary' | 'tertiary'
  before: unknown
  after: unknown
}
type Candidate = NonNullable<OptimizerResult['best_result']>
export function diffFormation(
  baseline: Candidate | null | undefined,
  best: Candidate | null | undefined,
): FormationChange[] {
  const before = new Map((baseline?.formation ?? []).map(entry => [entry.position, entry]))
  const after = new Map((best?.formation ?? []).map(entry => [entry.position, entry]))
  const positions = new Set([...before.keys(), ...after.keys()])
  const changes: FormationChange[] = []
  for (const position of positions) {
    const a = before.get(position)
    const b = after.get(position)
    for (const [field, key] of [
      ['ship', 'ship'],
      ['primary', 'primary_mod'],
      ['secondary', 'secondary_mod'],
      ['tertiary', 'tertiary_mods'],
    ] as const) {
      const left = a?.[key] ?? null
      const right = b?.[key] ?? null
      if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ position, field, before: left, after: right })
    }
  }
  return changes
}

export function hasFormationOrLoadoutChange(
  baseline: Candidate | null | undefined,
  best: Candidate | null | undefined,
): boolean {
  if (!baseline || !best) return false
  if (baseline.formation_key !== undefined && best.formation_key !== undefined)
    return baseline.formation_key !== best.formation_key
  return diffFormation(baseline, best).length > 0
}
