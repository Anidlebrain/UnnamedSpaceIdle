import { useEffect, useMemo, useState } from 'react'
import type {
  Catalog,
  FleetManagerApi,
  GalaxyRerunNode,
  GalaxyRerunProgress,
  ImportPreview,
  RunResult,
  Selection,
} from '../shared/contracts'
import type { CommonConfig, NodeConfig } from '../shared/schemas'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'
import { diffFormation } from '../shared/formation-diff'
import {
  preserveShipSelectorFormat,
  SHIP_TYPES,
  shipDisplayName,
  shipSelectorToId,
  type ShipId,
} from '../shared/ship-selectors'
import { GalaxyRerunPanel } from './GalaxyRerunPanel'

const emptySelection: Selection = { galaxy: '', node: '', version: '', common: '' }
const emptyCatalog: Catalog = { galaxies: [], templates: [] }
const format = (value: unknown) => JSON.stringify(value, null, 2)
const keyOf = (selection: Selection) => `${selection.galaxy}/${selection.node}/${selection.version}/${selection.common}`
type Workspace = 'node' | 'rerun' | 'templates'
type EditorTab = 'formation' | 'loadout' | 'common'
type DialogState =
  | {
      kind: 'input'
      title: string
      initial: string
      confirmLabel: string
      onConfirm: (value: string) => void
    }
  | {
      kind: 'confirm'
      title: string
      body: string
      confirmLabel: string
      danger?: boolean
      onConfirm: () => void
    }

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
  const [galaxyRerun, setGalaxyRerun] = useState<GalaxyRerunProgress | null>(null)
  const [galaxyDetail, setGalaxyDetail] = useState<GalaxyRerunNode | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [template, setTemplate] = useState('')
  const [createMode, setCreateMode] = useState<'selection' | 'template'>('selection')
  const [newNode, setNewNode] = useState('')
  const [newNodeGalaxy, setNewNodeGalaxy] = useState('')
  const [newVersionName, setNewVersionName] = useState('默认')
  const [workspace, setWorkspace] = useState<Workspace>('node')
  const [editorTab, setEditorTab] = useState<EditorTab>('formation')
  const [dialog, setDialog] = useState<DialogState | null>(null)

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
    const stopOutput = api.onOutput(line => setLogs(previous => `${previous}${line}`))
    const stopProgress = api.onGalaxyProgress(setGalaxyRerun)
    return () => {
      stopOutput()
      stopProgress()
    }
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
      })
      .catch(error => active && setMessage(error.message))
    return () => {
      active = false
    }
  }, [api, selection.galaxy, selection.node, selection.version, selection.common])

  const detailKey = galaxyDetail
    ? `${galaxyRerun?.galaxy}/${galaxyDetail.node}/${galaxyDetail.version}/${galaxyDetail.common}`
    : ''
  const activeRun = runKey === keyOf(selection) ? run : detailKey === keyOf(selection) ? galaxyDetail?.run : null
  const changes = useMemo(
    () => (activeRun?.result ? diffFormation(activeRun.result.verified_baseline, activeRun.result.best_result) : []),
    [activeRun],
  )
  const requestText = (title: string, initial: string, confirmLabel: string, onConfirm: (value: string) => void) =>
    setDialog({ kind: 'input', title, initial, confirmLabel, onConfirm })
  const requestConfirm = (title: string, body: string, confirmLabel: string, onConfirm: () => void, danger = false) =>
    setDialog({ kind: 'confirm', title, body, confirmLabel, onConfirm, danger })
  const switchOrConfirm = (action: () => void) => {
    if (!dirty) action()
    else requestConfirm('放弃未保存修改？', '切换配置会丢失当前尚未保存的修改。', '放弃并切换', action, true)
  }
  const applyUpdate = <K extends keyof Selection>(field: K, value: Selection[K]) => {
    setMessage('')
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
  const update = <K extends keyof Selection>(field: K, value: Selection[K]) =>
    switchOrConfirm(() => applyUpdate(field, value))
  const act = async (label: string, action: () => Promise<void>) => {
    try {
      setBusy(true)
      await action()
      if (label) setMessage(label)
    } catch (error) {
      setMessage(`操作失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
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
    requestText(
      copyCurrent ? '复制版本名称' : '新版本名称',
      copyCurrent ? `${currentVersion?.name ?? ''} 副本` : '新版本',
      copyCurrent ? '复制版本' : '创建版本',
      name => {
        void act('Version 已创建并切换。', async () => {
          const source = copyCurrent ? selection : { ...selection, version: currentNode!.defaultVersion }
          const id = await api.createVersion(source, name)
          await refresh()
          setSelection(s => ({ ...s, version: id }))
        })
      },
    )
  }
  const renameVersion = () => {
    requestText('Version 新名称', currentVersion?.name ?? '', '保存名称', name => {
      void act('Version 已重命名。', async () => {
        await api.renameVersion(selection, name)
        await refresh()
      })
    })
  }
  const deleteVersion = () => {
    requestConfirm(
      '删除 Version？',
      `“${currentVersion?.name}”将被永久删除。`,
      '删除 Version',
      () => {
        void act('Version 已删除。', async () => {
          await api.deleteVersion(selection)
          const next = await refresh()
          const found = next.galaxies.find(g => g.id === selection.galaxy)?.nodes.find(n => n.id === selection.node)
          setSelection(s => ({ ...s, version: found?.defaultVersion ?? found?.versions[0]?.id ?? '' }))
        })
      },
      true,
    )
  }
  const createCommon = (copyCurrent: boolean) => {
    if (!requireSaved()) return
    requestText(
      copyCurrent ? '复制 Common 名称' : '新 Common 名称',
      copyCurrent ? `${currentCommon?.name ?? ''} 副本` : '新 Common',
      copyCurrent ? '复制配置' : '创建配置',
      name => {
        void act('Common 已创建并切换。', async () => {
          const source = copyCurrent ? selection : { ...selection, common: currentGalaxy!.defaultCommon }
          const id = await api.createCommon(source, name)
          await refresh()
          setSelection(s => ({ ...s, common: id }))
        })
      },
    )
  }
  const renameCommon = () => {
    requestText('Common 新名称', currentCommon?.name ?? '', '保存名称', name => {
      void act('Common 已重命名。', async () => {
        await api.renameCommon(selection, name)
        await refresh()
      })
    })
  }
  const deleteCommon = () => {
    requestConfirm(
      '删除 Common？',
      `“${currentCommon?.name}”将被永久删除。`,
      '删除 Common',
      () => {
        void act('Common 已删除。', async () => {
          await api.deleteCommon(selection)
          const next = await refresh()
          const galaxy = next.galaxies.find(g => g.id === selection.galaxy)
          setSelection(s => ({ ...s, common: galaxy?.defaultCommon ?? galaxy?.commons[0]?.id ?? '' }))
        })
      },
      true,
    )
  }
  const start = () =>
    act('搜索完成。', async () => {
      if (dirty) throw new Error('当前配置存在未保存修改。请先保存后再启动。')
      setLogs('')
      setRun(null)
      setRunKey('')
      setGalaxyDetail(null)
      setMessage('Optimizer 正在运行…')
      const result = await api.run(selection)
      setRun(result)
      if (result.error) throw new Error(result.error)
      setRunKey(keyOf(selection))
    })
  const useBest = () => {
    requestConfirm(
      '使用最优配置？',
      `Best Found 将覆盖 ${selection.node} / ${currentVersion?.name} 的 baseline，不会创建新 Version。`,
      '使用最优配置',
      () => {
        void act('Best Found 已写入当前 Version；其他 Version 未修改。', async () => {
          if (dirty) throw new Error('当前配置存在未保存修改。')
          if (!activeRun?.result) throw new Error('当前选择没有可采用的本次搜索结果。')
          const result = await api.useBest(selection)
          if (result.error || !result.node) throw new Error(result.error ?? 'Copy 未返回有效 Node。')
          const source = format(result.node)
          setNode(result.node)
          setNodeSource(source)
          setSavedNodeSource(source)
          setRun(null)
          setRunKey('')
          setGalaxyDetail(null)
        })
      },
    )
  }
  const rerunCurrentGalaxy = () =>
    act('', async () => {
      if (dirty) throw new Error('当前配置存在未保存修改。请先保存后再启动。')
      setLogs('')
      setRun(null)
      setRunKey('')
      setGalaxyDetail(null)
      setMessage(`${selection.galaxy.toUpperCase()} 正在串行重跑…`)
      const result = await api.rerunGalaxy(selection.galaxy)
      setGalaxyRerun(result)
      const failed = result.nodes.filter(item => item.status === 'failed').length
      const changed = result.nodes.filter(item => item.changed).length
      setMessage(`Galaxy 重跑完成：发现 ${changed} 个配置变化，${failed} 个节点失败。`)
    })
  const openGalaxyResult = (item: GalaxyRerunNode) => {
    switchOrConfirm(() => {
      setMessage('')
      setGalaxyDetail(item)
      setWorkspace('node')
      setRun(null)
      setRunKey('')
      setSelection({ galaxy: galaxyRerun!.galaxy, node: item.node, version: item.version, common: item.common })
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
    requestText('模板名称', `${selection.galaxy} ${selection.node}`, '创建模板', name => {
      void act('模板已从当前 Version 创建。', async () => {
        await api.createTemplate(selection, name)
        await refresh()
      })
    })
  }
  const renameTemplate = () => {
    const item = catalog.templates.find(t => t.id === template)
    requestText('模板新名称', item?.name ?? '', '保存名称', name => {
      void act('模板已重命名。', async () => {
        await api.renameTemplate(template, name)
        await refresh()
      })
    })
  }
  const deleteTemplate = () => {
    const item = catalog.templates.find(t => t.id === template)
    if (!item) return
    requestConfirm(
      '删除模板？',
      `“${item.name}”将被永久删除。`,
      '删除模板',
      () => {
        void act('模板已删除。', async () => {
          await api.deleteTemplate(template)
          const next = await refresh()
          setTemplate(next.templates[0]?.id ?? '')
        })
      },
      true,
    )
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
      <aside className="sidebar" aria-label="主工作区">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◇
          </span>
          <span>舰队管理器</span>
        </div>
        <nav>
          <button className={workspace === 'node' ? 'active' : ''} onClick={() => setWorkspace('node')}>
            <Icon name="node" />
            节点配置
          </button>
          <button className={workspace === 'rerun' ? 'active' : ''} onClick={() => setWorkspace('rerun')}>
            <Icon name="play" />
            Galaxy 重跑
          </button>
          <button className={workspace === 'templates' ? 'active' : ''} onClick={() => setWorkspace('templates')}>
            <Icon name="copy" />
            模板与复制
          </button>
        </nav>
        <div className="runtime-note">
          <span className={`runtime-dot ${api.runtime ?? 'desktop'}`} />
          {api.runtime === 'web' ? 'Web 工作区' : '桌面工作区'}
        </div>
      </aside>
      <header className="topbar">
        <div>
          <h1>{workspace === 'node' ? '节点配置' : workspace === 'rerun' ? 'Galaxy 重跑' : '模板与复制'}</h1>
          <span>
            {workspace === 'node'
              ? '编辑阵型、装配与搜索参数'
              : workspace === 'rerun'
                ? '串行检查当前 Galaxy 的默认配置'
                : '从稳定配置快速创建 Node'}
          </span>
        </div>
        <div className="actions">
          {workspace === 'node' ? (
            <>
              <button onClick={() => void saveNode()} disabled={busy || !nodeDirty}>
                保存节点
              </button>
              <button onClick={() => void saveCommon()} disabled={busy || !commonDirty}>
                保存公共配置
              </button>
            </>
          ) : null}
          {workspace === 'rerun' ? (
            <button className="primary" onClick={() => void rerunCurrentGalaxy()} disabled={busy}>
              {busy ? '重跑中…' : `重跑 ${selection.galaxy.toUpperCase()}`}
            </button>
          ) : null}
        </div>
      </header>
      <section className="contextbar" aria-label="当前配置上下文">
        <Label text="Galaxy">
          <select value={selection.galaxy} onChange={e => update('galaxy', e.target.value)}>
            {catalog.galaxies.map(g => (
              <option key={g.id} value={g.id}>
                {g.id.toUpperCase()}
              </option>
            ))}
          </select>
        </Label>
        <Label text="节点">
          <select value={selection.node} onChange={e => update('node', e.target.value)}>
            {currentGalaxy?.nodes.map(n => (
              <option key={n.id} value={n.id}>
                {n.id}
              </option>
            ))}
          </select>
        </Label>
        <Label text="版本">
          <select value={selection.version} onChange={e => update('version', e.target.value)}>
            {currentNode?.versions.map(v => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.isDefault ? ' ★' : ''}
              </option>
            ))}
          </select>
          <ActionMenu
            label="管理版本"
            actions={[
              { label: '新建版本', onClick: () => createVersion(false) },
              { label: '复制当前版本', onClick: () => createVersion(true) },
              { label: '重命名', onClick: renameVersion },
              {
                label: '设为默认',
                disabled: currentVersion?.isDefault,
                onClick: () =>
                  void act('已设为默认版本。', async () => {
                    await api.setDefaultVersion(selection)
                    await refresh()
                  }),
              },
              {
                label: '删除版本',
                danger: true,
                disabled: currentVersion?.isDefault || (currentNode?.versions.length ?? 0) <= 1,
                onClick: deleteVersion,
              },
            ]}
            disabled={busy}
          />
        </Label>
        <Label text="公共配置">
          <select value={selection.common} onChange={e => update('common', e.target.value)}>
            {currentGalaxy?.commons.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isDefault ? ' ★' : ''}
              </option>
            ))}
          </select>
          <ActionMenu
            label="管理公共配置"
            actions={[
              { label: '新建配置', onClick: () => createCommon(false) },
              { label: '复制当前配置', onClick: () => createCommon(true) },
              { label: '重命名', onClick: renameCommon },
              {
                label: '设为默认',
                disabled: currentCommon?.isDefault,
                onClick: () =>
                  void act('已设为默认公共配置。', async () => {
                    await api.setDefaultCommon(selection)
                    await refresh()
                  }),
              },
              {
                label: '删除配置',
                danger: true,
                disabled: currentCommon?.isDefault || (currentGalaxy?.commons.length ?? 0) <= 1,
                onClick: deleteCommon,
              },
            ]}
            disabled={busy}
          />
        </Label>
        <div className={`save-state ${dirty ? 'dirty' : 'saved'}`} role="status">
          <span aria-hidden="true">{dirty ? '●' : '✓'}</span>
          <div>
            <strong>{dirty ? '有未保存修改' : '已保存'}</strong>
            <small>
              {selection.galaxy.toUpperCase()} / {selection.node}
            </small>
          </div>
        </div>
      </section>
      {message ? (
        <p className="notice" role="status">
          {message}
        </p>
      ) : null}
      {workspace === 'rerun' ? (
        galaxyRerun ? (
          <GalaxyRerunPanel progress={galaxyRerun} onOpen={openGalaxyResult} />
        ) : (
          <section className="panel rerun-empty">
            <div className="empty-symbol" aria-hidden="true">
              ↻
            </div>
            <h2>检查 {selection.galaxy.toUpperCase()} 的默认配置</h2>
            <p>按节点顺序运行默认版本，并使用当前 Galaxy 的默认公共配置。只报告阵型或装配变化，不会自动采用结果。</p>
            <button className="primary" onClick={() => void rerunCurrentGalaxy()} disabled={busy}>
              {busy ? '正在重跑…' : `开始重跑 ${selection.galaxy.toUpperCase()}`}
            </button>
          </section>
        )
      ) : null}
      {workspace === 'templates' ? (
        <section className="management panel workspace-view">
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
      ) : null}
      {workspace === 'node' ? (
        <section className="workspace workspace-view">
          <section className="editor panel">
            <div className="panel-heading">
              <div>
                <h2>当前节点</h2>
                <p>直接编辑常用配置；底层值保持 Optimizer 兼容。</p>
              </div>
              <span className="node-code">
                {selection.galaxy.toUpperCase()} / {selection.node}
              </span>
            </div>
            <div className="tabs" role="tablist" aria-label="节点配置区域">
              {(
                [
                  ['formation', '阵型'],
                  ['loadout', '装配'],
                  ['common', '公共配置'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={editorTab === id}
                  className={editorTab === id ? 'active' : ''}
                  onClick={() => setEditorTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {node && editorTab === 'formation' ? <FormationEditor config={node} onChange={tableChange} /> : null}
            {node && editorTab === 'loadout' ? <LoadoutEditor config={node} onChange={tableChange} /> : null}
            {common && editorTab === 'common' ? (
              <CommonEditor
                config={common}
                onChange={next => {
                  setCommon(next)
                  setCommonSource(format(next))
                }}
              />
            ) : null}
            <details className="advanced">
              <summary>高级：原始 JSON</summary>
              <div className="advanced-grid">
                <Label text="Node JSON">
                  <textarea
                    value={nodeSource}
                    onChange={e => setNodeSource(e.target.value)}
                    spellCheck={false}
                    aria-label="Node JSON 编辑器"
                  />
                </Label>
                <Label text="Common JSON">
                  <textarea
                    value={commonSource}
                    onChange={e => setCommonSource(e.target.value)}
                    spellCheck={false}
                    aria-label="Common JSON 编辑器"
                  />
                </Label>
              </div>
            </details>
          </section>
          <aside className="results" aria-label="搜索与结果">
            <section className="panel search-panel">
              <div className="panel-heading">
                <div>
                  <h2>搜索设置</h2>
                  <p>使用当前保存的节点与公共配置。</p>
                </div>
              </div>
              {node ? <SearchSettings config={node} onChange={tableChange} /> : null}
              <button className="primary start-search" onClick={() => void start()} disabled={busy || dirty}>
                <Icon name="play" />
                {busy ? '正在搜索…' : '开始搜索'}
              </button>
              {dirty ? <small className="button-help">保存修改后即可搜索。</small> : null}
            </section>
            <section className="panel run-status">
              <div className="panel-heading compact">
                <h2>搜索状态</h2>
                <span className={`run-dot ${busy ? 'running' : activeRun ? 'done' : ''}`} />
              </div>
              <dl>
                <dt>状态</dt>
                <dd>{busy ? '搜索中' : activeRun ? '已完成' : '空闲'}</dd>
                <dt>选择</dt>
                <dd>
                  {selection.node} / {currentVersion?.name}
                </dd>
              </dl>
              <details className="console">
                <summary>Optimizer 输出</summary>
                <pre className="logs">{logs || '尚未启动任务。'}</pre>
              </details>
            </section>
            <section className="panel result-panel">
              <div className="panel-heading">
                <div>
                  <h2>搜索结果</h2>
                  <p>当前配置与本次 Best Found。</p>
                </div>
              </div>
              {activeRun?.result?.best_result ? (
                <>
                  <div className="candidate-comparison">
                    <CandidateTable title="当前配置" candidate={activeRun.result.verified_baseline} />
                    <CandidateTable title="最优配置" candidate={activeRun.result.best_result} best />
                  </div>
                  <h3>差异</h3>
                  {changes.length ? (
                    <table className="diff-table">
                      <thead>
                        <tr>
                          <th>位置</th>
                          <th>字段</th>
                          <th>当前</th>
                          <th>最优</th>
                        </tr>
                      </thead>
                      <tbody>
                        {changes.map((c, i) => (
                          <tr key={i}>
                            <td>{c.position}</td>
                            <td>{c.field}</td>
                            <td>{c.field === 'ship' ? shipDisplayName(c.before, false) : String(c.before ?? '—')}</td>
                            <td>{c.field === 'ship' ? shipDisplayName(c.after, false) : String(c.after ?? '—')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="no-change">✓ 阵型与装配没有变化。</p>
                  )}
                  <button className="success use-best" onClick={useBest} disabled={busy || !changes.length}>
                    <Icon name="check" />
                    使用最优配置
                  </button>
                  <small className="button-help">写入当前版本，不会创建新版本。</small>
                </>
              ) : (
                <div className="result-empty">
                  <span aria-hidden="true">◎</span>
                  <strong>还没有搜索结果</strong>
                  <p>{activeRun?.error ?? '开始搜索后，这里会显示当前配置、Best Found 和具体差异。'}</p>
                </div>
              )}
            </section>
          </aside>
        </section>
      ) : null}
      {dialog ? <AppDialog dialog={dialog} onClose={() => setDialog(null)} /> : null}
    </main>
  )
}

function AppDialog({ dialog, onClose }: { dialog: DialogState; onClose: () => void }) {
  const [value, setValue] = useState(dialog.kind === 'input' ? dialog.initial : '')
  const confirm = () => {
    if (dialog.kind === 'input') {
      const next = value.trim()
      if (!next) return
      dialog.onConfirm(next)
    } else dialog.onConfirm()
    onClose()
  }
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <section className="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title">
        <h2 id="app-dialog-title">{dialog.title}</h2>
        {dialog.kind === 'input' ? (
          <label>
            <span>名称</span>
            <input
              autoFocus
              aria-label="名称"
              value={value}
              onChange={event => setValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') confirm()
                if (event.key === 'Escape') onClose()
              }}
            />
          </label>
        ) : (
          <p>{dialog.body}</p>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
          <button
            className={dialog.kind === 'confirm' && dialog.danger ? 'danger-button' : 'primary'}
            disabled={dialog.kind === 'input' && !value.trim()}
            onClick={confirm}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

function CandidateTable({
  title,
  candidate,
  best = false,
}: {
  title: string
  candidate: NonNullable<RunResult['result']>['best_result']
  best?: boolean
}) {
  return (
    <div className={`candidate ${best ? 'best' : ''}`}>
      <h3>{title}</h3>
      <dl>
        <dt>结果</dt>
        <dd>{candidate?.outcome ?? '—'}</dd>
        <dt>舰队资源</dt>
        <dd>{candidate?.fleet_resources_used ?? '—'}</dd>
      </dl>
      <div className="candidate-ships">
        {(candidate?.formation ?? []).map(entry => (
          <span key={entry.position}>
            <b>{entry.position}</b> {shipDisplayName(entry.ship, false)}
          </span>
        ))}
      </div>
    </div>
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

function Icon({ name }: { name: 'node' | 'play' | 'copy' | 'check' }) {
  const paths = {
    node: <path d="M5 5h14v14H5zM9 9h6v6H9z" />,
    play: <path d="m8 5 11 7-11 7z" />,
    copy: <path d="M9 9h10v10H9zM5 5h10v2H7v8H5z" />,
    check: <path d="m5 12 4 4L19 6" />,
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  )
}

function ActionMenu({
  label,
  actions,
  disabled,
}: {
  label: string
  actions: Array<{ label: string; onClick: () => void; disabled?: boolean; danger?: boolean }>
  disabled?: boolean
}) {
  return (
    <details className="action-menu">
      <summary aria-label={label} aria-disabled={disabled}>
        <span aria-hidden="true">•••</span>
      </summary>
      <div className="action-menu-popover">
        {actions.map(action => (
          <button
            key={action.label}
            className={action.danger ? 'danger' : ''}
            disabled={disabled || action.disabled}
            onClick={event => {
              action.onClick()
              event.currentTarget.closest('details')?.removeAttribute('open')
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </details>
  )
}

function FormationEditor({ config, onChange }: { config: NodeConfig; onChange: (n: NodeConfig) => void }) {
  const slots = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5']
  const available = new Set(Object.keys(config.player_state.ships))
  const options = SHIP_TYPES.filter(item => available.has(item.id))
  const update = (position: string, ship: ShipId | '') => {
    const previous = config.baseline.formation[position]
    onChange({
      ...config,
      baseline: {
        ...config.baseline,
        formation: {
          ...config.baseline.formation,
          [position]: preserveShipSelectorFormat(previous, ship),
        },
      },
    })
  }
  return (
    <section className="config-section">
      <div className="section-heading">
        <div>
          <h3>阵型</h3>
          <p>两行五列；数字与英文格式会按原配置保留。</p>
        </div>
        <span className="format-hint">1–5 / English</span>
      </div>
      <div className="formation-board">
        {['A', 'B'].map(row => (
          <div className="formation-row" key={row}>
            <strong>{row} 行</strong>
            <div className="formation-slots">
              {slots
                .filter(position => position.startsWith(row))
                .map(position => {
                  const raw = config.baseline.formation[position]
                  return (
                    <label className="formation-slot" key={position}>
                      <span>{position}</span>
                      <select
                        aria-label={`${position} 舰种`}
                        value={shipSelectorToId(raw)}
                        onChange={event => update(position, event.target.value as ShipId | '')}
                      >
                        <option value="">空位</option>
                        {options.map(ship => (
                          <option key={ship.id} value={ship.id}>
                            {ship.name} · {ship.id} · {ship.numeric}
                          </option>
                        ))}
                      </select>
                      <small>{shipDisplayName(raw)}</small>
                    </label>
                  )
                })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function LoadoutEditor({ config, onChange }: { config: NodeConfig; onChange: (n: NodeConfig) => void }) {
  const load = (ship: string, field: 'primary' | 'secondary' | 'tertiary_mods', value: string) => {
    const old = config.baseline.loadouts[ship] ?? {}
    const oldValue = old[field]
    const scalar = value || null
    const nextValue =
      field === 'tertiary_mods'
        ? value
            .split(',')
            .map(x => x.trim())
            .filter(Boolean)
        : typeof oldValue === 'number' && /^\d+$/.test(value)
          ? Number(value)
          : scalar
    onChange({
      ...config,
      baseline: {
        ...config.baseline,
        loadouts: {
          ...config.baseline.loadouts,
          [ship]: {
            ...old,
            [field]: nextValue,
          },
        },
      },
    })
  }
  return (
    <section className="config-section">
      <div className="section-heading">
        <div>
          <h3>装配</h3>
          <p>Mod ID 保持 Optimizer 原值；数字槽位编辑时保留数字类型。</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="loadout-table">
          <thead>
            <tr>
              <th>舰种</th>
              <th>主模组 Primary</th>
              <th>副模组 Secondary</th>
              <th>三级模组 Tertiary</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(config.baseline.loadouts).map(([ship, l]) => (
              <tr key={ship}>
                <td>
                  <strong>{shipDisplayName(ship, false)}</strong>
                  <small>{ship}</small>
                </td>
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
      </div>
    </section>
  )
}

function CommonEditor({ config, onChange }: { config: CommonConfig; onChange: (value: CommonConfig) => void }) {
  const update = (group: 'permanent' | 'temporary', field: 'damage_scale' | 'health_scale', value: string) =>
    onChange({ ...config, [group]: { ...config[group], [field]: Number(value) } })
  return (
    <section className="config-section common-form">
      <div className="section-heading">
        <div>
          <h3>公共加成</h3>
          <p>当前 Galaxy 搜索时使用的永久与临时倍率。</p>
        </div>
      </div>
      {(['permanent', 'temporary'] as const).map(group => (
        <fieldset key={group}>
          <legend>{group === 'permanent' ? '永久加成' : '临时加成'}</legend>
          <Label text="伤害倍率">
            <input
              type="number"
              step="0.01"
              value={config[group].damage_scale}
              onChange={event => update(group, 'damage_scale', event.target.value)}
            />
          </Label>
          <Label text="生命倍率">
            <input
              type="number"
              step="0.01"
              value={config[group].health_scale}
              onChange={event => update(group, 'health_scale', event.target.value)}
            />
          </Label>
        </fieldset>
      ))}
    </section>
  )
}

function SearchSettings({ config, onChange }: { config: NodeConfig; onChange: (value: NodeConfig) => void }) {
  const update = <K extends keyof NodeConfig['search']>(field: K, value: NodeConfig['search'][K]) =>
    onChange({ ...config, search: { ...config.search, [field]: value } })
  return (
    <div className="search-settings">
      <Label text="搜索档位">
        <input value={config.search.profile} onChange={event => update('profile', event.target.value)} />
      </Label>
      <Label text="目标">
        <input value={config.search.goal} onChange={event => update('goal', event.target.value)} />
      </Label>
      <Label text="模拟时钟">
        <select
          value={config.search.simulation_clock}
          onChange={event => update('simulation_clock', event.target.value as NodeConfig['search']['simulation_clock'])}
        >
          <option value="offline_fixed_step">离线固定步长</option>
          <option value="realtime">实时</option>
        </select>
      </Label>
      <div className="numeric-settings">
        <Label text="最大模拟次数">
          <input
            type="number"
            min="1"
            value={config.search.max_simulations}
            onChange={event => update('max_simulations', Number(event.target.value))}
          />
        </Label>
        <Label text="线程数">
          <input
            type="number"
            min="1"
            value={config.search.workers}
            onChange={event => update('workers', Number(event.target.value))}
          />
        </Label>
      </div>
      <Label text="最长时间（秒）">
        <input
          type="number"
          min="1"
          value={config.search.max_wall_seconds}
          onChange={event => update('max_wall_seconds', Number(event.target.value))}
        />
      </Label>
    </div>
  )
}
