# 当前资源 BOSS 搜索

## 目标与原有问题

`affordable_kill_cost` 使用完整原版战斗。排序目标依次是：

1. 已验证击杀优先；击杀方案比较累计实际 Used FR，成本相同优先较少场数。
2. 未找到击杀时比较当前资源内已验证累计伤害；伤害相同优先较少消耗、较少场数。

旧实现把该策略改名为 `kill_cost` 后，仍以 `ceil(HP / 单场伤害) × 单场消耗` 引导所有父阵型选择。该指标没有考虑剩余资源是否足够第二次部署。收尾只接纳完整击杀，全部失败便直接返回 baseline，甚至保留了 baseline 的超预算单次部署策略序列。

## 原版契约

恢复工程 `work/full_recovered/` 的证据：

- `fleet/Fleet.gd` 的开战路径每场复制 `fleet_setup`，重新部署敌舰。
- `fleet/interface/FleetEvent.gd:set_battle_complete` 从 `command_ship_health_left` 扣除本场 `boss_damage`。
- `fleet/FleetBattle.gd:calc_total_deployment` 计算部署费，包含 Overdeploy；开始战斗时必须付得起全部部署费。
- `fleet/FleetBattle.gd:update_fleet_resources_retained` 与原版舰船逻辑计算退款；Used FR 保留原始小数。
- `fleet/Fleet.gd:battle_complete` 通过 `PlayerInfo.gain_resource(..., -floor(resources_used))` 扣款。生产序列仍调用 `fleet_test.gd:native_fr_settlement`，不另造正式账本。

同时保留该策略原有约束：累计原始 Used FR 不得超过初始资源。部署钱包和原始总成本是两个独立条件。部署 70、实际消耗 40、钱包 100 时，虽然 `floor(100/40)=2`，第一场后钱包只有 60，不能再次部署相同阵型。不同阵型仍可能利用这 60 点资源继续战斗。

## 搜索方案

- 每次获得原版单场结果，立即把合法的正伤害结果保存为可执行的一场方案，不等待最终精炼。
- 交错探索全局数量组合、档案候选和局部变体。当前资源策略的局部搜索轮流使用单场最高伤害、钱包感知估计，以及不同可挑战次数/部署预算的父阵型。
- 同阵型场数估计逐步检查部署钱包与累计消耗。零消耗受 `kill_sequence_max_battles` 限制，避免无限循环。估计仅用于调度，不据此宣布击杀或判定其他阵型无解。
- 在线为有希望的重复阵型分配小段原版序列模拟，累计时间约限于总预算的 10%。
- 收尾采用有界序列探索：保留按伤害和剩余钱包分散的前缀，为每个前缀交错尝试高伤害、低成本和估计较好的后续阵型。逐场传入实际 HP、余额、阵型和装配，原版返回后再检查累计成本。支持换阵收尾及 N 场连续挑战。
- 缓存键包含实际战斗环境（含 HP、资源）与完整阵型，不把单场伤害机械相乘当成序列结果。并行 worker 复用于序列扩展。
- 模拟次数上限也约束序列精炼；最终正确性重放是强制步骤，可额外使用少量模拟。时间预留按已选方案场数和观测到的最长战斗估算。

无论完整击杀是否找到，已经验证的前缀都可作为伤害方案。候选池、前缀数和后续动作数均有界，可能遗漏最优混合序列；输出仍是 BEST FOUND / NO VERIFIED AFFORDABLE KILL，不宣称全局最优。

## 输出与使用

`boss_damage`、`fleet_resources_used`、`formation` 表示首场；`campaign_*`、`refined_fr_spent`、`boss_final_hp` 表示整体。每场的 `kill_sequence` 保存独立阵型和装配。最终重放核对每一场的伤害、Used FR、部署费、结果、钱包和 BOSS HP。

复制推荐只写入首场阵型。多场方案需按结果步骤换阵，并在实际完成一场后按游戏中剩余 HP / FR 更新节点输入。不会改写用户现有配置或自动执行战斗。

## 验证入口

```powershell
python tools/benchmark_preserved.py --label budget-logic --seconds 120 --extra --boss-budget-regression --battle-config=res://ui_ab_test_03_config.json
python tools/benchmark_preserved.py --label budget-native --seconds 600 --extra --v3-regression --validation-galaxies=6 --battle-config=res://ui_ab_test_03_config.json
```

策略测试使用明确的合成战斗响应验证调度与边界，账本调用原版；实战另用恢复场景验证，不能用合成测试代替战斗证据。测试输出在忽略的 `results/optimizer_v3/`，输入快照与原版代码哈希随基准保存。
