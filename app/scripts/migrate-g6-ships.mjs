import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = join(appRoot, 'data')
const galaxyRoot = join(dataRoot, 'galaxies', 'g6')
const commonPath = join(galaxyRoot, 'common', 'versions', 'default.json')
const base = { Fighter: 1, Corvette: 2, Frigate: 1, Cruiser: 1, HeavyCruiser: 0 }
const shipNames = Object.keys(base)

const canonical = key => (key === 'Heavy Cruiser' || key === '5' ? 'HeavyCruiser' : key)
const counts = record => {
  const result = {}
  for (const [key, value] of Object.entries(record)) {
    const ship = canonical(key)
    if (!shipNames.includes(ship) || result[ship] !== undefined || !Number.isInteger(value) || value < 0)
      throw new Error(`Unsupported or conflicting ship count: ${key}`)
    result[ship] = value
  }
  return result
}

const nodeRoot = join(galaxyRoot, 'nodes')
const files = []
for (const node of await readdir(nodeRoot, { withFileTypes: true })) {
  if (!node.isDirectory()) continue
  const versions = join(nodeRoot, node.name, 'versions')
  for (const version of await readdir(versions)) {
    if (version.endsWith('.json')) files.push(join(versions, version))
  }
}
files.sort()

const common = JSON.parse(await readFile(commonPath, 'utf8'))
if (common.ships !== undefined) throw new Error('G6 common.ships already exists; migration was not repeated.')
const changes = []
for (const path of files) {
  const old = await readFile(path, 'utf8')
  const node = JSON.parse(old)
  if (node.galaxy !== 6 || node.node !== path.split(/[\\/]/).at(-3)) throw new Error(`Node identity mismatch: ${path}`)
  const current = counts(node.player_state.ships)
  const extra = {}
  for (const ship of shipNames) {
    const total = current[ship] ?? 0
    if (total < base[ship]) throw new Error(`G6 ${node.node} has fewer ${ship} than the proposed common count.`)
    extra[ship] = total - base[ship]
  }
  node.player_state.ships = extra
  changes.push({ path, old, next: `${JSON.stringify(node, null, 2)}\n`, effective: current })
}
const nextCommon = `${JSON.stringify({ ...common, ships: base }, null, 2)}\n`
const backupRoot = join(appRoot, 'runtime', `g6-ships-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
for (const path of [commonPath, ...files]) {
  const backupPath = join(backupRoot, relative(dataRoot, path))
  await mkdir(dirname(backupPath), { recursive: true })
  await copyFile(path, backupPath)
}
const writeAtomic = async (path, content) => {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
}
try {
  for (const change of changes) await writeAtomic(change.path, change.next)
  await writeAtomic(commonPath, nextCommon)
  for (const change of changes) {
    const node = JSON.parse(await readFile(change.path, 'utf8'))
    const extra = counts(node.player_state.ships)
    for (const ship of shipNames) {
      if (base[ship] + extra[ship] !== (change.effective[ship] ?? 0))
        throw new Error(`Effective count changed: ${change.path} ${ship}`)
    }
  }
} catch (error) {
  for (const path of [commonPath, ...files]) {
    const backupPath = join(backupRoot, relative(dataRoot, path))
    await copyFile(backupPath, path)
  }
  throw error
}
console.log(`Migrated ${files.length} G6 Node Versions and default Common. Backup: ${backupRoot}`)
