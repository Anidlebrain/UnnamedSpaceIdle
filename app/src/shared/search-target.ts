import type { NodeConfig, SearchConfig } from './schemas'

export function withoutNodeTarget(search: SearchConfig): SearchConfig {
  const result = { ...search }
  delete result.target_used_fr
  return result
}

export function searchForNode(search: SearchConfig, node: NodeConfig): SearchConfig {
  const result = withoutNodeTarget(search)
  if (!node.boss?.alive && node.search.target_used_fr != null) result.target_used_fr = node.search.target_used_fr
  return result
}
