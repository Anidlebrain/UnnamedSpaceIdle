export const FORMATION_ROWS = [1, 2, 3, 4, 5] as const
export const DEFAULT_FORMATION_COLUMNS = 2
export const MAX_FORMATION_COLUMNS = 26

export function formationColumns(value: number | undefined): number {
  return value ?? DEFAULT_FORMATION_COLUMNS
}

export function formationColumnLabels(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String.fromCharCode(65 + index))
}

export function validFormationPosition(position: string, count: number): boolean {
  const match = /^([A-Z])([1-5])$/.exec(position)
  return match !== null && match[1].charCodeAt(0) - 65 < count
}

export function resultFormationColumns(
  baseConfig: Record<string, unknown> | undefined,
  snapshotColumns?: number,
): number {
  const grid = baseConfig?.grid_size
  const width = Array.isArray(grid) ? grid[0] : undefined
  if (typeof width === 'number' && Number.isInteger(width) && width >= 1 && width <= MAX_FORMATION_COLUMNS) return width
  return formationColumns(snapshotColumns)
}

export function formationResultError(
  formation: { position: string }[],
  baseConfig: Record<string, unknown> | undefined,
  columns: number,
): string | null {
  if (resultFormationColumns(baseConfig, columns) !== columns)
    return `Best Found 的阵型列数与目标配置 ${columns} 列不一致。`
  const occupied = new Set<string>()
  for (const entry of formation) {
    if (!validFormationPosition(entry.position, columns))
      return `Best Found 位置 ${entry.position} 超出目标阵型 ${columns} 列 × 5 行范围。`
    if (occupied.has(entry.position)) return `Best Found 包含重复位置 ${entry.position}。`
    occupied.add(entry.position)
  }
  return null
}
