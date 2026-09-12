# OVERDEPLOY SOURCE OF TRUTH

适用版本：Unnamed Space Idle 0.85.1.0 恢复工程。

## 正式部署路径

1. `Fleet.get_fleet_ships_available()` 在 `fleet/Fleet.gd:2178` 构造每个已解锁舰种的 `amount` 与可用 Mod。
2. `ShipSelectionArea.setup_ship_buttons()` 在 `fleet/ShipSelectionArea.gd:37` 默认过滤 `amount <= 0`；`FleetBattle.set_player_fleet_from_bcd()` 在 `fleet/FleetBattle.gd:288` 也会删除不存在或 `amount == 0` 的舰种。
3. 标准 Galaxy 的拖拽部署入口 `FleetBattle._on_DeploymentSelectionArea_deploy_from_drag()` 在 `fleet/FleetBattle.gd:2348` 调用 `check_player_deployment_available(..., allow_over_deployment = !Fleet.ut_mode)`，因此非 UT 正式战斗允许 Overdeploy。
4. `FleetBattle.calc_total_deployment()` 在 `fleet/FleetBattle.gd:1941` 是 committed FR 的最终来源；Optimizer 的预剪枝通过完整 FleetBattle Scene 调用它，不复制公式。
5. 开战时 `FleetBattle._on_btnStart_pressed()` 在 `fleet/FleetBattle.gd:700` 把当前部署总额写入 `fleet_resources_committed`。

## 0.85.1.0 实际成本

设单个 deployment group 的原版基础成本为 `C`，当前可正常部署数量为 `A`，这是同舰种第 `k` 组：

- `k <= A`：成本 `C`。
- `k > A`：成本 `C × (1 + k - A)`。

因此第一组 Overdeploy 为 `2C`，下一组为 `3C`，再下一组为 `4C`。Cruiser 的 `C = 20`、`A = 1` 时：

- 1 组：`20`
- 2 组累计：`20 + 40 = 60`
- 5 组累计：`20 + 40 + 60 + 80 + 100 = 300`

这由原版 `calc_total_deployment()` 实测报价确认。Wiki 两种描述中，“Overdeploy 首组为正常 FR 的 2 倍且附加资源自动损失”更接近当前源码；“每艘固定增加 10 FR”不符合 0.85.1.0。第一种描述仍不完整，因为后续 Overdeploy 组依次为 3×、4×……，不都固定为 2×。

## 自动损失与最终 used FR

`ShipDeploymentGroup.deploy_ships()` 在 `fleet/ShipDeploymentGroup.gd:75` 为组内所有物理舰船分配的 `fleet_resources_value_max` 总和只有基础成本 `C`，不包含 Overdeploy 附加 committed FR。

`FleetBattle.update_fleet_resources_retained()` 在 `fleet/FleetBattle.gd:912` 汇总仍存活舰船的该基础价值，再应用 Fleet Resources Retention。`FleetShip.calc_fleet_resources_value()` 在 `fleet/ships/FleetShip.gd:704` 根据 Hull 损伤降低可保留价值；舰船死亡时变为 0。

最终：

`fleet_resources_used = fleet_resources_committed - fleet_resources_retained`

所以 Overdeploy 附加部分没有对应的可保留价值，无论舰船是否幸存都会自然进入 used FR；基础成本部分仍按存活、Hull 状态与 retention 结算。Optimizer 的 Boss efficiency 使用 Runner 返回的最终真实 `fleet_resources_used`，没有另加 Overdeploy 惩罚。

## ships_available 与 available=0

`ships_available.amount` 是“不触发 Overdeploy 的正常 deployment group 数”，不是最大部署数。标准 Galaxy 允许超过它，前提是舰种仍可部署、有空格且原版 committed FR 不超过玩家当前 FR。

当 amount 为 0 时，正式 UI 不生成该舰种部署按钮，历史阵型恢复也会删除该舰种。因此 Optimizer 将其表示为：

```json
{"enabled": false, "available": 0}
```

它不会把 0 解释为“第一组就开始 Overdeploy”。这与标准 Galaxy 的用户可达路径一致。

## Loadout 与 Tertiary

`Fleet.get_ship_mods()` 在 `fleet/Fleet.gd:2435` 先读取每舰种唯一的 Primary/Secondary 选择，再按 Galaxy scope 自动加入 Tertiary。Optimizer 只枚举 Primary 与 Secondary 的笛卡尔积；`null` 是正式候选，同槽最多选择一个 Mod。Unstable Transit Mod 与 Standard-Galaxy 自动 Tertiary 均不进入手动槽位搜索。
