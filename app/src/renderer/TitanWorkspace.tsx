import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_TITAN_SETTINGS,
  TITAN_CORES,
  TITAN_LAYERS,
  titanPlayerSchema,
  titanSettingsSchema,
} from '../shared/titan'
import type { TitanApi, TitanInspection, TitanPlayer, TitanSettings, TitanTask } from '../shared/titan'
import { SmartSelect } from './SmartSelect'

const layers = { surface: '表象域', antumbra: '伪本影域', penumbra: '半影域', umbra: '本影域' }
const cores = {
  TitanLaser: '泰坦级激光',
  TitanCannon: '泰坦级加农炮',
  TitanShockwaveCannon: '冲击波加农炮',
  TitanShield: '泰坦级护盾',
  TitanArray: '泰坦级阵列',
}
const modeName = (mode: TitanSettings['mode']) => (mode === 'boss_once' ? '首领击杀' : '挂机距离')
const statusNames = {
  running: '搜索中',
  success: '已验证推荐',
  no_result: '预算内未找到',
  failed: '运行失败',
  canceled: '已停止',
}
const json = (value: unknown) => JSON.stringify(value, null, 2)
type ProfileDraft = Record<string, string>
function draftFromPlayer(player: TitanPlayer | null): ProfileDraft {
  if (!player) return { version: '0.90.0.1', referenceLayer: 'surface', reintegration: 'false', galaxy12: 'false' }
  const s = player.statistics,
    p = player.progress
  return {
    version: s.game_version ?? 'legacy',
    referenceLayer: s.reference_layer,
    damage: String(s.summary_stats.titan_damage),
    shields: String(s.summary_stats.titan_max_shields),
    capacity: String(s.summary_stats.array_capacity),
    antumbraAlignment: String(s.alignment.antumbra),
    penumbraAlignment: String(s.alignment.penumbra),
    referenceLevel: String(s.reference_array_level),
    arrayDamage: String(s.reference_array_base_damage),
    ...Object.fromEntries(Object.entries(s.core_level_caps).map(([key, value]) => [key, String(value)])),
    ...Object.fromEntries(Object.entries(p.highest_sectors).map(([key, value]) => [`highest_${key}`, String(value)])),
    boundary: String(p.umbra_sector_number),
    reintegration: String(p.reintegration),
    galaxy12: String(p.galaxy12_unlocked ?? false),
  }
}
function playerFromDraft(d: ProfileDraft): TitanPlayer {
  const number = (key: string) => {
    if (!d[key]?.trim()) throw new Error('请完整填写统计、校准、核心等级与本轮进度；未解锁层域或边界填 0。')
    const value = Number(d[key])
    if (!Number.isFinite(value)) throw new Error('数值必须有限，支持 2.20e20 等科学计数法。')
    return value
  }
  return titanPlayerSchema.parse({
    statistics: {
      ...(d.version === 'legacy' ? {} : { game_version: d.version }),
      reference_layer: d.referenceLayer,
      temporary_combat_effects_active: false,
      summary_stats: {
        titan_damage: number('damage'),
        titan_max_shields: number('shields'),
        array_capacity: number('capacity'),
      },
      alignment: { antumbra: number('antumbraAlignment'), penumbra: number('penumbraAlignment') },
      reference_array_level: number('referenceLevel'),
      reference_array_base_damage: number('arrayDamage'),
      core_level_caps: Object.fromEntries(
        TITAN_CORES.filter(key => key === 'TitanShield' || key === 'TitanArray' || d[key]?.trim()).map(key => [
          key,
          number(key),
        ]),
      ),
    },
    progress: {
      highest_sectors: Object.fromEntries(TITAN_LAYERS.map(key => [key, number(`highest_${key}`)])),
      umbra_sector_number: number('boundary'),
      reintegration: d.reintegration === 'true',
      galaxy12_unlocked: d.galaxy12 === 'true',
    },
  })
}
function errorText(error: unknown) {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ path: (string | number)[]; message: string }> }).issues
    return issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('\n')
  }
  return error instanceof Error ? error.message : String(error)
}

export function TitanWorkspace({ api, runtime }: { api?: TitanApi; runtime?: 'desktop' | 'web' }) {
  const [tab, setTab] = useState<'search' | 'profile'>('search')
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromPlayer(null))
  const [savedDraft, setSavedDraft] = useState('')
  const [player, setPlayer] = useState<TitanPlayer | null>(null)
  const [settings, setSettings] = useState<TitanSettings>(DEFAULT_TITAN_SETTINGS)
  const [task, setTask] = useState<TitanTask | null>(null)
  const [inspection, setInspection] = useState<TitanInspection | null>(null)
  const [inspectionKey, setInspectionKey] = useState('')
  const [source, setSource] = useState('none')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [raw, setRaw] = useState('')
  const taskRef = useRef<TitanTask | null>(null)
  const inspectionRef = useRef('')
  const inspectionTarget = `${settings.sourcePath}/${settings.sector}/${settings.layer}`
  inspectionRef.current = inspectionTarget
  const dirty = json(draft) !== savedDraft
  const running = task?.status === 'running'
  useEffect(() => {
    if (!api) return
    let active = true
    const unsubscribe = api.onTask(next => {
      if (active) {
        taskRef.current = next
        setTask(next)
      }
    })
    void Promise.all([api.load(), api.current()])
      .then(([workspace, current]) => {
        if (!active) return
        const next = draftFromPlayer(workspace.player)
        setDraft(next)
        setSavedDraft(json(next))
        setPlayer(workspace.player)
        setSettings(workspace.settings)
        setSource(workspace.playerSource)
        if (!taskRef.current) setTask(current)
        if (!workspace.player) setTab('profile')
        if (workspace.importError) setError(workspace.importError)
        setLoaded(true)
      })
      .catch(e => {
        if (active) {
          setError(errorText(e))
          setLoaded(true)
        }
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api])
  useEffect(() => {
    if (!dirty || !loaded) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, loaded])
  useEffect(() => {
    if (!task) return
    const tick = () =>
      setElapsed(
        Math.max(
          0,
          Math.round((Date.parse(task.finishedAt ?? new Date().toISOString()) - Date.parse(task.startedAt)) / 1000),
        ),
      )
    tick()
    if (task.status !== 'running') return
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [task?.id, task?.status, task?.finishedAt])
  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const changeDraft = (key: string, value: string) => {
    setDraft(current => ({ ...current, [key]: value }))
    setConfirmed(false)
    setMessage('')
  }
  const numberField = (key: string, title: string, hint?: string) => (
    <label key={key}>
      <span>{title}</span>
      <input
        aria-label={title}
        type="text"
        inputMode="decimal"
        value={draft[key] ?? ''}
        onChange={e => changeDraft(key, e.target.value)}
        placeholder="请输入"
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  )
  const settingNumber = (
    key: 'budgetSeconds' | 'seed' | 'distanceStep' | 'bossSeconds' | 'farmSeconds' | 'farmCycles',
    title: string,
    min: number,
  ) => (
    <label>
      <span>{title}</span>
      <input
        type="number"
        min={min}
        step={key.endsWith('Seconds') ? 'any' : 1}
        value={Number.isNaN(settings[key]) ? '' : settings[key]}
        onChange={e => setSettings(s => ({ ...s, [key]: e.target.value === '' ? NaN : Number(e.target.value) }))}
      />
    </label>
  )
  const savePlayer = () =>
    act(async () => {
      if (!confirmed) throw new Error('请先确认统计采集条件和三槽可同时达到的等级。')
      const saved = await api!.savePlayer(playerFromDraft(draft))
      const next = draftFromPlayer(saved)
      setPlayer(saved)
      setDraft(next)
      setSavedDraft(json(next))
      setSource('manager')
      setMessage('玩家档案已保存。切换搜索目标不会改变档案。')
    })
  if (!api)
    return (
      <section className="panel titan-empty">
        <h2>泰坦桥接尚未加载</h2>
        <p>请重新启动桌面应用以加载新增模块。</p>
      </section>
    )
  if (!loaded)
    return (
      <section className="panel titan-empty" role="status">
        正在读取泰坦工作区…
      </section>
    )
  const viewedInspection = inspectionKey === inspectionTarget ? inspection : null
  return (
    <section className="titan-workspace" aria-label="泰坦搜索工作区">
      <div className="titan-toolbar">
        <div className="titan-tabs" role="tablist" aria-label="泰坦功能">
          <button role="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>
            搜索与结果
          </button>
          <button role="tab" aria-selected={tab === 'profile'} onClick={() => setTab('profile')}>
            玩家档案{dirty && player ? ' · 未保存' : ''}
          </button>
        </div>
        <span className={`titan-profile-state ${player ? 'ready' : ''}`}>
          {player
            ? `${player.statistics.game_version ?? '旧版'} 档案${dirty ? ' · 有草稿' : ' · 已就绪'}`
            : '尚未录入玩家档案'}
        </span>
      </div>
      {runtime === 'web' ? (
        <p className="titan-note">Web 工作区可录入和保存档案。运行原生泰坦搜索、读取本机区域资料需要桌面应用。</p>
      ) : null}
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <pre className="titan-error" role="alert">
          {error}
        </pre>
      ) : null}
      <fieldset hidden={tab !== 'profile'} disabled={busy} className="titan-profile titan-fieldset">
        <section className="panel">
          <div className="titan-section-heading">
            <div>
              <h2>玩家档案</h2>
              <p>仅录入基础 Titan 船体的当前统计，支持科学计数法。</p>
            </div>
            <span className="titan-tag">
              {source === 'manager'
                ? 'Manager 档案'
                : source === 'local'
                  ? '来自 local/player.json · 待独立保存'
                  : '首次录入'}
            </span>
          </div>
          <div className="titan-form-grid">
            <label>
              <span>统计对应游戏版本</span>
              <SmartSelect
                label="统计对应游戏版本"
                value={draft.version}
                options={[
                  { value: '0.90.0.1', label: '0.90.0.1' },
                  { value: '0.85.1.0', label: '0.85.1.0' },
                  { value: 'legacy', label: '旧版 · 未标版本' },
                ]}
                onChange={v => changeDraft('version', v)}
              />
            </label>
            <label>
              <span>读数时实际层域</span>
              <SmartSelect
                label="读数时实际层域"
                value={draft.referenceLayer}
                options={TITAN_LAYERS.map(value => ({ value, label: layers[value] }))}
                onChange={v => changeDraft('referenceLayer', v)}
              />
            </label>
            {numberField('damage', '统计总览 · 泰坦伤害')}
            {numberField('shields', '统计总览 · 泰坦最大护盾')}
            {numberField('capacity', '统计总览 · 阵列容量', '保留游戏显示的小数。')}
            {numberField('referenceLevel', '读数时阵列核心等级')}
            {numberField('arrayDamage', '阵列核心 · Base Damage', '读取核心面板，不是序列顶部的合计伤害。')}
            {numberField('antumbraAlignment', '伪本影校准值')}
            {numberField('penumbraAlignment', '半影校准值')}
          </div>
          <p className="titan-note">游戏更新后需重新采集统计，不能只修改版本标签。0.90 的校准由原版作用于敌人强度。</p>
        </section>
        <section className="panel">
          <h2>核心可达等级</h2>
          <p>重复武器使用同一等级。未解锁的普通武器留空；护盾和阵列必填。搜索不分配升级资源。</p>
          <div className="titan-form-grid">
            {TITAN_CORES.map(key =>
              numberField(
                key,
                `${cores[key]}可达等级`,
                key === 'TitanShield' || key === 'TitanArray' ? '必填，可为 0。' : '未解锁留空。',
              ),
            )}
          </div>
        </section>
        <section className="panel">
          <h2>本轮进度</h2>
          <div className="titan-form-grid">
            {TITAN_LAYERS.map(key => numberField(`highest_${key}`, `${layers[key]}最高已到达区域`, '未解锁填 0。'))}
            {numberField('boundary', '本影合并边界', '区域严格小于边界才属于本影。未解锁填 0。')}
            <label className="titan-check">
              <input
                type="checkbox"
                checked={draft.reintegration === 'true'}
                onChange={e => changeDraft('reintegration', String(e.target.checked))}
              />
              已解锁再整合
            </label>
            <label className="titan-check">
              <input
                type="checkbox"
                checked={draft.galaxy12 === 'true'}
                onChange={e => changeDraft('galaxy12', String(e.target.checked))}
              />
              已解锁 Galaxy 12
            </label>
          </div>
        </section>
        <section className="panel titan-save-profile">
          <label className="titan-check">
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            确认统计在临时战斗技能结束后采集，所填等级支持三槽同时装备。
          </label>
          <div className="actions">
            <button className="primary" onClick={() => void savePlayer()} disabled={busy || !confirmed}>
              保存玩家档案
            </button>
            <button onClick={() => setTab('search')}>前往搜索</button>
          </div>
        </section>
        <details className="panel">
          <summary>高级 · 导入玩家 JSON</summary>
          <p>可粘贴已有玩家档案。载入编辑器后仍需核对并保存。</p>
          <textarea
            aria-label="泰坦玩家 JSON"
            value={raw}
            onChange={e => setRaw(e.target.value)}
            placeholder="粘贴 statistics 与 progress 对象"
          />
          <button
            disabled={busy || !raw.trim()}
            onClick={() =>
              void act(async () => {
                const imported = titanPlayerSchema.parse(JSON.parse(raw))
                setDraft(draftFromPlayer(imported))
                setConfirmed(false)
                setMessage('JSON 已载入草稿，请核对采集条件后保存。')
              })
            }
          >
            载入编辑器
          </button>
        </details>
      </fieldset>
      <div hidden={tab !== 'search'} className="titan-search">
        <section className="panel titan-search-config">
          <div className="titan-section-heading">
            <div>
              <h2>搜索目标</h2>
              <p>联合搜索武器、里程碑、目标设置与阵列顺序。</p>
            </div>
            <span className="titan-tag">160+ 区域</span>
          </div>
          {!player ? (
            <div className="titan-missing">
              <p>开始前需要录入你的当前玩家档案。</p>
              <button onClick={() => setTab('profile')}>录入玩家档案</button>
            </div>
          ) : dirty ? (
            <p className="titan-note">玩家档案有未保存草稿，请先核对并保存后再开始搜索。</p>
          ) : null}
          <fieldset disabled={running || busy} className="titan-fieldset">
            <div className="titan-target-grid">
              <label>
                <span>区域</span>
                <input
                  type="text"
                  value={settings.sector}
                  onChange={e => setSettings(s => ({ ...s, sector: e.target.value }))}
                  placeholder="例如 164 或 160A"
                />
              </label>
              <label>
                <span>搜索层域</span>
                <SmartSelect
                  label="搜索层域"
                  value={settings.layer}
                  options={TITAN_LAYERS.map(value => ({ value, label: layers[value] }))}
                  onChange={layer => setSettings(s => ({ ...s, layer: layer as TitanSettings['layer'] }))}
                />
              </label>
            </div>
            <div className="titan-modes" role="group" aria-label="搜索模式">
              {(['boss_once', 'farm_distance'] as const).map(mode => (
                <button
                  key={mode}
                  aria-pressed={settings.mode === mode}
                  onClick={() => setSettings(s => ({ ...s, mode }))}
                >
                  <strong>{modeName(mode)}</strong>
                  <small>{mode === 'boss_once' ? '原生战斗中实际击杀一次' : '更远距离，独立长战斗复核'}</small>
                </button>
              ))}
            </div>
            <div className="titan-target-grid">
              {settingNumber('budgetSeconds', '总预算（秒）', 1)}
              <label>
                <span>模拟时钟</span>
                <SmartSelect
                  label="泰坦模拟时钟"
                  value={settings.clock}
                  options={[
                    { value: 'fixed', label: '固定 60 FPS' },
                    { value: 'realtime', label: '实时对照' },
                  ]}
                  onChange={clock => setSettings(s => ({ ...s, clock: clock as TitanSettings['clock'] }))}
                />
              </label>
            </div>
            <p className="titan-note">预算包含工程准备、加载和复核；原生初始化通常需要 60–100 秒。</p>
            <details className="titan-advanced" open={!settings.godotPath && runtime !== 'web'}>
              <summary>运行环境与高级参数</summary>
              <div className="titan-form-grid">
                <label className="titan-wide">
                  <span>Godot 可执行文件</span>
                  <input
                    value={settings.godotPath}
                    onChange={e => setSettings(s => ({ ...s, godotPath: e.target.value }))}
                    placeholder="Godot 4.7.2 console.exe 的完整路径"
                  />
                </label>
                <label className="titan-wide">
                  <span>恢复工程路径（可选）</span>
                  <input
                    value={settings.sourcePath}
                    onChange={e => setSettings(s => ({ ...s, sourcePath: e.target.value }))}
                    placeholder="留空使用 local/current_source.json"
                  />
                </label>
                {settingNumber('seed', '随机种子', 0)}
                {settings.mode === 'boss_once' ? (
                  settingNumber('bossSeconds', '每候选首领模拟秒数', 1)
                ) : (
                  <>
                    {settingNumber('distanceStep', '距离网格步长', 1)}
                    {settingNumber('farmSeconds', '每次挂机复核至少秒数', 120)}
                    {settingNumber('farmCycles', '每次复核至少巨型击杀数', 10)}
                  </>
                )}
              </div>
            </details>
            <div className="actions titan-run-actions">
              <button
                className="primary"
                disabled={!player || dirty || runtime === 'web' || !settings.godotPath.trim()}
                onClick={() =>
                  void act(async () => {
                    const valid = titanSettingsSchema.parse(settings)
                    const saved = await api.saveSettings(valid)
                    const next = await api.start({ player: player!, settings: saved })
                    taskRef.current = next
                    setTask(next)
                  })
                }
              >
                开始泰坦搜索
              </button>
              <button
                onClick={() =>
                  void act(async () => {
                    const next = await api.saveSettings(titanSettingsSchema.parse(settings))
                    setSettings(next)
                    setMessage('泰坦搜索设置已保存。')
                  })
                }
              >
                保存搜索设置
              </button>
              <button
                disabled={runtime === 'web'}
                onClick={() =>
                  void act(async () => {
                    const target = inspectionTarget
                    const next = await api.inspect({
                      sector: settings.sector,
                      layer: settings.layer,
                      source: settings.sourcePath || undefined,
                    })
                    if (inspectionRef.current === target) {
                      setInspection(next)
                      setInspectionKey(target)
                    }
                  })
                }
              >
                读取区域资料
              </button>
            </div>
          </fieldset>
          {viewedInspection ? (
            <details className="titan-advanced" open>
              <summary>区域资料 · {viewedInspection.region.sector_id}</summary>
              <p>
                距离 {viewedInspection.region.distance_start}–{viewedInspection.region.distance_end} ·{' '}
                {Object.keys(viewedInspection.cores).length} 种核心 ·{' '}
                {Object.keys(viewedInspection.array_elements).length} 种阵列元素
              </p>
              <p>结构资料尚未验证玩家准入或战斗结果。</p>
              <details>
                <summary>查看原版区域数据</summary>
                <pre>{json(viewedInspection)}</pre>
              </details>
            </details>
          ) : null}
        </section>
        <section className="titan-result-column">
          {task ? (
            <>
              <section className="panel titan-run-state" aria-live="polite">
                <div>
                  <span className={`titan-tag ${task.status}`}>{statusNames[task.status]}</span>
                  <strong>
                    {task.request.settings.sector} · {layers[task.request.settings.layer]} ·{' '}
                    {modeName(task.request.settings.mode)}
                  </strong>
                  <small>
                    任务 {task.id} · {elapsed} 秒 / {task.request.settings.budgetSeconds} 秒预算
                  </small>
                </div>
                {running ? (
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api.stop()
                      })
                    }
                  >
                    停止泰坦搜索
                  </button>
                ) : null}
              </section>
              <TitanResult
                task={task}
                inspection={
                  viewedInspection &&
                  task.request.settings.sector === settings.sector &&
                  task.request.settings.layer === settings.layer &&
                  task.request.settings.sourcePath === settings.sourcePath
                    ? viewedInspection
                    : null
                }
              />
              <details className="panel titan-log" open={task.status === 'failed'}>
                <summary>运行日志{task.logs ? ` · ${task.logs.split('\n').length} 行` : ''}</summary>
                <pre>{task.logs || '等待搜索器输出；准备阶段已计入预算。'}</pre>
                {task.resultDirectory ? <p className="titan-path">结果目录：{task.resultDirectory}</p> : null}
              </details>
            </>
          ) : (
            <section className="panel titan-empty">
              <svg viewBox="0 0 80 80" aria-hidden="true">
                <path d="M40 8 63 23v27L40 72 17 50V23Z M40 8v64 M17 23l23 14 23-14 M17 50l23-13 23 13" />
              </svg>
              <h2>等待开始搜索</h2>
              <p>选择目标后运行原版战斗。完成后在这里查看已验证配置、阵列顺序和复核证据。</p>
              <div className="titan-proof-policy">
                <strong>{settings.mode === 'boss_once' ? '首领推荐条件' : '挂机推荐条件'}</strong>
                <p>
                  {settings.mode === 'boss_once'
                    ? '原生战斗实际击杀所选首领一次。'
                    : `3 个独立种子，每次至少 ${settings.farmSeconds} 秒与 ${settings.farmCycles} 次巨型敌人击杀；零死亡、距离保持，并检查护盾趋势。`}
                </p>
              </div>
            </section>
          )}
          <p className="titan-disclaimer">
            预算内研究结果，不保证全局最优。尚未与本玩家正式游戏实战完整对照；有限挂机复核不能证明无限期稳定。
          </p>
        </section>
      </div>
    </section>
  )
}

type Weapon = { id: string; level: number; milestones: Record<string, string>; targeting: Record<string, string> }
type Candidate = {
  weapons: Weapon[]
  shield: { level: number }
  array_core: { level: number }
  array_capacity: number
  sequence: Array<{ id: string; targets: string[] }>
}
const targetingNames: Record<string, string> = {
  None: '无',
  Regen: '再生',
  Shielded: '护盾',
  Armored: '装甲',
  Unarmored: '无甲',
  Phasing: '相位',
  "Can't Phase": '无法相位',
  Carrier: '航母',
  Barrier: '屏障',
  'No Barrier': '无屏障',
  Torpedo: '鱼雷',
  'Highest Max HP': '最高血量上限',
  'Lowest Max HP': '最低血量上限',
  'Highest HP': '最高血量',
  'Lowest HP': '最低血量',
  'Highest Damage': '最高伤害',
  Closest: '最近',
  Furthest: '最远',
  'Keep Target': '锁定',
  'Change Target': '转换',
  Allow: '集火',
  Avoid: '分散',
}
const percent = (value: unknown) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—')
export function TitanResult({
  task,
  inspection: requestedInspection,
}: {
  task: TitanTask
  inspection?: TitanInspection | null
}) {
  const inspection = task.inspection ?? requestedInspection
  const [copyState, setCopyState] = useState('')
  const best = task.result?.best
  const verified =
    task.status === 'success' && best && ['KILL_FOUND', 'BEST_VALIDATED_DISTANCE_FOUND'].includes(task.result!.status)
  if (!verified)
    return (
      <section className="panel titan-empty">
        <h2>
          {task.status === 'running'
            ? '原生搜索进行中'
            : task.status === 'failed'
              ? '搜索未能完成'
              : task.status === 'canceled'
                ? '搜索已停止'
                : '当前预算内没有已验证推荐'}
        </h2>
        <p>
          {task.error ??
            (task.status === 'running'
              ? '正在准备工程、试验候选或执行最终复核。'
              : '这不代表该区域不可击杀或无法挂机。可检查档案、增加预算后重试。')}
        </p>
        {task.result ? (
          <small>
            搜索器状态：{task.result.status} · 已完成 {task.result.trials ?? 0} 次试验
          </small>
        ) : null}
      </section>
    )
  const candidate = best.candidate as unknown as Candidate
  const farm = task.request.settings.mode === 'farm_distance'
  const namedCore = (id: string) => cores[id as keyof typeof cores] ?? id
  const partName = (id: string) => {
    const part = task.result?.region.array_targets.find(p => p.id === id)
    return part
      ? `${({ DEFENSIVE_PLATING: '防护', TURRET_POWER: '炮塔', DISRUPTION_FIELD: '干扰场' } as Record<string, string>)[part.system] ?? part.system} ${part.number}`
      : id
  }
  const copy = async () => {
    try {
      if (task.resultText) {
        await navigator.clipboard.writeText(task.resultText)
        setCopyState('配置文本已复制')
      }
    } catch {
      setCopyState('复制失败，请展开原始推荐手动复制。')
    }
  }
  return (
    <section className="panel titan-recommendation">
      <div className="titan-section-heading">
        <div>
          <h2>{farm ? '已验证挂机配置' : '首领击杀配置'}</h2>
          <p>基于本次任务冻结的玩家档案与搜索目标。</p>
        </div>
        {task.resultText ? <button onClick={() => void copy()}>复制配置文本</button> : null}
      </div>
      {copyState ? <p role="status">{copyState}</p> : null}
      <div className="titan-metrics">
        <div>
          <small>{farm ? '已验证距离' : '首领距离'}</small>
          <strong>{best.distance}</strong>
        </div>
        <div>
          <small>{farm ? '独立复核' : '实际击杀时间'}</small>
          <strong>
            {farm ? `${best.validation?.length ?? 0} 次` : `${Number(best.battle?.seconds ?? 0).toFixed(2)} 秒`}
          </strong>
        </div>
        <div>
          <small>原生试验</small>
          <strong>{task.result?.trials ?? 0}</strong>
        </div>
      </div>
      <h3>三槽武器与目标</h3>
      <div className="titan-weapons">
        {candidate.weapons?.map((weapon, index) => (
          <article key={index}>
            <h4>
              槽 {index + 1} · {namedCore(weapon.id)} <span>Lv{weapon.level}</span>
            </h4>
            <dl>
              {(['type', 'priority', 'swapping', 'overlap'] as const).map((key, i) => (
                <div key={key}>
                  <dt>{['类型', '优先', '切换', '重叠'][i]}</dt>
                  <dd>{targetingNames[weapon.targeting[key]] ?? weapon.targeting[key]}</dd>
                </div>
              ))}
            </dl>
            <details>
              <summary>里程碑分支</summary>
              <ul>
                {Object.entries(weapon.milestones).map(([level, id]) => (
                  <li key={level}>
                    {level} 级：{inspection?.milestones[weapon.id]?.[level]?.find(row => row.id === id)?.name ?? id}
                  </li>
                ))}
              </ul>
            </details>
          </article>
        ))}
      </div>
      <p className="titan-core-summary">
        护盾 Lv{candidate.shield?.level} · 阵列核心 Lv{candidate.array_core?.level} · 阵列容量{' '}
        {candidate.array_capacity} · 固定里程碑由原版应用
      </p>
      <h3>阵列执行顺序</h3>
      <ol className="titan-sequence">
        {candidate.sequence?.map((element, index) => (
          <li key={index}>
            <span>{inspection?.array_elements[element.id]?.name ?? element.id}</span>
            <small>{element.targets.map(partName).join(' → ') || '默认目标 / 非攻击技能'}</small>
          </li>
        ))}
      </ol>
      {farm ? (
        <>
          <h3>独立长战斗复核</h3>
          <div className="titan-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>种子</th>
                  <th>模拟秒数</th>
                  <th>巨型击杀</th>
                  <th>死亡</th>
                  <th>最低护盾</th>
                </tr>
              </thead>
              <tbody>
                {best.validation?.map(check => (
                  <tr key={check.seed}>
                    <td>{check.seed}</td>
                    <td>{Number(check.battle.seconds).toFixed(1)}</td>
                    <td>{String(check.battle.colossal_kills)}</td>
                    <td>{String(check.battle.deaths)}</td>
                    <td>{percent(check.battle.minimum_shield_fraction)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <details className="titan-advanced">
        <summary>搜索器原始推荐与完整证据</summary>
        <pre>{task.resultText}</pre>
        <details>
          <summary>结果 JSON</summary>
          <pre>{json(task.result)}</pre>
        </details>
      </details>
    </section>
  )
}
