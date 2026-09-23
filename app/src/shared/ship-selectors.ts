export const SHIP_TYPES = [
  { id: 'Fighter', numeric: 1, name: '战斗机' },
  { id: 'Corvette', numeric: 2, name: '护卫舰' },
  { id: 'Frigate', numeric: 3, name: '驱逐舰' },
  { id: 'Cruiser', numeric: 4, name: '巡洋舰' },
  { id: 'HeavyCruiser', numeric: 5, name: '重型巡洋舰' },
] as const

export type ShipId = (typeof SHIP_TYPES)[number]['id']
export type ShipSelector = string | number

const byId = new Map<string, (typeof SHIP_TYPES)[number]>(SHIP_TYPES.map(item => [item.id, item]))
const byNumber = new Map<number, (typeof SHIP_TYPES)[number]>(SHIP_TYPES.map(item => [item.numeric, item]))

export function shipSelectorToId(value: unknown): ShipId | '' {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return ''
  if (typeof value === 'number') return byNumber.get(value)?.id ?? ''
  const text = String(value).trim()
  if (/^[1-5]$/.test(text)) return byNumber.get(Number(text))?.id ?? ''
  if (text === 'Heavy Cruiser') return 'HeavyCruiser'
  return (byId.get(text)?.id as ShipId | undefined) ?? ''
}

export function canonicalShipRecord<T>(record: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const canonical = shipSelectorToId(key) || key
    if (Object.hasOwn(result, canonical) && JSON.stringify(result[canonical]) !== JSON.stringify(value))
      throw new Error(`舰种 ${canonical} 存在冲突的别名字段（${key}）。请先合并配置。`)
    result[canonical] = value
  }
  return result
}

export function preserveShipSelectorFormat(previous: unknown, ship: ShipId | ''): ShipSelector {
  const numeric = ship ? byId.get(ship)!.numeric : 0
  if (typeof previous === 'number') return numeric
  if (typeof previous === 'string' && /^\d+$/.test(previous.trim())) return String(numeric)
  return ship
}

export function shipDisplayName(value: unknown, includeCode = true) {
  const id = shipSelectorToId(value)
  if (!id) return value === 0 || value === '0' || value === '' || value == null ? '空位' : String(value)
  const item = byId.get(id)!
  return includeCode ? `${item.name}（${item.id} · ${item.numeric}）` : item.name
}
