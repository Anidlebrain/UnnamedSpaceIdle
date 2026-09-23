export function runErrorSummary(error: unknown, canceled = false): string {
  if (canceled) return '搜索被用户中止'
  const text = String(error ?? '')
  if (/搜索被用户中止|cancell?ed by user/i.test(text)) return '搜索被用户中止'
  if (/舰种.*冲突|conflicting.*(ship|alias)/i.test(text)) return '舰种配置存在冲突'
  if (/Optimizer 公共配置.*变化/i.test(text)) return 'Optimizer 公共配置已变化'
  if (/baseline validation failed|invalid baseline|baseline.*(invalid|failed)/i.test(text)) return '基线配置无效'
  if (/fleet.resources|insufficient.*(resources|ships)|not enough.*(resources|ships)/i.test(text))
    return 'Fleet Resources 或舰船数量不足'
  if (/player.state|formation|loadout/i.test(text)) return '舰队状态与阵型/装配不匹配'
  if (/hazard/i.test(text)) return 'Hazards 配置无效'
  if (/support/i.test(text)) return 'Supports 配置无效'
  if (/boss|remaining.hp/i.test(text)) return 'Boss 配置无效'
  if (/result.*(invalid|format|identity)|invalid.*result/i.test(text)) return '结果文件格式无效'
  if (/no.*result|did not create|best.result|未生成/i.test(text)) return '搜索未生成有效结果'
  if (/timeout|timed.out|terminated|killed/i.test(text)) return '运行超时或被终止'
  return '未知运行错误'
}
