import { useEffect, useMemo, useState } from 'react'
import type { Catalog, FleetManagerApi, ImportPreview, RunResult, Selection } from '../shared/contracts'
import type { CommonConfig, NodeConfig } from '../shared/schemas'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'
import { diffFormation } from '../shared/formation-diff'

const emptySelection: Selection = { galaxy: '', node: '', version: '', common: '' }
const emptyCatalog: Catalog = { galaxies: [], templates: [] }
const format = (value: unknown) => JSON.stringify(value, null, 2)
const keyOf = (selection: Selection) => `${selection.galaxy}/${selection.node}/${selection.version}/${selection.common}`

export function App() {
  const api = window[FLEET_MANAGER_BRIDGE_NAME]
  if (!api)
    return (
      <main className="empty">
        <h1>Fleet Manager 启动失败</h1>
        <p>Preload API 未加载。请检查 Electron preload 配置。</p>
      </main>
    )
  return <FleetManagerApp api={api} />
}

function FleetManagerApp({ api }: { api: FleetManagerApi }) {
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog)
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [node, setNode] = useState<NodeConfig | null>(null)
  const [common, setCommon] = useState<CommonConfig | null>(null)
  const [nodeSource, setNodeSource] = useState('')
  const [commonSource, setCommonSource] = useState('')
  const [savedNodeSource, setSavedNodeSource] = useState('')
  const [savedCommonSource, setSavedCommonSource] = useState('')
  const [logs, setLogs] = useState('')
  const [run, setRun] = useState<RunResult | null>(null)
  const [runKey, setRunKey] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [template, setTemplate] = useState('')
  const [createMode, setCreateMode] = useState<'selection' | 'template'>('selection')
  const [newNode, setNewNode] = useState('')
  const [newNodeGalaxy, setNewNodeGalaxy] = useState('')
  const [newVersionName, setNewVersionName] = useState('默认')

  const currentGalaxy = catalog.galaxies.find(g => g.id === selection.galaxy)
  const currentNode = currentGalaxy?.nodes.find(n => n.id === selection.node)
  const currentVersion = currentNode?.versions.find(v => v.id === selection.version)
  const currentCommon = currentGalaxy?.commons.find(c => c.id === selection.common)
  const nodeDirty = Boolean(node && nodeSource !== savedNodeSource)
  const commonDirty = Boolean(common && commonSource !== savedCommonSource)
  const dirty = nodeDirty || commonDirty

  const chooseInitial = (next: Catalog): Selection => {
    const galaxy = next.galaxies[0],
      first = galaxy?.nodes[0]
    return {
      galaxy: galaxy?.id ?? '',
      node: first?.id ?? '',
      version: first?.defaultVersion ?? '',
      common: galaxy?.defaultCommon ?? '',
    }
  }
  const refresh = async () => {
    const next = await api.catalog()
    setCatalog(next)
    return next
  }
  useEffect(() => {
    void refresh()
      .then(next => setSelection(current => (current.galaxy ? current : chooseInitial(next))))
      .catch(error => setMessage(`无法读取 Manager 数据：${(error as Error).message}`))
    return api.onOutput(line => setLogs(previous => `${previous}${line}`))
  }, [api])
  useEffect(() => {
    if (!selection.galaxy || !selection.node || !selection.version || !selection.common) {
      setNode(null)
      setCommon(null)
      return
    }
    let active = true
    void api
      .load(selection)
      .then(data => {
        if (!active) return
        const nextNode = format(data.node),
          nextCommon = format(data.common)
        setNode(data.node)
        setCommon(data.common)
        setNodeSource(nextNode)
        setCommonSource(nextCommon)
        setSavedNodeSource(nextNode)
        setSavedCommonSource(nextCommon)
        setRun(null)
        setRunKey('')
        setMessage('')
      })
      .catch(error => active && setMessage(error.message))
    return () => {
      active = false
    }
  }, [api, selection.galaxy, selection.node, selection.version, selection.common])

  const changes = useMemo(
    () => (run?.result ? diffFormation(run.result.verified_baseline, run.result.best_result) : []),
    [run],
  )
  const canSwitch = () => !dirty || window.confirm('当前有未保存修改。切换后将丢失这些修改，是否继续？')
  const update = <K extends keyof Selection>(field: K, value: Selection[K]) => {
    if (!canSwitch()) return
    if (field === 'galaxy') {
      const galaxy = catalog.galaxies.find(g => g.id === value),
        first = galaxy?.nodes[0]
      setSelection({
        galaxy: value,
        node: first?.id ?? '',
        version: first?.defaultVersion ?? '',
        common: galaxy?.defaultCommon ?? '',
      })
      setNewNodeGalaxy(value)
    } else if (field === 'node') {
      const found = currentGalaxy?.nodes.find(n => n.id === value)
      setSelection(s => ({ ...s, node: value, version: found?.defaultVersion ?? '' }))
    } else setSelection(s => ({ ...s, [field]: value }))
  }
  const act = async (label: string, action: () => Promise<void>) => {
    try {
      setBusy(true)
      await action()
      setMessage(label)
    } catch (error) {
      setMessage(`操作失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const ask = (label: string, initial: string) => window.prompt(label, initial)?.trim() ?? ''
  const requireSaved = () => {
    if (!dirty) return true
    setMessage('当前配置存在未保存修改。请先保存后再执行管理操作。')
    return false
  }
  const saveNode = () =>
    act('Node Version 已原子保存。', async () => {
      const parsed = JSON.parse(nodeSource)
      await api.save(selection, parsed)
      setNode(parsed)
      setSavedNodeSource(format(parsed))
    })
  const saveCommon = () =>
    act('Common 配置已原子保存。', async () => {
      const parsed = JSON.parse(commonSource)
      await api.saveCommon(selection, parsed)
      setCommon(parsed)
      setSavedCommonSource(format(parsed))
    })
  const createVersion = (copyCurrent: boolean) => {
    if (!requireSaved()) return
    const name = ask(
      copyCurrent ? '复制版本名称' : '新版本名称',
      copyCurrent ? `${currentVersion?.name ?? ''} 副本` : '新版本',
    )
    if (!name) return
    void act('Version 已创建并切换。', async () => {
      const source = copyCurrent ? selection : { ...selection, version: currentNode!.defaultVersion }
      const id = await api.createVersion(source, name)
      await refresh()
      setSelection(s => ({ ...s, version: id }))
    })
  }
  const renameVersion = () => {
    const name = ask('Version 新名称', currentVersion?.name ?? '')
    if (name)
      void act('Version 已重命名。', async () => {
        await api.renameVersion(selection, name)
        await refresh()
      })
  }
  const deleteVersion = () => {
    if (!window.confirm(`确定删除 Version“${currentVersion?.name}”？此操作不可撤销。`)) return
    void act('Version 已删除。', async () => {
      await api.deleteVersion(selection)
      const next = await refresh()
      const found = next.galaxies.find(g => g.id === selection.galaxy)?.nodes.find(n => n.id === selection.node)
      setSelection(s => ({ ...s, version: found?.defaultVersion ?? found?.versions[0]?.id ?? '' }))
    })
  }
  const createCommon = (copyCurrent: boolean) => {
    if (!requireSaved()) return
    const name = ask(
      copyCurrent ? '复制 Common 名称' : '新 Common 名称',
      copyCurrent ? `${currentCommon?.name ?? ''} 副本` : '新 Common',
    )
    if (!name) return
    void act('Common 已创建并切换。', async () => {
      const source = copyCurrent ? selection : { ...selection, common: currentGalaxy!.defaultCommon }
      const id = await api.createCommon(source, name)
      await refresh()
      setSelection(s => ({ ...s, common: id }))
    })
  }
  const renameCommon = () => {
    const name = ask('Common 新名称', currentCommon?.name ?? '')
    if (name)
      void act('Common 已重命名。', async () => {
        await api.renameCommon(selection, name)
        await refresh()
      })
  }
  const deleteCommon = () => {
    if (!window.confirm(`确定删除 Common“${currentCommon?.name}”？此操作不可撤销。`)) return
    void act('Common 已删除。', async () => {
      await api.deleteCommon(selection)
      const next = await refresh()
      const galaxy = next.galaxies.find(g => g.id === selection.galaxy)
      setSelection(s => ({ ...s, common: galaxy?.defaultCommon ?? galaxy?.commons[0]?.id ?? '' }))
    })
  }
  const start = () =>
    act('搜索完成。', async () => {
      if (dirty) throw new Error('当前配置存在未保存修改。请先保存后再启动。')
      setLogs('')
      setRun(null)
      setRunKey('')
      setMessage('Optimizer 正在运行…')
      const result = await api.run(selection)
      setRun(result)
      if (result.error) throw new Error(result.error)
      setRunKey(keyOf(selection))
    })
  const useBest = () => {
    if (
      !window.confirm(
        `使用 Best Found 覆盖 ${selection.node} / ${currentVersion?.name} 的 baseline？不会创建 Version。`,
      )
    )
      return
    void act('Best Found 已写入当前 Version；其他 Version 未修改。', async () => {
      if (dirty) throw new Error('当前配置存在未保存修改。')
      if (!run?.result || runKey !== keyOf(selection)) throw new Error('当前选择没有可采用的本次搜索结果。')
      const result = await api.useBest(selection)
      if (result.error || !result.node) throw new Error(result.error ?? 'Copy 未返回有效 Node。')
      const source = format(result.node)
      setNode(result.node)
      setNodeSource(source)
      setSavedNodeSource(source)
      setRun(null)
      setRunKey('')
    })
  }
  const importMap = async () => {
    try {
      if (!preview) {
        setPreview(await api.previewImport())
        return
      }
      setBusy(true)
      await api.importMap()
      setPreview(null)
      const next = await refresh()
      setSelection(chooseInitial(next))
      setMessage('已导入 map 配置到 Manager；没有覆盖既有 Manager 数据。')
    } catch (error) {
      setMessage(`导入失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const saveTemplate = () => {
    if (!requireSaved()) return
    const name = ask('模板名称', `${selection.galaxy} ${selection.node}`)
    if (name)
      void act('模板已从当前 Version 创建。', async () => {
        await api.createTemplate(selection, name)
        await refresh()
      })
  }
  const renameTemplate = () => {
    const item = catalog.templates.find(t => t.id === template)
    const name = ask('模板新名称', item?.name ?? '')
    if (name)
      void act('模板已重命名。', async () => {
        await api.renameTemplate(template, name)
        await refresh()
      })
  }
  const deleteTemplate = () => {
    const item = catalog.templates.find(t => t.id === template)
    if (!item || !window.confirm(`确定删除模板“${item.name}”？`)) return
    void act('模板已删除。', async () => {
      await api.deleteTemplate(template)
      const next = await refresh()
      setTemplate(next.templates[0]?.id ?? '')
    })
  }
  const createNode = () => {
    if (!requireSaved()) return
    void act('Node 已创建并切换。', async () => {
      if (!newNode.trim()) throw new Error('请输入目标 Node。')
      const galaxy = newNodeGalaxy || selection.galaxy
      const source =
        createMode === 'selection' ? { type: 'selection' as const, selection } : { type: 'template' as const, template }
      const created = await api.createNode({
        galaxy,
        node: newNode.trim(),
        versionName: newVersionName.trim() || '默认',
        source,
      })
      const next = await refresh()
      const targetGalaxy = next.galaxies.find(g => g.id === galaxy)!
      setSelection({ galaxy, node: created.node, version: created.version, common: targetGalaxy.defaultCommon })
      setNewNode('')
    })
  }

  if (!catalog.galaxies.length)
    return (
      <main className="empty">
        <h1>舰队优化器管理器</h1>
        <p>Manager 正式数据尚未初始化。导入只会复制现有 map 配置，绝不自动覆盖已有 Manager 数据。</p>
        {preview ? <pre>{format(preview)}</pre> : null}
        <button onClick={() => void importMap()} disabled={busy}>
          {preview ? '确认导入 map' : '扫描现有 map'}
        </button>
        {message ? <p className="notice">{message}</p> : null}
      </main>
    )
  const tableChange = (next: NodeConfig) => {
    setNode(next)
    setNodeSource(format(next))
  }
  return (
    <main className="app">
      <header>
        <div>
          <h1>舰队优化器管理器</h1>
          <span>Manager 正式数据源 · Optimizer map 仅为工作区</span>
        </div>
        <div className="actions">
          <button onClick={() => void saveNode()} disabled={busy || !nodeDirty}>
            保存 Node
          </button>
          <button onClick={() => void saveCommon()} disabled={busy || !commonDirty}>
            保存 Common
          </button>
          <button className="primary" onClick={() => void start()} disabled={busy}>
            {busy ? '处理中…' : '启动 Optimizer'}
          </button>
          <button className="success" onClick={useBest} disabled={busy || !run?.result || runKey !== keyOf(selection)}>
            使用最优配置
          </button>
        </div>
      </header>
      <section className="statusbar">
        <strong>
          {selection.galaxy.toUpperCase()} / {selection.node}
        </strong>
        <span>
          Version: {currentVersion?.name}
          {currentVersion?.isDefault ? ' ★默认' : ''}
        </span>
        <span>
          Common: {currentCommon?.name}
          {currentCommon?.isDefault ? ' ★默认' : ''}
        </span>
        {dirty ? <span className="dirty">● 未保存</span> : <span className="saved">● 已保存</span>}
      </section>
      <section className="selectors">
        <Label text="Galaxy">
          <select value={selection.galaxy} onChange={e => update('galaxy', e.target.value)}>
            {catalog.galaxies.map(g => (
              <option key={g.id} value={g.id}>
                {g.id.toUpperCase()}
              </option>
            ))}
          </select>
        </Label>
        <Label text="Node">
          <select value={selection.node} onChange={e => update('node', e.target.value)}>
            {currentGalaxy?.nodes.map(n => (
              <option key={n.id} value={n.id}>
                {n.id}
              </option>
            ))}
          </select>
        </Label>
        <Label text="Version">
          <select value={selection.version} onChange={e => update('version', e.target.value)}>
            {currentNode?.versions.map(v => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.isDefault ? ' ★' : ''}
              </option>
            ))}
          </select>
          <CrudButtons
            onNew={() => createVersion(false)}
            onCopy={() => createVersion(true)}
            onRename={renameVersion}
            onDelete={deleteVersion}
            onDefault={() =>
              void act('已设为默认 Version。', async () => {
                await api.setDefaultVersion(selection)
                await refresh()
              })
            }
            disableDefault={currentVersion?.isDefault}
            disableDelete={currentVersion?.isDefault || (currentNode?.versions.length ?? 0) <= 1}
            disabled={busy}
          />
        </Label>
        <Label text="Common">
          <select value={selection.common} onChange={e => update('common', e.target.value)}>
            {currentGalaxy?.commons.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isDefault ? ' ★' : ''}
              </option>
            ))}
          </select>
          <CrudButtons
            onNew={() => createCommon(false)}
            onCopy={() => createCommon(true)}
            onRename={renameCommon}
            onDelete={deleteCommon}
            onDefault={() =>
              void act('已设为默认 Common。', async () => {
                await api.setDefaultCommon(selection)
                await refresh()
              })
            }
            disableDefault={currentCommon?.isDefault}
            disableDelete={currentCommon?.isDefault || (currentGalaxy?.commons.length ?? 0) <= 1}
            disabled={busy}
          />
        </Label>
      </section>
      {message ? <p className="notice">{message}</p> : null}
      <section className="management panel">
        <div>
          <h2>Node 创建与模板</h2>
          <div className="inline">
            <select value={createMode} onChange={e => setCreateMode(e.target.value as 'selection' | 'template')}>
              <option value="selection">复制当前 Node / Version</option>
              <option value="template">从模板创建</option>
            </select>
            {createMode === 'template' ? (
              <select value={template} onChange={e => setTemplate(e.target.value)}>
                <option value="">选择模板</option>
                {catalog.templates.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            ) : null}
            <select value={newNodeGalaxy || selection.galaxy} onChange={e => setNewNodeGalaxy(e.target.value)}>
              {catalog.galaxies.map(g => (
                <option key={g.id} value={g.id}>
                  {g.id.toUpperCase()}
                </option>
              ))}
            </select>
            <input
              aria-label="新 Node ID"
              placeholder="新 Node，例如 B23"
              value={newNode}
              onChange={e => setNewNode(e.target.value)}
            />
            <input
              aria-label="初始 Version 名称"
              value={newVersionName}
              onChange={e => setNewVersionName(e.target.value)}
            />
            <button onClick={createNode} disabled={busy || (createMode === 'template' && !template)}>
              创建 Node
            </button>
          </div>
        </div>
        <div>
          <h2>模板管理</h2>
          <div className="inline">
            <button onClick={saveTemplate} disabled={busy}>
              当前 Version 存为模板
            </button>
            <select value={template} onChange={e => setTemplate(e.target.value)}>
              <option value="">选择模板</option>
              {catalog.templates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button onClick={renameTemplate} disabled={!template || busy}>
              重命名
            </button>
            <button className="danger" onClick={deleteTemplate} disabled={!template || busy}>
              删除
            </button>
          </div>
        </div>
      </section>
      <section className="workspace">
        <section className="editor panel">
          <h2>Node Version 编辑</h2>
          {node ? <ConfigTables config={node} onChange={tableChange} /> : null}
          <h3>Node 原始 JSON</h3>
          <textarea
            value={nodeSource}
            onChange={e => setNodeSource(e.target.value)}
            spellCheck={false}
            aria-label="Node JSON 编辑器"
          />
        </section>
        <section className="results">
          <section className="panel common-editor">
            <h2>Common 配置编辑</h2>
            <textarea
              value={commonSource}
              onChange={e => setCommonSource(e.target.value)}
              spellCheck={false}
              aria-label="Common JSON 编辑器"
            />
          </section>
          <section className="panel">
            <h2>Optimizer 输出</h2>
            <pre className="logs">{logs || '尚未启动任务。'}</pre>
          </section>
          <section className="panel">
            <h2>本次搜索最佳结果 / Best Found</h2>
            {run?.result?.best_result ? (
              <>
                <dl>
                  <dt>Outcome</dt>
                  <dd>{run.result.best_result.outcome ?? '—'}</dd>
                  <dt>Used FR</dt>
                  <dd>{run.result.best_result.fleet_resources_used ?? '—'}</dd>
                </dl>
                <h3>Formation / Loadout 差异</h3>
                {changes.length ? (
                  <table>
                    <tbody>
                      {changes.map((c, i) => (
                        <tr key={i}>
                          <td>{c.position}</td>
                          <td>{c.field}</td>
                          <td>{String(c.before)}</td>
                          <td>{String(c.after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>配置无变化。</p>
                )}
              </>
            ) : (
              <p>{run?.error ?? '完成搜索后将在这里显示本次的新结果。'}</p>
            )}
          </section>
        </section>
      </section>
    </main>
  )
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label>
      <span>{text}</span>
      {children}
    </label>
  )
}
function CrudButtons({
  onNew,
  onCopy,
  onRename,
  onDelete,
  onDefault,
  disableDefault,
  disableDelete,
  disabled,
}: {
  onNew: () => void
  onCopy: () => void
  onRename: () => void
  onDelete: () => void
  onDefault: () => void
  disableDefault?: boolean
  disableDelete?: boolean
  disabled?: boolean
}) {
  return (
    <span className="crud">
      <button onClick={onNew} disabled={disabled}>
        新建
      </button>
      <button onClick={onCopy} disabled={disabled}>
        复制
      </button>
      <button onClick={onRename} disabled={disabled}>
        重命名
      </button>
      <button onClick={onDefault} disabled={disabled || disableDefault}>
        设为默认
      </button>
      <button className="danger" onClick={onDelete} disabled={disabled || disableDelete}>
        删除
      </button>
    </span>
  )
}
function ConfigTables({ config, onChange }: { config: NodeConfig; onChange: (n: NodeConfig) => void }) {
  const slots = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5'],
    ships = Object.keys(config.player_state.ships)
  const update = (position: string, ship: string) =>
    onChange({
      ...config,
      baseline: { ...config.baseline, formation: { ...config.baseline.formation, [position]: ship } },
    })
  const load = (ship: string, field: 'primary' | 'secondary' | 'tertiary_mods', value: string) => {
    const old = config.baseline.loadouts[ship] ?? {}
    onChange({
      ...config,
      baseline: {
        ...config.baseline,
        loadouts: {
          ...config.baseline.loadouts,
          [ship]: {
            ...old,
            [field]:
              field === 'tertiary_mods'
                ? value
                    .split(',')
                    .map(x => x.trim())
                    .filter(Boolean)
                : value || null,
          },
        },
      },
    })
  }
  return (
    <>
      <h3>Baseline Formation</h3>
      <table>
        <tbody>
          <tr>
            {slots.slice(0, 5).map(p => (
              <td key={p}>
                {p}
                <select value={config.baseline.formation[p] ?? ''} onChange={e => update(p, e.target.value)}>
                  <option value="">—</option>
                  {ships.map(s => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </td>
            ))}
          </tr>
          <tr>
            {slots.slice(5).map(p => (
              <td key={p}>
                {p}
                <select value={config.baseline.formation[p] ?? ''} onChange={e => update(p, e.target.value)}>
                  <option value="">—</option>
                  {ships.map(s => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <h3>Baseline Loadouts</h3>
      <table>
        <thead>
          <tr>
            <th>Ship</th>
            <th>Primary</th>
            <th>Secondary</th>
            <th>Tertiary</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(config.baseline.loadouts).map(([ship, l]) => (
            <tr key={ship}>
              <td>{ship}</td>
              <td>
                <input value={l.primary ?? ''} onChange={e => load(ship, 'primary', e.target.value)} />
              </td>
              <td>
                <input value={l.secondary ?? ''} onChange={e => load(ship, 'secondary', e.target.value)} />
              </td>
              <td>
                <input
                  value={(l.tertiary_mods ?? []).join(', ')}
                  onChange={e => load(ship, 'tertiary_mods', e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
