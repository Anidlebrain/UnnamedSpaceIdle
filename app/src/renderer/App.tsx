import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Catalog,
  ConfigSource,
  FleetManagerApi,
  GalaxyRerunNode,
  GalaxyRerunProgress,
  ImportPreview,
  OptimizerOutput,
  RunResult,
  Selection,
} from '../shared/contracts'
import type { CommonConfig, NodeConfig, OptimizerConfig, SearchConfig } from '../shared/schemas'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'
import { diffFormation } from '../shared/formation-diff'
import {
  preserveShipSelectorFormat,
  SHIP_TYPES,
  shipDisplayName,
  shipSelectorToId,
  type ShipId,
} from '../shared/ship-selectors'
import {
  catalogMods,
  modDisplayName,
  preserveModSelectorFormat,
  resolveModSelector,
  slotOptions,
  type ModSlot,
} from '../shared/mod-catalog'
import { GalaxyRerunPanel } from './GalaxyRerunPanel'
import {
  commonDomainKey,
  chooseInitial,
  formatJson,
  initialContexts,
  isDirty,
  nodeDomainKey,
  nodeLocked,
  commonLocked,
  taskFromSnapshot,
  updateSelection,
  type Draft,
  type PageContexts,
  type SearchTaskState,
  type Workspace,
} from './state-model'

const emptySelection: Selection = { galaxy: '', node: '', version: '', common: '' }
const emptyCatalog: Catalog = { galaxies: [], templates: [] }
const format = formatJson
type EditorTab = 'formation' | 'fleet' | 'loadout' | 'environment'
type CommonTab = 'galaxy' | 'optimizer'
const LAST_SEARCH_KEY = 'fleet-manager-last-search-v1'
const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`
const taskDuration = (task: SearchTaskState) =>
  task.finishedAt
    ? Math.max(0, Math.round((Date.parse(task.finishedAt) - Date.parse(task.snapshot.startedAt)) / 1000))
    : 0

function storedSearchSelection(catalog: Catalog): Selection | null {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_SEARCH_KEY) ?? 'null') as Partial<Selection> | null
    const galaxy = catalog.galaxies.find(item => item.id === stored?.galaxy)
    const node = galaxy?.nodes.find(item => item.id === stored?.node)
    if (!galaxy || !node) return null
    return {
      galaxy: galaxy.id,
      node: node.id,
      version: node.versions.some(item => item.id === stored?.version) ? stored!.version! : node.defaultVersion,
      common: galaxy.commons.some(item => item.id === stored?.common) ? stored!.common! : galaxy.defaultCommon,
    }
  } catch {
    return null
  }
}
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
  const [, setPageContexts] = useState<PageContexts | null>(null)
  const pageContextsRef = useRef<PageContexts | null>(null)
  const nodeDrafts = useRef(new Map<string, Draft<NodeConfig>>())
  const searchDrafts = useRef(new Map<string, Draft<NodeConfig>>())
  const commonDrafts = useRef(new Map<string, Draft<CommonConfig>>())
  const [node, setNode] = useState<NodeConfig | null>(null)
  const [common, setCommon] = useState<CommonConfig | null>(null)
  const [optimizerConfig, setOptimizerConfig] = useState<OptimizerConfig | null>(null)
  const [searchConfig, setSearchConfig] = useState<SearchConfig | null>(null)
  const [searchConfigSource, setSearchConfigSource] = useState('')
  const [savedSearchConfigSource, setSavedSearchConfigSource] = useState('')
  const [configSources, setConfigSources] = useState<{ search: ConfigSource; optimizer: ConfigSource }>({
    search: 'default',
    optimizer: 'default',
  })
  const [searchSettingsOpen, setSearchSettingsOpen] = useState(false)
  const [nodeSource, setNodeSource] = useState('')
  const [commonSource, setCommonSource] = useState('')
  const [savedNodeSource, setSavedNodeSource] = useState('')
  const [savedCommonSource, setSavedCommonSource] = useState('')
  const [optimizerSource, setOptimizerSource] = useState('')
  const [savedOptimizerSource, setSavedOptimizerSource] = useState('')
  const [logs, setLogs] = useState('')
  const [searchTask, setSearchTask] = useState<SearchTaskState | null>(null)
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
  const [commonTab, setCommonTab] = useState<CommonTab>('galaxy')
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const currentGalaxy = catalog.galaxies.find(g => g.id === selection.galaxy)
  const currentNode = currentGalaxy?.nodes.find(n => n.id === selection.node)
  const currentVersion = currentNode?.versions.find(v => v.id === selection.version)
  const currentCommon = currentGalaxy?.commons.find(c => c.id === selection.common)
  const nodeDirty = Boolean(node && nodeSource !== savedNodeSource)
  const commonDirty = Boolean(common && commonSource !== savedCommonSource)
  const optimizerDirty = Boolean(optimizerConfig && optimizerSource !== savedOptimizerSource)
  const searchDirty = Boolean(searchConfig && searchConfigSource !== savedSearchConfigSource)
  const dirty =
    workspace === 'node'
      ? nodeDirty
      : workspace === 'search'
        ? searchDirty
        : workspace === 'common'
          ? commonTab === 'galaxy'
            ? commonDirty
            : optimizerDirty
          : false
  const taskRunning = searchTask?.status === 'running'
  const nodeReadOnly = nodeLocked(searchTask, selection)
  const commonReadOnly = commonLocked(searchTask, selection)
  const optimizerReadOnly = Boolean(taskRunning)
  const hasAnyDirtyDraft =
    nodeDirty ||
    commonDirty ||
    optimizerDirty ||
    searchDirty ||
    [...nodeDrafts.current.values()].some(draft => isDirty(draft)) ||
    [...searchDrafts.current.values()].some(draft => isDirty(draft)) ||
    [...commonDrafts.current.values()].some(draft => isDirty(draft))

  const refresh = async () => {
    const next = await api.catalog()
    setCatalog(next)
    return next
  }
  useEffect(() => {
    void Promise.all([refresh(), api.loadOptimizerConfig(), api.loadSearchConfig(), api.configSources()])
      .then(([next, optimizer, search, sources]) => {
        const source = format(optimizer)
        setOptimizerConfig(optimizer)
        setOptimizerSource(source)
        setSavedOptimizerSource(source)
        const searchSource = format(search)
        setSearchConfig(search)
        setSearchConfigSource(searchSource)
        setSavedSearchConfigSource(searchSource)
        setConfigSources(sources)
        const contexts = initialContexts(next, storedSearchSelection(next))
        pageContextsRef.current = contexts
        setPageContexts(contexts)
        setSelection(contexts.node)
      })
      .catch(error => setMessage(`无法读取 Manager / Optimizer 配置：${(error as Error).message}`))
    const stopOutput = api.onOutput((output: OptimizerOutput) => {
      setLogs(previous => `${previous}${output.line}`)
      if (!output.taskId) return
      setSearchTask(current => {
        if (!current || current.snapshot.taskId !== output.taskId) return current
        return { ...current, logs: `${current.logs}${output.line}` }
      })
    })
    const stopTask = api.onSearchTask(task => setSearchTask(taskFromSnapshot(task)))
    const stopProgress = api.onGalaxyProgress(setGalaxyRerun)
    return () => {
      stopOutput()
      stopTask()
      stopProgress()
    }
  }, [api])
  useEffect(() => {
    if (!searchTask || searchTask.status !== 'running') return
    const updateElapsed = () =>
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - Date.parse(searchTask.snapshot.startedAt)) / 1000)))
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [searchTask?.snapshot.startedAt, searchTask?.status])
  useEffect(() => {
    if (!hasAnyDirtyDraft) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasAnyDirtyDraft])
  useEffect(() => {
    if (!selection.galaxy || !selection.node || !selection.version || !selection.common) {
      setNode(null)
      setCommon(null)
      return
    }
    const nodeKey = nodeDomainKey(selection)
    const commonKey = commonDomainKey(selection)
    const nodeCache = workspace === 'search' ? searchDrafts.current : nodeDrafts.current
    const cachedNode = nodeCache.get(nodeKey)
    const cachedCommon = commonDrafts.current.get(commonKey)
    if (cachedNode) {
      setNode(cachedNode.value)
      setNodeSource(cachedNode.source)
      setSavedNodeSource(cachedNode.savedSource)
    } else setNode(null)
    if (cachedCommon) {
      setCommon(cachedCommon.value)
      setCommonSource(cachedCommon.source)
      setSavedCommonSource(cachedCommon.savedSource)
    } else setCommon(null)
    if (cachedNode && (workspace !== 'common' || cachedCommon)) return
    let active = true
    void api
      .load(selection)
      .then(data => {
        if (!active) return
        const nextNode = format(data.node),
          nextCommon = format(data.common)
        if (!cachedNode) {
          const draft = { value: data.node, source: nextNode, savedSource: nextNode }
          nodeCache.set(nodeKey, draft)
          setNode(data.node)
          setNodeSource(nextNode)
          setSavedNodeSource(nextNode)
        }
        if (!cachedCommon) {
          const draft = { value: data.common, source: nextCommon, savedSource: nextCommon }
          commonDrafts.current.set(commonKey, draft)
          setCommon(data.common)
          setCommonSource(nextCommon)
          setSavedCommonSource(nextCommon)
        }
      })
      .catch(error => active && setMessage(error.message))
    return () => {
      active = false
    }
  }, [api, workspace, selection.galaxy, selection.node, selection.version, selection.common])

  const detailKey = galaxyDetail
    ? `${galaxyRerun?.galaxy}/${galaxyDetail.node}/${galaxyDetail.version}/${galaxyDetail.common}`
    : ''
  const selectionKey = `${selection.galaxy}/${selection.node}/${selection.version}/${selection.common}`
  const activeRun =
    detailKey === selectionKey
      ? galaxyDetail?.run
      : searchTask
        ? {
            exitCode: searchTask.exitCode ?? (searchTask.status === 'failed' ? -1 : 0),
            startedAt: searchTask.snapshot.startedAt,
            finishedAt: searchTask.finishedAt ?? searchTask.snapshot.startedAt,
            result: searchTask.result,
            error: searchTask.error,
            task: searchTask.snapshot,
          }
        : null
  const changes = useMemo(
    () => (activeRun?.result ? diffFormation(activeRun.result.verified_baseline, activeRun.result.best_result) : []),
    [activeRun],
  )
  const requestText = (title: string, initial: string, confirmLabel: string, onConfirm: (value: string) => void) =>
    setDialog({ kind: 'input', title, initial, confirmLabel, onConfirm })
  const requestConfirm = (title: string, body: string, confirmLabel: string, onConfirm: () => void, danger = false) =>
    setDialog({ kind: 'confirm', title, body, confirmLabel, onConfirm, danger })
  const cacheCurrentDraft = () => {
    if (node) {
      const cache = workspace === 'search' ? searchDrafts.current : nodeDrafts.current
      cache.set(nodeDomainKey(selection), { value: node, source: nodeSource, savedSource: savedNodeSource })
    }
    if (common)
      commonDrafts.current.set(commonDomainKey(selection), {
        value: common,
        source: commonSource,
        savedSource: savedCommonSource,
      })
  }
  const switchWorkspace = (next: Workspace) => {
    cacheCurrentDraft()
    const contexts = pageContextsRef.current
    if (!contexts) return
    setWorkspace(next)
    setGalaxyDetail(null)
    if (next === 'rerun') {
      const galaxy = catalog.galaxies.find(item => item.id === contexts.rerunGalaxy) ?? catalog.galaxies[0]
      const first = galaxy?.nodes[0]
      setSelection({
        galaxy: galaxy?.id ?? '',
        node: first?.id ?? '',
        version: first?.defaultVersion ?? '',
        common: galaxy?.defaultCommon ?? '',
      })
    } else setSelection(contexts[next])
  }
  const setCurrentSelection = (next: Selection) => {
    setSelection(next)
    const contexts = pageContextsRef.current
    if (!contexts) return
    const updated =
      workspace === 'rerun' ? { ...contexts, rerunGalaxy: next.galaxy } : { ...contexts, [workspace]: next }
    pageContextsRef.current = updated
    setPageContexts(updated)
  }
  const applyUpdate = <K extends keyof Selection>(field: K, value: Selection[K]) => {
    setMessage('')
    cacheCurrentDraft()
    const next = updateSelection(catalog, selection, field, value)
    setCurrentSelection(next)
    if (field === 'galaxy') setNewNodeGalaxy(value)
  }
  const update = <K extends keyof Selection>(field: K, value: Selection[K]) => applyUpdate(field, value)
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
  const requireNodeSaved = (sourceSelection = selection, searchDomain = workspace === 'search') => {
    cacheCurrentDraft()
    const cache = searchDomain ? searchDrafts.current : nodeDrafts.current
    if (!isDirty(cache.get(nodeDomainKey(sourceSelection)))) return true
    setMessage('该来源有未保存草稿；请先保存或改用其他来源。')
    return false
  }
  const saveNode = () =>
    act('Node Version 已原子保存。', async () => {
      const parsed = JSON.parse(nodeSource)
      await api.save(selection, parsed)
      const source = format(parsed)
      setNode(parsed)
      setNodeSource(source)
      setSavedNodeSource(source)
      nodeDrafts.current.set(nodeDomainKey(selection), { value: parsed, source, savedSource: source })
    })
  const saveCommon = () =>
    act('Common 配置已原子保存。', async () => {
      const parsed = JSON.parse(commonSource)
      await api.saveCommon(selection, parsed)
      setCommon(parsed)
      setCommonSource(format(parsed))
      setSavedCommonSource(format(parsed))
      commonDrafts.current.set(commonDomainKey(selection), {
        value: parsed,
        source: format(parsed),
        savedSource: format(parsed),
      })
    })
  const saveOptimizerConfig = () =>
    act('Optimizer 公共配置已原子保存；后续搜索将直接使用该文件。', async () => {
      const parsed = JSON.parse(optimizerSource)
      await api.saveOptimizerConfig(parsed)
      const source = format(parsed)
      setOptimizerConfig(parsed)
      setOptimizerSource(source)
      setSavedOptimizerSource(source)
      setConfigSources(current => ({ ...current, optimizer: 'local' }))
    })
  const createVersion = (copyCurrent: boolean) => {
    if (copyCurrent && !requireNodeSaved(selection, false)) return
    requestText(
      copyCurrent ? '复制版本名称' : '新版本名称',
      copyCurrent ? `${currentVersion?.name ?? ''} 副本` : '新版本',
      copyCurrent ? '复制版本' : '创建版本',
      name => {
        void act('Version 已创建并切换。', async () => {
          const source = copyCurrent ? selection : { ...selection, version: currentNode!.defaultVersion }
          const id = await api.createVersion(source, name)
          await refresh()
          setCurrentSelection({ ...selection, version: id })
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
          setCurrentSelection({ ...selection, version: found?.defaultVersion ?? found?.versions[0]?.id ?? '' })
        })
      },
      true,
    )
  }
  const createCommon = (copyCurrent: boolean) => {
    if (copyCurrent && commonDirty) {
      setMessage('当前 Common 有未保存草稿；请先保存或选择其他来源。')
      return
    }
    requestText(
      copyCurrent ? '复制 Common 名称' : '新 Common 名称',
      copyCurrent ? `${currentCommon?.name ?? ''} 副本` : '新 Common',
      copyCurrent ? '复制配置' : '创建配置',
      name => {
        void act('Common 已创建并切换。', async () => {
          const source = copyCurrent ? selection : { ...selection, common: currentGalaxy!.defaultCommon }
          const id = await api.createCommon(source, name)
          await refresh()
          setCurrentSelection({ ...selection, common: id })
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
          setCurrentSelection({ ...selection, common: galaxy?.defaultCommon ?? galaxy?.commons[0]?.id ?? '' })
        })
      },
      true,
    )
  }
  const start = async () => {
    if (taskRunning) {
      setMessage('已有单节点搜索正在运行。')
      return
    }
    if (!searchConfig) {
      setMessage('搜索配置尚未加载，无法启动。')
      return
    }
    setLogs('')
    setGalaxyDetail(null)
    setMessage(`正在准备 ${selection.galaxy.toUpperCase()} / ${selection.node} 搜索任务…`)
    setElapsedSeconds(0)
    localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(selection))
    try {
      const result = await api.run({
        ...selection,
        versionName: currentVersion?.name ?? selection.version,
        commonName: currentCommon?.name ?? selection.common,
        search: searchConfig,
      })
      if (!result.task) throw new Error('Main 未返回搜索任务快照。')
      setSearchTask(current => ({
        snapshot: result.task!,
        status: result.error ? 'failed' : 'completed',
        logs: current?.snapshot.taskId === result.task!.taskId ? current.logs : '',
        result: result.result,
        exitCode: result.exitCode,
        finishedAt: result.finishedAt,
        error: result.error,
      }))
      const confirmed = format(result.task.search)
      setSearchConfig(result.task.search)
      setSearchConfigSource(confirmed)
      setSavedSearchConfigSource(confirmed)
      setConfigSources(current => ({ ...current, search: 'local' }))
      setMessage(result.error ? `搜索失败：${result.error}` : '搜索完成，Best Found 已绑定到本次任务。')
    } catch (error) {
      setSearchTask(current =>
        current?.status === 'running' ? { ...current, status: 'failed', error: (error as Error).message } : current,
      )
      setMessage(`搜索失败：${(error as Error).message}`)
    }
  }
  const useBest = () => {
    if (!searchTask?.result?.best_result || searchTask.status !== 'completed') return
    const task = searchTask.snapshot
    const targetKey = nodeDomainKey(task)
    const targetDirty = isDirty(nodeDrafts.current.get(targetKey)) || isDirty(searchDrafts.current.get(targetKey))
    if (targetDirty) {
      setMessage(`目标 ${task.node} / ${task.versionName} 存在未保存草稿，未应用 Best Found。`)
      return
    }
    requestConfirm(
      '使用最优配置？',
      `Best Found 将应用到 ${task.galaxy.toUpperCase()} / ${task.node} / ${task.versionName}，不会使用当前浏览选择。`,
      '使用最优配置',
      () => {
        void act(`Best Found 已写入 ${task.node} / ${task.versionName}。`, async () => {
          const result = await api.useBest(task.taskId)
          if (result.error || !result.node) throw new Error(result.error ?? 'Copy 未返回有效 Node。')
          const source = format(result.node)
          const draft = { value: result.node, source, savedSource: source }
          nodeDrafts.current.set(targetKey, draft)
          searchDrafts.current.set(targetKey, draft)
          if (nodeDomainKey(selection) === targetKey) {
            setNode(result.node)
            setNodeSource(source)
            setSavedNodeSource(source)
          }
        })
      },
    )
  }
  const rerunCurrentGalaxy = () =>
    act('', async () => {
      if (taskRunning) throw new Error('单节点搜索运行期间不能启动 Galaxy 重跑。')
      setLogs('')
      setGalaxyDetail(null)
      setMessage(`${selection.galaxy.toUpperCase()} 正在串行重跑…`)
      const result = await api.rerunGalaxy(selection.galaxy)
      setGalaxyRerun(result)
      const failed = result.nodes.filter(item => item.status === 'failed').length
      const changed = result.nodes.filter(item => item.changed).length
      setMessage(`Galaxy 重跑完成：发现 ${changed} 个配置变化，${failed} 个节点失败。`)
    })
  const openGalaxyResult = (item: GalaxyRerunNode) => {
    cacheCurrentDraft()
    setMessage('')
    setGalaxyDetail(item)
    const next = { galaxy: galaxyRerun!.galaxy, node: item.node, version: item.version, common: item.common }
    const contexts = pageContextsRef.current
    if (contexts) {
      const updated = { ...contexts, search: next }
      pageContextsRef.current = updated
      setPageContexts(updated)
    }
    setWorkspace('search')
    setSelection(next)
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
      const initial = chooseInitial(next)
      const contexts = initialContexts(next, null)
      pageContextsRef.current = contexts
      setPageContexts(contexts)
      setSelection(initial)
      setMessage('已导入 map 配置到 Manager；没有覆盖既有 Manager 数据。')
    } catch (error) {
      setMessage(`导入失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const saveTemplate = () => {
    if (!requireNodeSaved(selection, false)) return
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
    if (createMode === 'selection' && !requireNodeSaved(selection, false)) return
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
      setCurrentSelection({ galaxy, node: created.node, version: created.version, common: targetGalaxy.defaultCommon })
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
    const source = format(next)
    setNode(next)
    setNodeSource(source)
    const cache = workspace === 'search' ? searchDrafts.current : nodeDrafts.current
    cache.set(nodeDomainKey(selection), { value: next, source, savedSource: savedNodeSource })
  }
  const pageCopy: Record<Workspace, { title: string; description: string }> = {
    node: { title: '节点配置', description: '维护 Boss、环境、阵型与舰种装配' },
    common: { title: '公共配置', description: '管理 Galaxy 公共和全局 Optimizer 配置' },
    search: { title: '搜索', description: '选择目标，运行 Optimizer，并按 Best Found 配置舰队' },
    rerun: { title: 'Galaxy 重跑', description: '串行检查当前 Galaxy 的默认配置' },
    templates: { title: '模板与复制', description: '从稳定配置快速创建 Node' },
  }
  const optimizerGlobalContext = workspace === 'common' && commonTab === 'optimizer'
  const showNodeContext = workspace === 'node' || workspace === 'search' || workspace === 'templates'
  const showCommonContext = showNodeContext || (workspace === 'common' && commonTab === 'galaxy')
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
          <button className={workspace === 'node' ? 'active' : ''} onClick={() => switchWorkspace('node')}>
            <Icon name="node" />
            节点配置{[...nodeDrafts.current.values()].some(isDirty) ? <span className="dirty-dot">•</span> : null}
          </button>
          <button className={workspace === 'common' ? 'active' : ''} onClick={() => switchWorkspace('common')}>
            <Icon name="settings" />
            公共配置
            {[...commonDrafts.current.values()].some(isDirty) || optimizerDirty ? (
              <span className="dirty-dot">•</span>
            ) : null}
          </button>
          <button className={workspace === 'search' ? 'active' : ''} onClick={() => switchWorkspace('search')}>
            <Icon name="search" />
            搜索{searchDirty ? <span className="dirty-dot">•</span> : null}
          </button>
          <button className={workspace === 'rerun' ? 'active' : ''} onClick={() => switchWorkspace('rerun')}>
            <Icon name="play" />
            Galaxy 重跑
          </button>
          <button className={workspace === 'templates' ? 'active' : ''} onClick={() => switchWorkspace('templates')}>
            <Icon name="copy" />
            模板与复制
          </button>
        </nav>
        {searchTask ? (
          <button className="task-chip" onClick={() => switchWorkspace('search')}>
            <span className={`run-dot ${searchTask.status === 'running' ? 'running' : searchTask.status}`} />
            <span>
              <strong>
                {searchTask.snapshot.node}{' '}
                {searchTask.status === 'running' ? '搜索中' : searchTask.status === 'completed' ? '已完成' : '失败'}
              </strong>
              <small>
                {formatDuration(searchTask.status === 'running' ? elapsedSeconds : taskDuration(searchTask))}
              </small>
            </span>
          </button>
        ) : null}
        <div className="runtime-note">
          <span className={`runtime-dot ${api.runtime ?? 'desktop'}`} />
          {api.runtime === 'web' ? 'Web 工作区' : '桌面工作区'}
        </div>
      </aside>
      <header className="topbar">
        <div>
          <h1>{pageCopy[workspace].title}</h1>
          <span>{pageCopy[workspace].description}</span>
        </div>
        <div className="actions">
          {workspace === 'node' ? (
            <button className="primary" onClick={() => void saveNode()} disabled={busy || !nodeDirty || nodeReadOnly}>
              保存节点
            </button>
          ) : null}
          {workspace === 'common' ? (
            commonTab === 'galaxy' ? (
              <button
                className="primary"
                onClick={() => void saveCommon()}
                disabled={busy || !commonDirty || commonReadOnly}
              >
                保存 Galaxy 公共
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => void saveOptimizerConfig()}
                disabled={busy || !optimizerDirty || optimizerReadOnly}
              >
                保存 Optimizer 公共
              </button>
            )
          ) : null}
          {workspace === 'rerun' ? (
            <button className="primary" onClick={() => void rerunCurrentGalaxy()} disabled={busy || taskRunning}>
              {busy ? '重跑中…' : `重跑 ${selection.galaxy.toUpperCase()}`}
            </button>
          ) : null}
        </div>
      </header>
      <section className="contextbar" aria-label="当前配置上下文">
        {optimizerGlobalContext ? (
          <div className="global-context">
            <span>作用范围</span>
            <strong>全局 / 所有 Galaxy</strong>
          </div>
        ) : (
          <Label text="Galaxy">
            <select value={selection.galaxy} onChange={e => update('galaxy', e.target.value)}>
              {catalog.galaxies.map(g => (
                <option key={g.id} value={g.id}>
                  {g.id.toUpperCase()}
                </option>
              ))}
            </select>
          </Label>
        )}
        {showNodeContext ? (
          <Label text="节点">
            <select value={selection.node} onChange={e => update('node', e.target.value)}>
              {currentGalaxy?.nodes.map(n => (
                <option key={n.id} value={n.id}>
                  {n.id}
                </option>
              ))}
            </select>
          </Label>
        ) : null}
        {showNodeContext ? (
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
              resetKey={`${workspace}/${selection.galaxy}/${selection.node}`}
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
              disabled={busy || nodeReadOnly}
            />
          </Label>
        ) : null}
        {showCommonContext ? (
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
              resetKey={`${workspace}/${selection.galaxy}/${selection.node}`}
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
              disabled={busy || commonReadOnly}
            />
          </Label>
        ) : null}
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
            <button className="primary" onClick={() => void rerunCurrentGalaxy()} disabled={busy || taskRunning}>
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
      {workspace === 'common' ? (
        <section className="panel public-config workspace-view">
          <div className="panel-heading">
            <div>
              <h2>公共配置</h2>
              <p>Galaxy 公共按 Galaxy 独立保存；Optimizer 公共直接管理跨 Galaxy 的 daily 配置。</p>
            </div>
          </div>
          <div className="tabs" role="tablist" aria-label="公共配置区域">
            <button
              role="tab"
              aria-selected={commonTab === 'galaxy'}
              className={commonTab === 'galaxy' ? 'active' : ''}
              onClick={() => setCommonTab('galaxy')}
            >
              Galaxy 公共
            </button>
            <button
              role="tab"
              aria-selected={commonTab === 'optimizer'}
              className={commonTab === 'optimizer' ? 'active' : ''}
              onClick={() => setCommonTab('optimizer')}
            >
              Optimizer 公共
            </button>
          </div>
          {commonTab === 'galaxy' && commonReadOnly && searchTask ? (
            <LockedNotice node={searchTask.snapshot.node} label="该 Galaxy Common" />
          ) : null}
          {commonTab === 'optimizer' && optimizerReadOnly && searchTask ? (
            <LockedNotice node={searchTask.snapshot.node} label="Optimizer 公共配置" />
          ) : null}
          <fieldset className="editor-lock" disabled={commonTab === 'galaxy' ? commonReadOnly : optimizerReadOnly}>
            {common && commonTab === 'galaxy' ? (
              <CommonEditor
                config={common}
                onChange={next => {
                  setCommon(next)
                  setCommonSource(format(next))
                }}
              />
            ) : null}
            {optimizerConfig && commonTab === 'optimizer' ? (
              <OptimizerConfigEditor
                config={optimizerConfig}
                source={configSources.optimizer}
                onChange={next => {
                  setOptimizerConfig(next)
                  setOptimizerSource(format(next))
                }}
              />
            ) : null}
            <details className="advanced">
              <summary>高级：原始 JSON</summary>
              <div className="advanced-grid">
                {commonTab === 'galaxy' ? (
                  <Label text="Common JSON">
                    <textarea
                      value={commonSource}
                      onChange={event => setCommonSource(event.target.value)}
                      spellCheck={false}
                      aria-label="Common JSON 编辑器"
                    />
                  </Label>
                ) : (
                  <Label text="Optimizer JSON">
                    <textarea
                      value={optimizerSource}
                      onChange={event => setOptimizerSource(event.target.value)}
                      spellCheck={false}
                      aria-label="Optimizer JSON 编辑器"
                    />
                  </Label>
                )}
              </div>
            </details>
          </fieldset>
        </section>
      ) : null}
      {workspace === 'node' ? (
        <section className="workspace node-workspace workspace-view">
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
                  ['fleet', '舰队状态'],
                  ['loadout', '装配'],
                  ['environment', '环境'],
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
            {nodeReadOnly && searchTask ? (
              <LockedNotice node={searchTask.snapshot.node} label="该 Node Version" />
            ) : null}
            <fieldset className="editor-lock" disabled={nodeReadOnly}>
              {node && editorTab === 'formation' ? (
                <FormationEditor config={node} optimizer={optimizerConfig} onChange={tableChange} />
              ) : null}
              {node && editorTab === 'fleet' ? <FleetStateEditor config={node} onChange={tableChange} /> : null}
              {node && optimizerConfig && editorTab === 'loadout' ? (
                <LoadoutEditor config={node} optimizer={optimizerConfig} onChange={tableChange} />
              ) : null}
              {node && editorTab === 'environment' ? <EnvironmentEditor config={node} onChange={tableChange} /> : null}
              <details className="advanced">
                <summary>高级：原始 JSON</summary>
                <div>
                  <Label text="Node JSON">
                    <textarea
                      value={nodeSource}
                      onChange={e => setNodeSource(e.target.value)}
                      spellCheck={false}
                      aria-label="Node JSON 编辑器"
                    />
                  </Label>
                </div>
              </details>
            </fieldset>
          </section>
        </section>
      ) : null}
      {workspace === 'search' ? (
        <SearchWorkspace
          node={node}
          search={searchConfig}
          searchSource={configSources.search}
          commonName={currentCommon?.name ?? selection.common}
          versionName={currentVersion?.name ?? selection.version}
          selection={selection}
          busy={busy}
          dirty={searchDirty}
          readOnly={taskRunning}
          task={searchTask}
          elapsedSeconds={elapsedSeconds}
          activeRun={activeRun}
          changes={changes.length}
          onOpenSettings={() => setSearchSettingsOpen(true)}
          onStart={() => void start()}
          onUseBest={useBest}
        />
      ) : null}
      {searchSettingsOpen && searchConfig ? (
        <SearchSettingsDialog
          config={searchConfig}
          dirty={searchDirty}
          readOnly={taskRunning}
          source={configSources.search}
          onChange={next => {
            setSearchConfig(next)
            setSearchConfigSource(format(next))
          }}
          onClose={() => setSearchSettingsOpen(false)}
        />
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

function SearchSettingsDialog({
  config,
  dirty,
  readOnly,
  source,
  onChange,
  onClose,
}: {
  config: SearchConfig
  dirty: boolean
  readOnly: boolean
  source: ConfigSource
  onChange: (value: SearchConfig) => void
  onClose: () => void
}) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={event => event.target === event.currentTarget && onClose()}
    >
      <section
        className="app-dialog search-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-settings-title"
      >
        <div className="dialog-heading">
          <div>
            <h2 id="search-settings-title">搜索设置</h2>
            <p>低频执行偏好；下次点击“开始搜索”时自动保存并重新读取确认。</p>
          </div>
          <span className="config-source">{source === 'local' ? 'map 本机配置' : 'poc 默认值'}</span>
        </div>
        {readOnly ? <p className="lock-notice">当前任务正在使用这份配置，任务结束后可编辑。</p> : null}
        <fieldset className="editor-lock" disabled={readOnly}>
          <SearchSettings config={config} onChange={onChange} />
        </fieldset>
        <div className="dialog-actions search-dialog-actions">
          <small>{dirty ? '修改已保留，将在启动搜索时自动保存。' : '当前配置已持久化。'}</small>
          <button className="primary" onClick={onClose}>
            完成
          </button>
        </div>
      </section>
    </div>
  )
}

function FleetStateEditor({ config, onChange }: { config: NodeConfig; onChange: (value: NodeConfig) => void }) {
  const knownOrder: string[] = SHIP_TYPES.map(ship => ship.id)
  const ships = [...new Set([...knownOrder, ...Object.keys(config.player_state.ships)])].sort((a, b) => {
    const left = knownOrder.indexOf(shipSelectorToId(a) || a)
    const right = knownOrder.indexOf(shipSelectorToId(b) || b)
    return (left < 0 ? 999 : left) - (right < 0 ? 999 : right) || a.localeCompare(b)
  })
  const updateResources = (value: string) =>
    onChange({ ...config, player_state: { ...config.player_state, fleet_resources: Number(value) } })
  const updateShip = (ship: string, value: string) =>
    onChange({
      ...config,
      player_state: {
        ...config.player_state,
        ships: { ...config.player_state.ships, [ship]: Math.max(0, Math.trunc(Number(value))) },
      },
    })
  return (
    <section className="config-section fleet-state-editor">
      <div className="section-heading">
        <div>
          <h3>舰队状态</h3>
          <p>当前可用 Fleet Resources 与已解锁舰种数量；阵型只能使用数量大于 0 的舰种。</p>
        </div>
      </div>
      <Label text="Fleet Resources">
        <input
          aria-label="Fleet Resources"
          type="number"
          min="0"
          step="0.01"
          value={config.player_state.fleet_resources}
          onChange={event => updateResources(event.target.value)}
        />
      </Label>
      <div className="fleet-ship-grid">
        {ships.map(ship => (
          <Label text={shipDisplayName(ship, false)} key={ship}>
            <input
              aria-label={`ships.${ship}`}
              type="number"
              min="0"
              step="1"
              value={config.player_state.ships[ship] ?? 0}
              onChange={event => updateShip(ship, event.target.value)}
            />
          </Label>
        ))}
      </div>
    </section>
  )
}

function EnvironmentEditor({ config, onChange }: { config: NodeConfig; onChange: (value: NodeConfig) => void }) {
  const boss = (config.boss ?? {}) as Record<string, unknown>
  const alive = Boolean(boss.alive)
  const updateBoss = (field: string, value: unknown) => onChange({ ...config, boss: { ...boss, [field]: value } })
  const updateNodes = (field: 'hazards' | 'supports', value: string) =>
    onChange({
      ...config,
      [field]: value
        .split(/[\n,，]+/)
        .map(item => item.trim().toUpperCase())
        .filter(Boolean),
    })
  return (
    <section className="config-section node-basics">
      <div className="section-heading">
        <div>
          <h3>战斗与环境</h3>
          <p>填写游戏中的节点名；Resolver 会校验它们是否真实影响当前战斗。</p>
        </div>
      </div>
      <fieldset className="boss-config">
        <legend>Boss</legend>
        <label className="switch-field">
          <input type="checkbox" checked={alive} onChange={event => updateBoss('alive', event.target.checked)} />
          <span>Boss 存活</span>
        </label>
        <Label text="剩余生命 remaining_hp">
          <input
            aria-label="Boss 剩余生命"
            type="number"
            min="0"
            disabled={!alive}
            value={Number(boss.remaining_hp ?? 0)}
            onChange={event => updateBoss('remaining_hp', Number(event.target.value))}
          />
        </Label>
        <Label text="Boss 搜索优先级">
          <select
            aria-label="Boss 搜索优先级"
            disabled={!alive}
            value={String(boss.priority ?? 'efficiency')}
            onChange={event => updateBoss('priority', event.target.value)}
          >
            <option value="efficiency">效率（efficiency）</option>
            <option value="kill_cost">击杀总成本（kill_cost）</option>
          </select>
        </Label>
      </fieldset>
      <div className="environment-config">
        <Label text="Hazards（每行或逗号分隔）">
          <textarea
            aria-label="Hazards"
            value={config.hazards.map(String).join('\n')}
            onChange={event => updateNodes('hazards', event.target.value)}
            placeholder="例如 B10"
          />
        </Label>
        <Label text="Supports（每行或逗号分隔）">
          <textarea
            aria-label="Supports"
            value={config.supports.map(String).join('\n')}
            onChange={event => updateNodes('supports', event.target.value)}
            placeholder="例如 F2"
          />
        </Label>
      </div>
    </section>
  )
}

function SearchWorkspace({
  node,
  search,
  searchSource,
  commonName,
  versionName,
  selection,
  busy,
  dirty,
  readOnly,
  task,
  elapsedSeconds,
  activeRun,
  changes,
  onOpenSettings,
  onStart,
  onUseBest,
}: {
  node: NodeConfig | null
  search: SearchConfig | null
  searchSource: ConfigSource
  commonName: string
  versionName: string
  selection: Selection
  busy: boolean
  dirty: boolean
  readOnly: boolean
  task: SearchTaskState | null
  elapsedSeconds: number
  activeRun: RunResult | null | undefined
  changes: number
  onOpenSettings: () => void
  onStart: () => void
  onUseBest: () => void
}) {
  const running = task?.status === 'running'
  const taskLogs = task?.logs ?? ''
  const runSeconds = running
    ? elapsedSeconds
    : activeRun
      ? Math.max(0, Math.round((Date.parse(activeRun.finishedAt) - Date.parse(activeRun.startedAt)) / 1000))
      : elapsedSeconds
  const progress = taskLogs
    .split(/\r?\n/)
    .reverse()
    .find(line => /(\d+\/\d+|Evaluated:|Best updated|Final|Initializing|完成)/i.test(line))
  const snapshot = task?.snapshot
  const target = snapshot ?? {
    galaxy: selection.galaxy,
    node: selection.node,
    versionName,
    commonName,
  }
  const environment = snapshot?.environment ?? {
    boss: node?.boss,
    hazards: node?.hazards ?? [],
    supports: node?.supports ?? [],
  }
  const boss = (environment.boss ?? {}) as Record<string, unknown>
  const bossAlive = Boolean(boss.alive)
  const profile = search?.profile === 'fast' ? '快速' : search?.profile === 'balanced' ? '均衡' : '穷举'
  return (
    <section className="search-workspace workspace-view">
      <div className="search-context panel" aria-label="搜索目标与战斗环境">
        <strong className="context-title">{snapshot ? '任务快照' : '搜索目标'}</strong>
        <div>
          <span>Galaxy</span>
          <strong>{target.galaxy.toUpperCase()}</strong>
        </div>
        <div>
          <span>Node</span>
          <strong>{target.node}</strong>
        </div>
        <div>
          <span>Version</span>
          <strong>{target.versionName}</strong>
        </div>
        <div>
          <span>Common</span>
          <strong>{target.commonName}</strong>
        </div>
        <div className="environment-summary">
          <span>Boss</span>
          <strong>{bossAlive ? '存在' : '无'}</strong>
          {bossAlive ? (
            <small>
              HP {String(boss.remaining_hp ?? '—')} · {String(boss.priority ?? 'efficiency')}
            </small>
          ) : null}
        </div>
        <div>
          <span>Hazards</span>
          <strong title={environment.hazards.join(', ')}>
            {environment.hazards.length ? environment.hazards.join(', ') : '无'}
          </strong>
        </div>
        <div>
          <span>Supports</span>
          <strong title={environment.supports.join(', ')}>
            {environment.supports.length ? environment.supports.join(', ') : '无'}
          </strong>
        </div>
      </div>
      <section className="panel search-command">
        <button className="primary start-search" onClick={onStart} disabled={busy || running || !search}>
          <Icon name="play" />
          {running ? `${task.snapshot.node} 搜索中…` : '开始搜索'}
        </button>
        <p className="search-summary">
          <strong>{profile}</strong>
          <span>{search?.goal ?? '—'}</span>
          <span>{search?.max_simulations ?? '—'} 次</span>
          <span>{search?.max_wall_seconds ?? '—'} 秒</span>
          <span>{search?.workers ?? '—'} Workers</span>
          {dirty ? <em>待自动保存</em> : <small>{searchSource === 'local' ? '本机配置' : 'poc 默认'}</small>}
        </p>
        <button className="search-settings-button" onClick={onOpenSettings} disabled={readOnly}>
          <Icon name="settings" />
          搜索设置
        </button>
      </section>
      <section className="panel run-status">
        <div className="panel-heading compact">
          <div>
            <h2>运行状态</h2>
            <p>
              {progress?.trim() || (running ? '正在准备 Optimizer…' : activeRun ? '任务已结束。' : '尚未启动任务。')}
            </p>
          </div>
          <span className={`run-dot ${running ? 'running' : (task?.status ?? (activeRun ? 'completed' : ''))}`} />
        </div>
        <dl>
          <dt>状态</dt>
          <dd>{running ? '搜索中' : activeRun ? (activeRun.error ? '失败' : '已完成') : '空闲'}</dd>
          <dt>时间</dt>
          <dd>{runSeconds}s</dd>
          <dt>进度</dt>
          <dd>{running ? progress?.trim() || '准备中' : activeRun ? '完成' : '—'}</dd>
          <dt>Workers</dt>
          <dd>{snapshot?.search.workers ?? search?.workers ?? '—'}</dd>
        </dl>
        <details className="console">
          <summary>Optimizer 输出 / 日志</summary>
          <pre className="logs">{taskLogs || (running ? '等待 Optimizer 输出…' : '尚未启动任务。')}</pre>
        </details>
      </section>
      <section className="panel best-found-panel">
        {activeRun?.result?.best_result ? (
          <BestFound
            result={activeRun.result}
            changes={changes}
            busy={busy || running}
            target={task?.snapshot}
            onUseBest={onUseBest}
          />
        ) : (
          <div className="result-empty">
            <span aria-hidden="true">◎</span>
            <strong>还没有搜索结果</strong>
            <p>{activeRun?.error ?? '搜索完成后，Best Found 会直接显示在这里。'}</p>
          </div>
        )}
      </section>
    </section>
  )
}

function BestFound({
  result,
  changes,
  busy,
  target,
  onUseBest,
}: {
  result: NonNullable<RunResult['result']>
  changes: number
  busy: boolean
  target?: SearchTaskState['snapshot']
  onUseBest: () => void
}) {
  const best = result.best_result!
  const baseline = result.verified_baseline
  const improvement = (result.improvement_vs_baseline ?? {}) as Record<string, unknown>
  const saved =
    typeof baseline?.fleet_resources_used === 'number' && typeof best.fleet_resources_used === 'number'
      ? baseline.fleet_resources_used - best.fleet_resources_used
      : null
  const positions = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5']
  const byPosition = new Map(best.formation.map(entry => [entry.position, entry]))
  const loadouts = new Map<string, { primary?: unknown; secondary?: unknown; tertiary?: unknown }>()
  for (const [ship, value] of Object.entries(best.ship_loadouts ?? {})) {
    loadouts.set(shipSelectorToId(ship) || ship, {
      primary: value.primary,
      secondary: value.secondary,
      tertiary: value.tertiary_mods ?? value.tertiary,
    })
  }
  for (const entry of best.formation) {
    const ship = shipSelectorToId(entry.ship) || String(entry.ship)
    if (!loadouts.has(ship))
      loadouts.set(ship, {
        primary: entry.primary_mod,
        secondary: entry.secondary_mod,
        tertiary: entry.tertiary_mods,
      })
  }
  const orderedLoadouts = [...loadouts.entries()].sort(
    ([a], [b]) => SHIP_TYPES.findIndex(ship => ship.id === a) - SHIP_TYPES.findIndex(ship => ship.id === b),
  )
  const modText = (value: unknown) =>
    value === null || value === undefined || value === '' ? '无' : modDisplayName(String(value))
  return (
    <div className="best-found">
      <div className="best-found-heading">
        <div>
          <h2>Best Found</h2>
          <p>{changes ? `相对当前配置有 ${changes} 项阵型或装配变化。` : 'Best Found 与当前配置一致。'}</p>
        </div>
        <button className="success use-best" onClick={onUseBest} disabled={busy || changes === 0}>
          <Icon name="check" />
          使用最优配置
        </button>
      </div>
      {target ? (
        <p className="apply-target">
          应用到：{target.galaxy.toUpperCase()} / {target.node} / {target.versionName}
        </p>
      ) : null}
      <dl className="result-metrics">
        <div>
          <dt>Outcome</dt>
          <dd>{best.outcome ?? '—'}</dd>
        </div>
        <div>
          <dt>Committed FR</dt>
          <dd>{best.fleet_resources_committed ?? '—'}</dd>
        </div>
        <div>
          <dt>Used FR</dt>
          <dd>{best.fleet_resources_used ?? '—'}</dd>
        </div>
        {typeof best.boss_damage === 'number' && best.boss_damage > 0 ? (
          <div>
            <dt>Boss Damage</dt>
            <dd>{best.boss_damage}</dd>
          </div>
        ) : null}
        {saved !== null && saved > 0 ? (
          <div>
            <dt>节省 FR</dt>
            <dd>{saved.toFixed(2)}</dd>
          </div>
        ) : null}
        {typeof improvement.percent === 'number' ? (
          <div>
            <dt>改善</dt>
            <dd>{improvement.percent.toFixed(2)}%</dd>
          </div>
        ) : null}
      </dl>
      <div className="best-grid">
        <section>
          <h3>最终编队</h3>
          <div className="best-formation">
            {(['A', 'B'] as const).map(row => (
              <div className="formation-row" key={row}>
                <strong className="formation-row-label">{row}</strong>
                <div className="formation-row-cells">
                  {positions
                    .filter(position => position.startsWith(row))
                    .map(position => {
                      const entry = byPosition.get(position)
                      const ship = entry ? shipSelectorToId(entry.ship) : null
                      return (
                        <div
                          className={`formation-cell ${ship ? `ship-${ship.toLowerCase()}` : 'ship-empty'}`}
                          key={position}
                        >
                          <b>{position}</b>
                          <span>{entry ? shipDisplayName(entry.ship) : '空位'}</span>
                        </div>
                      )
                    })}
                </div>
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3>舰船最终配置</h3>
          <div className="best-loadouts">
            {orderedLoadouts.map(([ship, loadout]) => (
              <div className={`ship-${ship.toLowerCase()}`} key={ship}>
                <strong>{shipDisplayName(ship)}</strong>
                <dl>
                  <dt>Primary</dt>
                  <dd>{modText(loadout.primary)}</dd>
                  <dt>Secondary</dt>
                  <dd>{modText(loadout.secondary)}</dd>
                  {Array.isArray(loadout.tertiary) && loadout.tertiary.length ? (
                    <>
                      <dt>Tertiary</dt>
                      <dd>{loadout.tertiary.map(modText).join('、')}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ))}
          </div>
        </section>
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

function LockedNotice({ node, label }: { node: string; label: string }) {
  return (
    <p className="lock-notice" role="status">
      {label}正在被 {node} 搜索任务使用，任务结束后可编辑。
    </p>
  )
}

function Icon({ name }: { name: 'node' | 'play' | 'copy' | 'check' | 'settings' | 'search' }) {
  const paths = {
    node: <path d="M5 5h14v14H5zM9 9h6v6H9z" />,
    play: <path d="m8 5 11 7-11 7z" />,
    copy: <path d="M9 9h10v10H9zM5 5h10v2H7v8H5z" />,
    check: <path d="m5 12 4 4L19 6" />,
    settings: <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M8 14v6" />,
    search: <path d="m20 20-4.5-4.5M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />,
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
  resetKey,
}: {
  label: string
  actions: Array<{ label: string; onClick: () => void; disabled?: boolean; danger?: boolean }>
  disabled?: boolean
  resetKey: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => setOpen(false), [resetKey])
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])
  return (
    <div className="action-menu" ref={root}>
      <button
        type="button"
        className="action-menu-trigger"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open ? (
        <div className="action-menu-popover" role="menu">
          {actions.map(action => (
            <button
              key={action.label}
              className={action.danger ? 'danger' : ''}
              disabled={disabled || action.disabled}
              onClick={() => {
                action.onClick()
                setOpen(false)
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function FormationEditor({
  config,
  optimizer,
  onChange,
}: {
  config: NodeConfig
  optimizer: OptimizerConfig | null
  onChange: (n: NodeConfig) => void
}) {
  const slots = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5']
  const available = new Set(Object.keys(config.player_state.ships).map(ship => shipSelectorToId(ship) || ship))
  const searchable = new Set(optimizer?.ship_types ?? SHIP_TYPES.map(item => item.id))
  const selected = new Set(Object.values(config.baseline.formation).map(shipSelectorToId))
  const options = SHIP_TYPES.filter(
    item => (available.has(item.id) && searchable.has(item.id)) || selected.has(item.id),
  )
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

function LoadoutEditor({
  config,
  optimizer,
  onChange,
}: {
  config: NodeConfig
  optimizer: OptimizerConfig
  onChange: (n: NodeConfig) => void
}) {
  const ships = Array.from(new Set([...optimizer.ship_types, ...Object.keys(config.baseline.loadouts)]))
  const load = (ship: string, field: 'primary' | 'secondary', value: string | null) => {
    const old = config.baseline.loadouts[ship] ?? {}
    const oldValue = old[field]
    const canonicalShip = shipSelectorToId(ship) || ship
    const options = slotOptions(optimizer, canonicalShip, field)
    const nextValue = preserveModSelectorFormat(oldValue, value, options)
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
            {ships.map(ship => {
              const l = config.baseline.loadouts[ship] ?? {}
              const canonicalShip = shipSelectorToId(ship) || ship
              return (
                <tr key={ship}>
                  <td>
                    <strong>{shipDisplayName(ship, false)}</strong>
                    <small>{ship}</small>
                  </td>
                  <td>
                    <ModSlotControl
                      ship={canonicalShip}
                      slot="primary"
                      value={l.primary}
                      options={slotOptions(optimizer, canonicalShip, 'primary')}
                      onChange={value => load(ship, 'primary', value)}
                    />
                  </td>
                  <td>
                    <ModSlotControl
                      ship={canonicalShip}
                      slot="secondary"
                      value={l.secondary}
                      options={slotOptions(optimizer, canonicalShip, 'secondary')}
                      onChange={value => load(ship, 'secondary', value)}
                    />
                  </td>
                  <td>
                    <span className="slot-unavailable" title="Standard Galaxy 的 Tertiary 由原版 Fleet 作用域自动附加">
                      自动 / 无手选槽位
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ModSlotControl({
  ship,
  slot,
  value,
  options,
  onChange,
}: {
  ship: string
  slot: ModSlot
  value: unknown
  options: Array<string | null>
  onChange: (value: string | null) => void
}) {
  const concrete = Array.from(new Set(options.filter((option): option is string => typeof option === 'string')))
  const allowsNone = options.includes(null)
  const resolved = resolveModSelector(value, options)
  const label = `${ship} ${slot}`
  if (concrete.length === 0) return <span className="slot-unavailable">不可用</span>
  if (concrete.length === 1) {
    const id = concrete[0]
    if (!allowsNone) return <span title={id}>{modDisplayName(id)}（必选）</span>
    return (
      <label className="mod-toggle">
        <input
          type="checkbox"
          aria-label={`${label} ${modDisplayName(id)}`}
          checked={resolved === id}
          onChange={event => onChange(event.target.checked ? id : null)}
        />
        <span>{modDisplayName(id)}</span>
      </label>
    )
  }
  return (
    <select aria-label={label} value={resolved ?? ''} onChange={event => onChange(event.target.value || null)}>
      {allowsNone ? <option value="">无</option> : null}
      {concrete.map(id => (
        <option key={id} value={id}>
          {modDisplayName(id, true)}
        </option>
      ))}
      {resolved && !concrete.includes(resolved) ? <option value={resolved}>不兼容：{resolved}</option> : null}
    </select>
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

function OptimizerConfigEditor({
  config,
  source,
  onChange,
}: {
  config: OptimizerConfig
  source: ConfigSource
  onChange: (value: OptimizerConfig) => void
}) {
  const updateNumber = (field: keyof OptimizerConfig, value: string) => onChange({ ...config, [field]: Number(value) })
  const setShipEnabled = (ship: string, enabled: boolean) => {
    const shipTypes = enabled ? [...config.ship_types, ship] : config.ship_types.filter(item => item !== ship)
    onChange({ ...config, ship_types: Array.from(new Set(shipTypes)) })
  }
  const setRange = (ship: string, field: 'min' | 'max', value: string) =>
    onChange({
      ...config,
      group_ranges: {
        ...config.group_ranges,
        [ship]: { ...(config.group_ranges[ship] ?? { min: 0, max: 0 }), [field]: Number(value) },
      },
    })
  const setShipMaximum = (ship: string, value: string) =>
    onChange({
      ...config,
      max_groups_per_ship: { ...config.max_groups_per_ship, [ship]: Number(value) },
    })
  const setAllowed = (ship: string, slot: 'primary' | 'secondary', option: string | null, enabled: boolean) => {
    const slots = config.allowed_mod_slots[ship] ?? { primary: [null], secondary: [null] }
    const current = slotOptions(config, ship, slot)
    const next = enabled ? [...current, option] : current.filter(item => item !== option)
    const normalized = Array.from(new Set(next)).sort((a, b) => (a === null ? -1 : b === null ? 1 : 0))
    if (normalized.length === 0) return
    onChange({
      ...config,
      allowed_mod_slots: {
        ...config.allowed_mod_slots,
        [ship]: { ...slots, [slot]: normalized },
      },
    })
  }
  return (
    <section className="config-section optimizer-config-form">
      <div className="section-heading">
        <div>
          <h3>Optimizer 公共配置</h3>
          <p>跨 Galaxy 的搜索空间与精炼规则。Node 搜索页覆盖 objective、时钟、workers 和日常总预算。</p>
        </div>
        <span className="format-hint">
          {source === 'local' ? 'map/optimizer_v2_daily.json' : 'poc/optimizer_v2_daily.json（默认）'}
        </span>
      </div>
      <p className="source-note">
        本机 map 配置存在时优先，否则读取 poc 默认值。objective 与总预算仍保留为非 Friendly Config 回退； Manager
        任务会用 Boss 与独立 Search 配置覆盖它们。
      </p>
      <div className="optimizer-groups">
        <fieldset>
          <legend>部署与搜索空间</legend>
          <Label text="部署模式 mode">
            <select value={config.mode} onChange={event => onChange({ ...config, mode: event.target.value })}>
              <option value="realistic">真实部署（realistic）</option>
              <option value="practice">练习（practice）</option>
            </select>
          </Label>
          <Label text="舰队总组数上限">
            <input
              type="number"
              min="1"
              value={config.max_total_groups}
              onChange={event => updateNumber('max_total_groups', event.target.value)}
            />
          </Label>
        </fieldset>
        <fieldset>
          <legend>结果与 Boss 精炼</legend>
          {(
            [
              ['top_n', '保留 Top N'],
              ['kill_refine_top_n', '击杀精炼 Top N'],
              ['kill_sequence_max_battles', '连续击杀最大场数'],
            ] as const
          ).map(([field, label]) => (
            <Label text={label} key={field}>
              <input
                type="number"
                min="1"
                value={Number(config[field])}
                onChange={event => updateNumber(field, event.target.value)}
              />
            </Label>
          ))}
        </fieldset>
      </div>
      <div className="table-scroll">
        <table className="optimizer-ship-table">
          <thead>
            <tr>
              <th>舰种</th>
              <th>参与搜索</th>
              <th>组数范围</th>
              <th>单舰种上限</th>
              <th>允许 Primary</th>
              <th>允许 Secondary</th>
              <th>Tertiary</th>
            </tr>
          </thead>
          <tbody>
            {SHIP_TYPES.map(ship => (
              <tr key={ship.id}>
                <td>
                  <strong>{ship.name}</strong>
                  <small>{ship.id}</small>
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${ship.id} 参与搜索`}
                    checked={config.ship_types.includes(ship.id)}
                    onChange={event => setShipEnabled(ship.id, event.target.checked)}
                  />
                </td>
                <td className="range-inputs">
                  <input
                    aria-label={`${ship.id} 最少组数`}
                    type="number"
                    min="0"
                    value={config.group_ranges[ship.id]?.min ?? 0}
                    onChange={event => setRange(ship.id, 'min', event.target.value)}
                  />
                  <span>–</span>
                  <input
                    aria-label={`${ship.id} 最多组数`}
                    type="number"
                    min="0"
                    value={config.group_ranges[ship.id]?.max ?? 0}
                    onChange={event => setRange(ship.id, 'max', event.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label={`${ship.id} 单舰种上限`}
                    type="number"
                    min="0"
                    value={config.max_groups_per_ship[ship.id] ?? 0}
                    onChange={event => setShipMaximum(ship.id, event.target.value)}
                  />
                </td>
                {(['primary', 'secondary'] as const).map(slot => {
                  const active = slotOptions(config, ship.id, slot)
                  const candidates = Array.from(
                    new Set([
                      ...catalogMods(ship.id, slot).map(mod => mod.id),
                      ...active.filter((item): item is string => typeof item === 'string'),
                    ]),
                  )
                  return (
                    <td key={slot} className="allowed-mods">
                      <label>
                        <input
                          type="checkbox"
                          checked={active.includes(null)}
                          onChange={event => setAllowed(ship.id, slot, null, event.target.checked)}
                        />
                        无
                      </label>
                      {candidates.map(id => (
                        <label key={id} title={id}>
                          <input
                            type="checkbox"
                            checked={active.includes(id)}
                            onChange={event => setAllowed(ship.id, slot, id, event.target.checked)}
                          />
                          {modDisplayName(id)}
                        </label>
                      ))}
                    </td>
                  )
                })}
                <td>
                  <span className="slot-unavailable">原版自动附加</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function SearchSettings({ config, onChange }: { config: SearchConfig; onChange: (value: SearchConfig) => void }) {
  const update = <K extends keyof SearchConfig>(field: K, value: SearchConfig[K]) =>
    onChange({ ...config, [field]: value })
  return (
    <div className="search-settings">
      <Label text="搜索档位">
        <select
          value={config.profile}
          onChange={event => update('profile', event.target.value as SearchConfig['profile'])}
        >
          <option value="fast">快速（fast）</option>
          <option value="balanced">均衡（balanced）</option>
          <option value="exhaustive">穷举（exhaustive）</option>
        </select>
      </Label>
      <Label text="Baseline 策略 goal">
        <select value={config.goal} onChange={event => update('goal', event.target.value as SearchConfig['goal'])}>
          <option value="best">寻找最佳（best）</option>
          <option value="beat_baseline">必须严格改善（beat_baseline）</option>
        </select>
      </Label>
      <Label text="模拟时钟">
        <select
          value={config.simulation_clock}
          onChange={event => update('simulation_clock', event.target.value as SearchConfig['simulation_clock'])}
        >
          <option value="offline_fixed_step">离线固定步长</option>
          <option value="realtime">实时</option>
        </select>
      </Label>
      <div className="numeric-settings">
        <Label text="本次最大模拟次数">
          <input
            type="number"
            min="1"
            value={config.max_simulations}
            onChange={event => update('max_simulations', Number(event.target.value))}
          />
        </Label>
        <Label text="Worker 数">
          <input
            type="number"
            min="1"
            max="4"
            value={config.workers}
            onChange={event => update('workers', Number(event.target.value))}
          />
        </Label>
      </div>
      <Label text="本次最长时间（秒）">
        <input
          type="number"
          min="1"
          value={config.max_wall_seconds}
          onChange={event => update('max_wall_seconds', Number(event.target.value))}
        />
      </Label>
    </div>
  )
}
