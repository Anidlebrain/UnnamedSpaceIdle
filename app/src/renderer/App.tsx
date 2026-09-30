import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  Catalog,
  ConfigSource,
  FleetManagerApi,
  GalaxyRerunNode,
  GalaxyRerunProgress,
  ImportPreview,
  OptimizerOutput,
  RunResult,
  SearchQueueItem,
  Selection,
} from '../shared/contracts'
import type { CommonConfig, NodeConfig, OptimizerConfig, SearchConfig } from '../shared/schemas'
import { FLEET_MANAGER_BRIDGE_NAME } from '../shared/bridge'
import { diffFormation, hasRerunChange, usedFrIntegerChange } from '../shared/formation-diff'
import {
  formationColumnLabels,
  formationColumns,
  FORMATION_ROWS,
  MAX_FORMATION_COLUMNS,
  resultFormationColumns,
  validFormationPosition,
} from '../shared/formation-grid'
import { effectiveShipCounts } from '../shared/ship-counts'
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
import { SmartSelect } from './SmartSelect'
import { runErrorSummary } from '../shared/run-errors'
import {
  commonDomainKey,
  chooseInitial,
  formatJson,
  initialContexts,
  restoreContexts,
  isDirty,
  nodeDomainKey,
  nodeLocked,
  commonLocked,
  taskFromSnapshot,
  taskFromQueue,
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
const LAST_LOCATION_KEY = 'fleet-manager-location-v1'
const RERUN_SELECTIONS_KEY = 'fleet-manager-rerun-selections-v1'
type RerunSelection = { known: string[]; selected: string[] }
type RerunSelections = Record<string, RerunSelection>
function storedRerunSelections(): RerunSelections {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RERUN_SELECTIONS_KEY) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(
      Object.entries(stored).filter((entry): entry is [string, RerunSelection] => {
        const value = entry[1] as Partial<RerunSelection> | null
        return Boolean(
          value &&
          Array.isArray(value.known) &&
          value.known.every(id => typeof id === 'string') &&
          Array.isArray(value.selected) &&
          value.selected.every(id => typeof id === 'string'),
        )
      }),
    )
  } catch {
    return {}
  }
}
function selectedRerunNodes(nodes: string[], saved?: RerunSelection): string[] {
  if (!saved) return nodes
  const current = new Set(nodes)
  const known = new Set(saved.known)
  return [
    ...new Set(saved.selected.filter(id => current.has(id))),
    ...nodes.filter(id => !known.has(id) && !saved.selected.includes(id)),
  ]
}
const formatDuration = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`
const profileName = (profile: SearchConfig['profile']) =>
  profile === 'fast' ? '日常搜索' : profile === 'balanced' ? '扩大探索' : '遍历搜索'
const strategyName = (strategy: SearchConfig['strategy']) =>
  strategy === 'advisor_seeded' ? '推荐舰队搜站位' : '常规优化'
const goalName = (goal: SearchConfig['goal']) => (goal === 'best' ? '寻找最佳方案' : '必须优于当前方案（v3 仅记录）')
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
  const [searchTask, setSearchTask] = useState<SearchTaskState | null>(null)
  const [searchQueue, setSearchQueue] = useState<SearchQueueItem[]>([])
  const [viewedTaskIds, setViewedTaskIds] = useState<Set<string>>(() => new Set())
  const [appliedTaskIds, setAppliedTaskIds] = useState<Set<string>>(() => new Set())
  const [rerunSelections, setRerunSelections] = useState<RerunSelections>(storedRerunSelections)
  const [galaxyRerun, setGalaxyRerun] = useState<GalaxyRerunProgress | null>(null)
  const [rerunStarting, setRerunStarting] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [galaxyDetail, setGalaxyDetail] = useState<GalaxyRerunNode | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [message, setMessage] = useState('')
  const [errorDetail, setErrorDetail] = useState('')
  const [busy, setBusy] = useState(false)
  const [template, setTemplate] = useState('')
  const [createMode, setCreateMode] = useState<'selection' | 'template'>('selection')
  const [newNode, setNewNode] = useState('')
  const [newGalaxy, setNewGalaxy] = useState('')
  const [newGalaxyNode, setNewGalaxyNode] = useState('B1')
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
  const nodeMatchesSelection = Boolean(
    node &&
    node.galaxy === Number(selection.galaxy.slice(1)) &&
    node.node.toLowerCase() === selection.node.replace(/_num$/i, '').toLowerCase(),
  )
  const nodeDirty = Boolean(node && nodeSource !== savedNodeSource)
  const commonDirty = Boolean(common && commonSource !== savedCommonSource)
  const optimizerDirty = Boolean(optimizerConfig && optimizerSource !== savedOptimizerSource)
  const searchDirty = Boolean(searchConfig && searchConfigSource !== savedSearchConfigSource)
  const dirty =
    workspace === 'node' || workspace === 'templates'
      ? nodeDirty
      : workspace === 'search'
        ? searchDirty
        : workspace === 'common'
          ? commonTab === 'galaxy'
            ? commonDirty
            : optimizerDirty
          : false
  const taskRunning = searchQueue.some(item => item.status === 'running') || searchTask?.status === 'running'
  const duplicateTarget = searchQueue.some(
    item =>
      ['waiting', 'running'].includes(item.status) &&
      item.snapshot.galaxy === selection.galaxy &&
      item.snapshot.node === selection.node &&
      item.snapshot.version === selection.version,
  )
  const visibleQueue = searchQueue.filter(
    item => ['waiting', 'running'].includes(item.status) || !viewedTaskIds.has(item.snapshot.taskId),
  )
  const activeQueueItem = searchQueue.find(item => item.status === 'running')
  const activeLock = activeQueueItem ? taskFromQueue(activeQueueItem) : searchTask
  const queuedNodeLocked = searchQueue.some(
    item =>
      ['waiting', 'running'].includes(item.status) &&
      item.snapshot.galaxy === selection.galaxy &&
      item.snapshot.node === selection.node &&
      item.snapshot.version === selection.version,
  )
  const queuedCommonLocked = searchQueue.some(
    item =>
      ['waiting', 'running'].includes(item.status) &&
      item.snapshot.galaxy === selection.galaxy &&
      item.snapshot.common === selection.common,
  )
  const rerunActive = galaxyRerun?.status === 'running'
  const rerunNodeLocked = Boolean(
    rerunActive &&
    galaxyRerun.galaxy === selection.galaxy &&
    galaxyRerun.nodes.some(
      item =>
        item.node === selection.node &&
        item.version === selection.version &&
        ['queued', 'running'].includes(item.status),
    ),
  )
  const rerunCommonLocked = Boolean(
    rerunActive &&
    galaxyRerun.galaxy === selection.galaxy &&
    galaxyRerun.nodes.some(item => item.common === selection.common && ['queued', 'running'].includes(item.status)),
  )
  const nodeReadOnly = nodeLocked(activeLock, selection) || queuedNodeLocked || rerunNodeLocked
  const commonReadOnly = commonLocked(activeLock, selection) || queuedCommonLocked || rerunCommonLocked
  const optimizerReadOnly = Boolean(taskRunning || rerunActive)
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
        let saved: { workspace?: Workspace; contexts?: Partial<PageContexts> } | null = null
        try {
          saved = JSON.parse(localStorage.getItem(LAST_LOCATION_KEY) ?? 'null')
        } catch {
          /* ignore invalid local state */
        }
        const contexts = saved?.contexts
          ? restoreContexts(next, saved.contexts)
          : initialContexts(next, storedSearchSelection(next))
        pageContextsRef.current = contexts
        setPageContexts(contexts)
        const page =
          saved?.workspace && ['node', 'common', 'search', 'rerun', 'templates'].includes(saved.workspace)
            ? saved.workspace
            : 'node'
        setWorkspace(page)
        if (page === 'rerun') {
          const galaxy = next.galaxies.find(item => item.id === contexts.rerunGalaxy)
          const first = galaxy?.nodes[0]
          setSelection({
            galaxy: galaxy?.id ?? '',
            node: first?.id ?? '',
            version: first?.defaultVersion ?? '',
            common: galaxy?.defaultCommon ?? '',
          })
        } else setSelection(contexts[page])
        void api.searchQueue().then(setSearchQueue)
      })
      .catch(error => setMessage(`无法读取 Manager / Optimizer 配置：${(error as Error).message}`))
    const stopOutput = api.onOutput((output: OptimizerOutput) => {
      if (!output.taskId) return
      setSearchTask(current => {
        if (!current || current.snapshot.taskId !== output.taskId) return current
        return { ...current, logs: `${current.logs}${output.line}` }
      })
    })
    const stopTask = api.onSearchTask(task => setSearchTask(current => current ?? taskFromSnapshot(task)))
    const stopQueue = api.onSearchQueue(queue => {
      setSearchQueue(queue)
      setSearchTask(current => {
        const item = queue.find(entry => entry.snapshot.taskId === current?.snapshot.taskId)
        return item ? taskFromQueue(item) : current
      })
    })
    const stopProgress = api.onGalaxyProgress(progress => {
      setGalaxyRerun(progress)
      setRerunStarting(false)
      if (progress.search) {
        setSavedSearchConfigSource(format(progress.search))
        setConfigSources(current => ({ ...current, search: 'local' }))
      }
    })
    return () => {
      stopOutput()
      stopTask()
      stopQueue()
      stopProgress()
    }
  }, [api])
  useEffect(() => {
    if (pageContextsRef.current)
      localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ workspace, contexts: pageContextsRef.current }))
  }, [workspace, selection])
  useEffect(() => {
    localStorage.setItem(RERUN_SELECTIONS_KEY, JSON.stringify(rerunSelections))
  }, [rerunSelections])
  useEffect(() => {
    if (!searchTask || searchTask.status !== 'running') return
    const updateElapsed = () =>
      setElapsedSeconds(
        Math.max(
          0,
          Math.floor((Date.now() - Date.parse(searchTask.runningAt ?? searchTask.snapshot.startedAt)) / 1000),
        ),
      )
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [searchTask?.runningAt, searchTask?.snapshot.startedAt, searchTask?.status])
  useEffect(() => {
    if (!hasAnyDirtyDraft) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasAnyDirtyDraft])
  useLayoutEffect(() => {
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
  const viewingGalaxyDetail = Boolean(galaxyDetail && detailKey === selectionKey)
  const activeRun = viewingGalaxyDetail
    ? (galaxyDetail?.run ??
      (galaxyDetail?.error
        ? {
            exitCode: -1,
            startedAt: galaxyDetail.startedAt ?? galaxyRerun!.startedAt,
            finishedAt: galaxyDetail.finishedAt ?? galaxyRerun!.finishedAt ?? galaxyRerun!.startedAt,
            error: galaxyDetail.error,
            canceled: galaxyDetail.status === 'canceled',
          }
        : null))
    : searchTask
      ? {
          exitCode: searchTask.exitCode ?? (searchTask.status === 'failed' ? -1 : 0),
          startedAt: searchTask.runningAt ?? searchTask.snapshot.startedAt,
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
    setMessage('')
    setErrorDetail('')
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
    setErrorDetail('')
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
      setErrorDetail('')
      if (label) setMessage(label)
    } catch (error) {
      if (workspace === 'rerun' || workspace === 'search') {
        setMessage(`操作失败：${runErrorSummary(error)}`)
        setErrorDetail(String((error as Error).message ?? error).slice(0, 4000))
      } else setMessage(`操作失败：${(error as Error).message}`)
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
      if (
        !nodeMatchesSelection ||
        parsed.galaxy !== Number(selection.galaxy.slice(1)) ||
        typeof parsed.node !== 'string' ||
        parsed.node.toLowerCase() !== selection.node.replace(/_num$/i, '').toLowerCase()
      )
        throw new Error(
          `当前选择为 ${selection.galaxy.toUpperCase()}/${selection.node}，但编辑中的 Node JSON 标识为 ${String(parsed.galaxy)}/${String(parsed.node)}。请检查高级 JSON 中的 galaxy 和 node，或切换回对应节点后保存。`,
        )
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
    if (!searchConfig) {
      setMessage('搜索配置尚未加载，无法启动。')
      return
    }
    setGalaxyDetail(null)
    setErrorDetail('')
    setMessage(`正在将 ${selection.galaxy.toUpperCase()} / ${selection.node} 加入队列…`)
    localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(selection))
    try {
      const item = await api.enqueueSearch({
        ...selection,
        versionName: currentVersion?.name ?? selection.version,
        commonName: currentCommon?.name ?? selection.common,
        search: searchConfig,
      })
      setSearchTask(taskFromQueue(item))
      const confirmed = format(searchConfig)
      setSearchConfig(searchConfig)
      setSearchConfigSource(confirmed)
      setSavedSearchConfigSource(confirmed)
      setConfigSources(current => ({ ...current, search: 'local' }))
      setMessage(`${item.snapshot.node} 已加入搜索队列。`)
    } catch (error) {
      setMessage(`无法加入队列：${runErrorSummary(error)}`)
      setErrorDetail(String((error as Error).message ?? error).slice(0, 4000))
    }
  }
  const useBest = () => {
    const source = viewingGalaxyDetail ? galaxyDetail?.run : undefined
    const task = viewingGalaxyDetail ? source?.task : searchTask?.snapshot
    const hasBest = viewingGalaxyDetail
      ? galaxyDetail?.status === 'succeeded' && Boolean(source?.result?.best_result)
      : searchTask?.status === 'completed' && Boolean(searchTask.result?.best_result)
    if (!task || !hasBest || rerunActive) return
    const targetKey = nodeDomainKey(task)
    const targetDirty = isDirty(nodeDrafts.current.get(targetKey)) || isDirty(searchDrafts.current.get(targetKey))
    if (targetDirty) {
      setMessage(`目标 ${task.node} / ${task.versionName} 存在未保存草稿，未应用 Best Found。`)
      return
    }
    void act(`Best Found 已写入 ${task.node} / ${task.versionName}。`, async () => {
      const result = await api.useBest(task.taskId)
      if (result.error || !result.node) throw new Error(result.error ?? 'Copy 未返回有效 Node。')
      setAppliedTaskIds(current => new Set(current).add(task.taskId))
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
  }
  const applyGalaxyBest = async () => {
    if (!galaxyRerun || galaxyRerun.status === 'running' || bulkApplying || busy || taskRunning) return
    cacheCurrentDraft()
    const candidates = galaxyRerun.nodes.filter(
      item =>
        item.status === 'succeeded' &&
        item.changed &&
        item.run?.task &&
        item.run.result?.best_result &&
        !appliedTaskIds.has(item.run.task.taskId),
    )
    if (!candidates.length) return
    setBulkApplying(true)
    const applied: string[] = []
    const failed: string[] = []
    try {
      for (const item of candidates) {
        const task = item.run!.task!
        const targetKey = nodeDomainKey(task)
        if (isDirty(nodeDrafts.current.get(targetKey)) || isDirty(searchDrafts.current.get(targetKey))) {
          failed.push(`${item.node}：目标有未保存草稿`)
          continue
        }
        try {
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
          applied.push(task.taskId)
        } catch (error) {
          failed.push(`${item.node}：${runErrorSummary(error)}`)
        }
      }
      if (applied.length) setAppliedTaskIds(current => new Set([...current, ...applied]))
      setMessage(`已应用 ${applied.length} 个节点的 Best Found；${failed.length} 个未应用。`)
      setErrorDetail(failed.join('\n').slice(0, 4000))
    } finally {
      setBulkApplying(false)
    }
  }
  const rerunCurrentGalaxy = async () => {
    if (!searchConfig || !rerunNodes.length || rerunStarting || rerunActive) return
    const searchSnapshot = searchConfig
    try {
      setRerunStarting(true)
      setErrorDetail('')
      setGalaxyDetail(null)
      setMessage(`${selection.galaxy.toUpperCase()} 正在串行重跑…`)
      const result = await api.rerunGalaxy({ galaxy: selection.galaxy, nodes: rerunNodes, search: searchSnapshot })
      setGalaxyRerun(result)
      setSavedSearchConfigSource(format(searchSnapshot))
      setConfigSources(current => ({ ...current, search: 'local' }))
      const failed = result.nodes.filter(item => item.status === 'failed').length
      const changed = result.nodes.filter(item => item.changed).length
      const canceled = result.nodes.filter(item => item.status === 'canceled').length
      setMessage(`Galaxy 重跑结束：发现 ${changed} 个有效变化，${failed} 个失败，${canceled} 个已停止。`)
    } catch (error) {
      setMessage(`Galaxy 重跑失败：${runErrorSummary(error)}`)
      setErrorDetail(String((error as Error).message ?? error).slice(0, 4000))
    } finally {
      setRerunStarting(false)
    }
  }
  const stopCurrent = () => void api.stopCurrent().catch(error => setMessage(runErrorSummary(error)))
  const stopAll = () => void api.stopAll().catch(error => setMessage(runErrorSummary(error)))
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
  const createGalaxy = () => {
    if (!requireNodeSaved(selection, false)) return
    void act('Galaxy 已创建并切换。', async () => {
      const galaxy = newGalaxy.trim().toLowerCase()
      const node = newGalaxyNode.trim()
      if (!/^g\d+$/.test(galaxy)) throw new Error('Galaxy ID 应为 G 加数字，例如 G7。')
      if (!node) throw new Error('请输入初始 Node ID。')
      const created = await api.createGalaxy({ galaxy, node, versionName: '默认', source: selection })
      await refresh()
      setCurrentSelection({ galaxy, node: created.node, version: created.version, common: created.common })
      setNewNodeGalaxy(galaxy)
      setNewGalaxy('')
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
    if (!nodeMatchesSelection) return
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
    templates: { title: '模板与复制', description: '创建 Galaxy、Node 和可复用模板' },
  }
  const optimizerGlobalContext = workspace === 'common' && commonTab === 'optimizer'
  const showNodeContext = workspace === 'node' || workspace === 'search' || workspace === 'templates'
  const showCommonContext = showNodeContext || (workspace === 'common' && commonTab === 'galaxy')
  const rerunCatalogNodes = catalog.galaxies.find(item => item.id === selection.galaxy)?.nodes ?? []
  const rerunCatalogNodeIds = rerunCatalogNodes.map(node => node.id)
  const rerunNodes = selectedRerunNodes(rerunCatalogNodeIds, rerunSelections[selection.galaxy])
  const setRerunNodes = (update: (current: string[]) => string[]) => {
    const selected = update(rerunNodes)
    setRerunSelections(current => ({
      ...current,
      [selection.galaxy]: { known: rerunCatalogNodeIds, selected },
    }))
  }
  const orderedRerunNodeIds = [
    ...rerunNodes.filter(id => rerunCatalogNodes.some(node => node.id === id)),
    ...rerunCatalogNodes.map(node => node.id).filter(id => !rerunNodes.includes(id)),
  ]
  const showRerunResult = galaxyRerun?.galaxy === selection.galaxy
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
        {visibleQueue.length ? (
          <div className="sidebar-queue" aria-label="搜索任务队列">
            <strong>搜索任务</strong>
            {visibleQueue.map(item => (
              <button
                key={item.snapshot.taskId}
                className="task-chip"
                onClick={() => {
                  switchWorkspace('search')
                  setSearchTask(taskFromQueue(item))
                  if (!['waiting', 'running'].includes(item.status))
                    setViewedTaskIds(current => new Set(current).add(item.snapshot.taskId))
                }}
              >
                <span className={`run-dot ${item.status}`} />
                <span>
                  <strong>
                    {item.snapshot.node} ·{' '}
                    {item.status === 'waiting'
                      ? '等待'
                      : item.status === 'running'
                        ? '搜索中'
                        : item.status === 'success'
                          ? '完成'
                          : item.status === 'canceled'
                            ? '已停止'
                            : '失败'}
                  </strong>
                  <small>
                    {item.status === 'waiting'
                      ? '—'
                      : formatDuration(
                          item.run
                            ? Math.max(
                                0,
                                Math.round((Date.parse(item.run.finishedAt) - Date.parse(item.run.startedAt)) / 1000),
                              )
                            : elapsedSeconds,
                        )}
                  </small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {!searchQueue.length && searchTask && ['waiting', 'running'].includes(searchTask.status) ? (
          <button className="task-chip" onClick={() => switchWorkspace('search')}>
            <span className={`run-dot ${searchTask.status}`} />
            <span>
              <strong>
                {searchTask.snapshot.node} {searchTask.status === 'running' ? '搜索中' : '等待'}
              </strong>
              <small>{formatDuration(elapsedSeconds)}</small>
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
            <SmartSelect
              label="Galaxy"
              value={selection.galaxy}
              onChange={value => update('galaxy', value)}
              disabled={workspace === 'rerun' && (rerunStarting || rerunActive)}
              options={catalog.galaxies.map(g => ({ value: g.id, label: g.id.toUpperCase() }))}
            />
          </Label>
        )}
        {showNodeContext ? (
          <Label text="节点">
            <SmartSelect
              label="节点"
              value={selection.node}
              onChange={value => update('node', value)}
              searchable
              options={currentGalaxy?.nodes.map(n => ({ value: n.id, label: n.id })) ?? []}
            />
          </Label>
        ) : null}
        {showNodeContext ? (
          <Label text="版本">
            <SmartSelect
              label="版本"
              value={selection.version}
              onChange={value => update('version', value)}
              searchable
              options={
                currentNode?.versions.map(v => ({ value: v.id, label: `${v.name}${v.isDefault ? ' ★' : ''}` })) ?? []
              }
            />
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
            <SmartSelect
              label="公共配置"
              value={selection.common}
              onChange={value => update('common', value)}
              searchable
              options={
                currentGalaxy?.commons.map(c => ({ value: c.id, label: `${c.name}${c.isDefault ? ' ★' : ''}` })) ?? []
              }
            />
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
        <div className="notice" role="status">
          <p>{message}</p>
          {errorDetail ? (
            <details>
              <summary>查看详情</summary>
              <pre>{errorDetail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {workspace === 'rerun' ? (
        <div className={`rerun-workspace ${showRerunResult ? 'has-results' : 'configuring'}`}>
          <section className="panel rerun-selection" aria-label="选择重跑节点">
            <details
              className="rerun-selection-details"
              open={!showRerunResult}
              key={showRerunResult ? 'result' : 'selection'}
            >
              <summary>
                <strong>{showRerunResult ? (rerunActive ? '查看本次节点顺序' : '调整下次重跑') : '本次重跑'}</strong>
                <span>
                  已选 {rerunNodes.length} / {rerunCatalogNodes.length} 个节点
                </span>
              </summary>
              <div className="rerun-selection-body">
                <p>选择节点并调整顺序。启动时自动保存并冻结搜索设置。</p>
                <p>
                  {searchConfig
                    ? `${strategyName(searchConfig.strategy)} · ${profileName(searchConfig.profile)} · 最长 ${searchConfig.max_wall_seconds} 秒 / 最多 ${searchConfig.max_simulations} 次 · ${searchConfig.workers} 个并行进程 · 普通战目标按各节点配置${searchDirty ? ' · 待自动保存' : ''}`
                    : '搜索设置加载中'}
                </p>
                <div className="rerun-selection-tools">
                  <strong className="rerun-selected-count">从左到右、从上到下按序号执行</strong>
                  <button
                    onClick={() =>
                      setRerunNodes(current =>
                        current.length === rerunCatalogNodes.length
                          ? []
                          : [
                              ...current.filter(id => rerunCatalogNodes.some(node => node.id === id)),
                              ...rerunCatalogNodes.map(node => node.id).filter(id => !current.includes(id)),
                            ],
                      )
                    }
                    disabled={rerunActive || rerunStarting || !rerunCatalogNodes.length}
                  >
                    {rerunNodes.length === rerunCatalogNodes.length ? '全取消' : '全选'}
                  </button>
                </div>
                <div className="rerun-order">
                  {orderedRerunNodeIds.map(nodeId => {
                    const index = rerunNodes.indexOf(nodeId)
                    const nodeStatus = showRerunResult
                      ? galaxyRerun?.nodes.find(item => item.node === nodeId)?.status
                      : undefined
                    return (
                      <div key={nodeId} className={index >= 0 ? 'selected' : 'unselected'}>
                        <label>
                          <input
                            type="checkbox"
                            checked={index >= 0}
                            disabled={rerunActive || rerunStarting}
                            onChange={event =>
                              setRerunNodes(current =>
                                event.target.checked ? [...current, nodeId] : current.filter(id => id !== nodeId),
                              )
                            }
                          />
                          <span className="rerun-rank">{index >= 0 ? index + 1 : '—'}</span>
                          {nodeId}
                        </label>
                        {nodeStatus ? (
                          <small>
                            {nodeStatus === 'running'
                              ? '搜索中'
                              : nodeStatus === 'queued'
                                ? '等待'
                                : nodeStatus === 'failed'
                                  ? '失败'
                                  : nodeStatus === 'succeeded'
                                    ? '完成'
                                    : '已停止'}
                          </small>
                        ) : null}
                        <button
                          aria-label={`上移 ${nodeId}`}
                          disabled={rerunActive || rerunStarting || index <= 0}
                          onClick={() =>
                            setRerunNodes(current => {
                              const next = [...current]
                              ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                              return next
                            })
                          }
                        >
                          ↑
                        </button>
                        <button
                          aria-label={`下移 ${nodeId}`}
                          disabled={rerunActive || rerunStarting || index < 0 || index >= rerunNodes.length - 1}
                          onClick={() =>
                            setRerunNodes(current => {
                              const next = [...current]
                              ;[next[index + 1], next[index]] = [next[index], next[index + 1]]
                              return next
                            })
                          }
                        >
                          ↓
                        </button>
                      </div>
                    )
                  })}
                </div>
                <button
                  className="primary"
                  onClick={() => void rerunCurrentGalaxy()}
                  disabled={rerunStarting || rerunActive || bulkApplying || taskRunning || !rerunNodes.length}
                >
                  开始重跑所选节点
                </button>
              </div>
            </details>
          </section>
          {showRerunResult && galaxyRerun ? (
            <GalaxyRerunPanel
              progress={galaxyRerun}
              onOpen={openGalaxyResult}
              onStopCurrent={stopCurrent}
              onStopAll={stopAll}
              onApplyAll={() => void applyGalaxyBest()}
              applicableCount={
                galaxyRerun.nodes.filter(
                  item =>
                    item.status === 'succeeded' &&
                    item.changed &&
                    item.run?.task &&
                    item.run.result?.best_result &&
                    !appliedTaskIds.has(item.run.task.taskId),
                ).length
              }
              applying={bulkApplying || busy || taskRunning}
            />
          ) : null}
        </div>
      ) : null}
      {workspace === 'templates' ? (
        <section className="management panel workspace-view">
          <div>
            <h2>创建 Galaxy</h2>
            <p>复制当前 Galaxy 的 Common 和当前 Node / Version，作为新 Galaxy 的初始配置。</p>
            <div className="inline">
              <input
                aria-label="新 Galaxy ID"
                placeholder="例如 G7"
                value={newGalaxy}
                onChange={event => setNewGalaxy(event.target.value)}
              />
              <input
                aria-label="初始 Node ID"
                placeholder="例如 B1"
                value={newGalaxyNode}
                onChange={event => setNewGalaxyNode(event.target.value)}
              />
              <button
                onClick={createGalaxy}
                disabled={busy || !selection.node || !newGalaxy.trim() || !newGalaxyNode.trim()}
              >
                创建 Galaxy
              </button>
            </div>
          </div>
          <div>
            <h2>Node 创建与模板</h2>
            <div className="inline">
              <SmartSelect
                label="创建来源"
                value={createMode}
                onChange={value => setCreateMode(value as 'selection' | 'template')}
                options={[
                  { value: 'selection', label: '复制当前 Node / Version' },
                  { value: 'template', label: '从模板创建' },
                ]}
              />
              {createMode === 'template' ? (
                <SmartSelect
                  label="创建模板"
                  value={template}
                  onChange={setTemplate}
                  searchable
                  options={[
                    { value: '', label: '选择模板' },
                    ...catalog.templates.map(t => ({ value: t.id, label: t.name })),
                  ]}
                />
              ) : null}
              <SmartSelect
                label="新 Node Galaxy"
                value={newNodeGalaxy || selection.galaxy}
                onChange={setNewNodeGalaxy}
                options={catalog.galaxies.map(g => ({ value: g.id, label: g.id.toUpperCase() }))}
              />
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
              <SmartSelect
                label="管理模板"
                value={template}
                onChange={setTemplate}
                searchable
                options={[
                  { value: '', label: '选择模板' },
                  ...catalog.templates.map(t => ({ value: t.id, label: t.name })),
                ]}
              />
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
          {commonTab === 'galaxy' && commonReadOnly ? (
            <LockedNotice
              node={
                activeQueueItem?.snapshot.node ??
                galaxyRerun?.currentNode ??
                searchTask?.snapshot.node ??
                selection.node
              }
              label="该 Galaxy Common"
              kind={rerunActive ? '重跑' : '搜索'}
            />
          ) : null}
          {commonTab === 'optimizer' && optimizerReadOnly ? (
            <LockedNotice
              node={
                activeQueueItem?.snapshot.node ??
                galaxyRerun?.currentNode ??
                searchTask?.snapshot.node ??
                selection.node
              }
              label="Optimizer 公共配置"
              kind={rerunActive ? '重跑' : '搜索'}
            />
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
            {nodeReadOnly ? (
              <LockedNotice
                node={
                  activeQueueItem?.snapshot.node ??
                  galaxyRerun?.currentNode ??
                  searchTask?.snapshot.node ??
                  selection.node
                }
                label="该 Node Version"
                kind={rerunActive ? '重跑' : '搜索'}
              />
            ) : null}
            <fieldset className="editor-lock" disabled={nodeReadOnly}>
              {nodeMatchesSelection && node && editorTab === 'formation' ? (
                <FormationEditor config={node} common={common} optimizer={optimizerConfig} onChange={tableChange} />
              ) : null}
              {nodeMatchesSelection && node && editorTab === 'fleet' ? (
                <FleetStateEditor key={nodeDomainKey(selection)} config={node} common={common} onChange={tableChange} />
              ) : null}
              {nodeMatchesSelection && node && optimizerConfig && editorTab === 'loadout' ? (
                <LoadoutEditor config={node} optimizer={optimizerConfig} onChange={tableChange} />
              ) : null}
              {nodeMatchesSelection && node && editorTab === 'environment' ? (
                <EnvironmentEditor
                  key={`${workspace}:${nodeDomainKey(selection)}`}
                  config={node}
                  onChange={tableChange}
                />
              ) : null}
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
          duplicateTarget={duplicateTarget}
          dirty={searchDirty}
          readOnly={false}
          task={viewingGalaxyDetail ? null : searchTask}
          viewOnly={viewingGalaxyDetail}
          optimizerBusy={optimizerReadOnly}
          elapsedSeconds={elapsedSeconds}
          activeRun={activeRun}
          changes={changes.length}
          applied={Boolean(activeRun?.task && appliedTaskIds.has(activeRun.task.taskId))}
          onOpenSettings={() => setSearchSettingsOpen(true)}
          onStart={() => void start()}
          onStopCurrent={stopCurrent}
          onStopAll={stopAll}
          onUseBest={useBest}
        />
      ) : null}
      {searchSettingsOpen && searchConfig ? (
        <SearchSettingsDialog
          config={searchConfig}
          dirty={searchDirty}
          readOnly={false}
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
            <p>下次点击“加入搜索队列”时自动保存并重新读取确认。</p>
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

function FleetStateEditor({
  config,
  common,
  onChange,
}: {
  config: NodeConfig
  common: CommonConfig | null
  onChange: (value: NodeConfig) => void
}) {
  const [shipDrafts, setShipDrafts] = useState<Record<string, string>>({})
  const knownOrder: string[] = SHIP_TYPES.map(ship => ship.id)
  const total = common ? effectiveShipCounts(config, common) : config.player_state.ships
  const hasCommonShips = Boolean(common?.ships)
  const ships = [...new Set([...knownOrder, ...Object.keys(total)])].sort((a, b) => {
    const left = knownOrder.indexOf(shipSelectorToId(a) || a)
    const right = knownOrder.indexOf(shipSelectorToId(b) || b)
    return (left < 0 ? 999 : left) - (right < 0 ? 999 : right) || a.localeCompare(b)
  })
  const updateResources = (value: string) =>
    onChange({ ...config, player_state: { ...config.player_state, fleet_resources: Number(value) } })
  const updateShip = (ship: string, value: string) => {
    if (value !== '' && value !== '-' && !/^-?\d+$/.test(value)) return
    if (value === '' || value === '-') {
      setShipDrafts(current => ({ ...current, [ship]: value }))
      return
    }
    const count = Number(value)
    if (!Number.isSafeInteger(count)) return
    setShipDrafts(current => {
      const next = { ...current }
      delete next[ship]
      return next
    })
    onChange({
      ...config,
      player_state: {
        ...config.player_state,
        ships: { ...config.player_state.ships, [ship]: count },
      },
    })
  }
  return (
    <section className="config-section fleet-state-editor">
      <div className="section-heading">
        <div>
          <h3>舰队状态</h3>
          <p>
            {hasCommonShips
              ? '节点填写舰船数量变化，可输入负数；搜索数量为公共与节点之和，最低按 0 计算。'
              : '当前可用 Fleet Resources 与已解锁舰种数量；阵型只能使用数量大于 0 的舰种。'}
          </p>
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
              type="text"
              inputMode="numeric"
              pattern="-?[0-9]*"
              value={shipDrafts[ship] ?? config.player_state.ships[ship] ?? 0}
              onChange={event => updateShip(ship, event.target.value)}
              onBlur={() =>
                setShipDrafts(current => {
                  const next = { ...current }
                  delete next[ship]
                  return next
                })
              }
            />
            {hasCommonShips ? (
              <small>
                公共 {common?.ships?.[ship] ?? 0} + 节点 {config.player_state.ships[ship] ?? 0} = 搜索{' '}
                {total[ship] ?? 0}
              </small>
            ) : null}
          </Label>
        ))}
      </div>
    </section>
  )
}

function EnvironmentEditor({ config, onChange }: { config: NodeConfig; onChange: (value: NodeConfig) => void }) {
  const boss = (config.boss ?? {}) as Record<string, unknown>
  const alive = Boolean(boss.alive)
  const [nodeText, setNodeText] = useState({
    hazards: config.hazards.map(String).join('\n'),
    supports: config.supports.map(String).join('\n'),
  })
  const lastEmittedNodes = useRef<Partial<Pick<NodeConfig, 'hazards' | 'supports'>>>({})
  useEffect(() => {
    setNodeText(current => {
      const hazards =
        config.hazards === lastEmittedNodes.current.hazards ? current.hazards : config.hazards.map(String).join('\n')
      const supports =
        config.supports === lastEmittedNodes.current.supports
          ? current.supports
          : config.supports.map(String).join('\n')
      return hazards === current.hazards && supports === current.supports ? current : { hazards, supports }
    })
  }, [config.hazards, config.supports])
  const updateBoss = (field: string, value: unknown) =>
    onChange({
      ...config,
      boss: { ...boss, [field]: value },
      search: field === 'alive' && value === true ? { ...config.search, target_used_fr: undefined } : config.search,
    })
  const updateNodes = (field: 'hazards' | 'supports', value: string) => {
    const nodes = value
      .split(/[\n,，]+/)
      .map(item => item.trim().toUpperCase())
      .filter(Boolean)
    lastEmittedNodes.current[field] = nodes
    setNodeText(current => ({ ...current, [field]: value }))
    onChange({
      ...config,
      [field]: nodes,
    })
  }
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
          <SmartSelect
            label="Boss 搜索优先级"
            disabled={!alive}
            value={String(boss.priority ?? 'efficiency')}
            onChange={value => updateBoss('priority', value)}
            options={[
              { value: 'efficiency', label: '效率（efficiency）' },
              { value: 'kill_cost', label: '击杀总成本（kill_cost）' },
              {
                value: 'affordable_kill_cost',
                label: '当前资源：优先最低成本击杀，否则最大伤害（affordable_kill_cost）',
              },
            ]}
          />
        </Label>
      </fieldset>
      <div className="budget-group">
        <div>
          <strong>普通战目标</strong>
          <p>保存当前节点后生效。达到目标 Used FR 后结束探索，并执行最终原版重放；留空则搜索到预算结束。</p>
        </div>
        <TargetUsedFrSetting
          value={config.search.target_used_fr}
          disabled={alive}
          onChange={value => onChange({ ...config, search: { ...config.search, target_used_fr: value } })}
        />
        {alive ? <p className="setting-help">Boss 使用独立的评分目标，此项不可用。</p> : null}
      </div>
      <div className="environment-config">
        <Label text="Hazards（每行或逗号分隔）">
          <textarea
            aria-label="Hazards"
            value={nodeText.hazards}
            onChange={event => updateNodes('hazards', event.target.value)}
            placeholder="例如 B10"
          />
        </Label>
        <Label text="Supports（每行或逗号分隔）">
          <textarea
            aria-label="Supports"
            value={nodeText.supports}
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
  duplicateTarget,
  dirty,
  readOnly,
  task,
  viewOnly,
  optimizerBusy,
  elapsedSeconds,
  activeRun,
  changes,
  applied,
  onOpenSettings,
  onStart,
  onStopCurrent,
  onStopAll,
  onUseBest,
}: {
  node: NodeConfig | null
  search: SearchConfig | null
  searchSource: ConfigSource
  commonName: string
  versionName: string
  selection: Selection
  busy: boolean
  duplicateTarget: boolean
  dirty: boolean
  readOnly: boolean
  task: SearchTaskState | null
  viewOnly: boolean
  optimizerBusy: boolean
  elapsedSeconds: number
  activeRun: RunResult | null | undefined
  changes: number
  applied: boolean
  onOpenSettings: () => void
  onStart: () => void
  onStopCurrent: () => void
  onStopAll: () => void
  onUseBest: () => void
}) {
  const running = task?.status === 'running'
  const taskLogs = task?.logs ?? ''
  const runSeconds = running
    ? elapsedSeconds
    : activeRun
      ? Math.max(0, Math.round((Date.parse(activeRun.finishedAt) - Date.parse(activeRun.startedAt)) / 1000))
      : elapsedSeconds
  const logLines = taskLogs.split(/\r?\n/).reverse()
  const progressLine = logLines.find(line => /^(Evaluated: \d+|\d+\/\d+ \|)/.test(line))
  const evaluated = progressLine?.match(/^(?:Evaluated: )?(\d+(?:\/\d+)?)/)?.[1] ?? '—'
  const phase = logLines.find(line => /^\[\d+\/\d+\] /.test(line))?.replace(/^\[\d+\/\d+\] /, '')
  const workerLine = logLines
    .find(line => /Workers: (?:\d+|starting|single-process)/.test(line))
    ?.match(/Workers: (\d+|starting|single-process)/)?.[1]
  const effectiveWorkers =
    typeof activeRun?.result?.workers_effective === 'number' ? activeRun.result.workers_effective : undefined
  const snapshot = task?.snapshot ?? (viewOnly ? activeRun?.task : undefined)
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
  const targetUsedFr = snapshot ? snapshot.search.target_used_fr : node?.search.target_used_fr
  const profile = search ? `${strategyName(search.strategy)} · ${profileName(search.profile)}` : '—'
  return (
    <section className="search-workspace workspace-view">
      <div className="search-context panel" aria-label="搜索目标与战斗环境">
        <strong className="context-title">{viewOnly ? 'Galaxy 重跑结果' : snapshot ? '任务快照' : '搜索目标'}</strong>
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
        {search?.strategy === 'advisor_seeded' ? (
          <p className="advisor-guidance">
            在“节点配置”的阵型与装配中填入游戏推荐舰队。起始站位允许战败；本次只调整站位，不改变舰种、数量或 Mods。
          </p>
        ) : null}
        <button
          className="primary start-search"
          onClick={onStart}
          disabled={busy || !search || duplicateTarget}
          title={duplicateTarget ? '该 Node / Version 已在等待或搜索中' : undefined}
        >
          <Icon name="play" />
          加入搜索队列
        </button>
        {running ? <button onClick={onStopCurrent}>停止当前</button> : null}
        {running ? <button onClick={onStopAll}>停止全部</button> : null}
        <p className="search-summary">
          <strong>{profile}</strong>
          <span>
            预算：最长 {search?.max_wall_seconds ?? '—'} 秒 / 最多 {search?.max_simulations ?? '—'} 次模拟
          </span>
          <span>{search?.workers ?? '—'} 个并行进程</span>
          {!bossAlive && targetUsedFr != null ? <span>目标 Used FR ≤ {targetUsedFr}</span> : null}
          {dirty ? <em>待自动保存</em> : <small>{searchSource === 'local' ? '本机配置' : 'poc 默认'}</small>}
        </p>
        <button className="search-settings-button" onClick={onOpenSettings} disabled={readOnly}>
          <Icon name="settings" />
          搜索设置
        </button>
      </section>
      <section className="panel run-status">
        <h2>运行状态</h2>
        <dl>
          <div>
            <dt>当前任务</dt>
            <dd>
              {task
                ? `${task.snapshot.galaxy.toUpperCase()} / ${task.snapshot.node} · ${task.snapshot.versionName}`
                : viewOnly
                  ? `${selection.galaxy.toUpperCase()} / ${selection.node} · ${versionName}`
                  : '—'}
            </dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>
              {running
                ? '搜索中'
                : task?.status === 'waiting'
                  ? '等待'
                  : task?.status === 'canceled'
                    ? '已停止'
                    : activeRun
                      ? activeRun.error
                        ? '失败'
                        : '已完成'
                      : '空闲'}
            </dd>
          </div>
          <div>
            <dt>已耗时</dt>
            <dd>{formatDuration(runSeconds)}</dd>
          </div>
          <div>
            <dt>Evaluated / Progress</dt>
            <dd>
              {running
                ? evaluated
                : typeof activeRun?.result?.simulations_used === 'number'
                  ? activeRun.result.simulations_used
                  : evaluated}
            </dd>
          </div>
          <div>
            <dt>并行进程</dt>
            <dd>
              {effectiveWorkers ??
                (workerLine === 'starting'
                  ? '启动中'
                  : workerLine === 'single-process'
                    ? '1'
                    : (workerLine ?? snapshot?.search.workers ?? search?.workers ?? '—'))}
            </dd>
          </div>
          {running && phase ? (
            <div className="status-phase">
              <dt>阶段</dt>
              <dd>{phase}</dd>
            </div>
          ) : null}
        </dl>
        <details className="console">
          <summary>Optimizer 输出 / 日志（最近 200 KB）</summary>
          <pre className="logs">{taskLogs || (running ? '等待 Optimizer 输出…' : '尚未启动任务。')}</pre>
        </details>
      </section>
      <section className="panel best-found-panel">
        {activeRun?.result?.best_result ? (
          <BestFound
            result={activeRun.result}
            changes={changes}
            fromRerun={viewOnly}
            applied={applied}
            busy={busy || running || optimizerBusy}
            target={viewOnly ? activeRun?.task : task?.snapshot}
            onUseBest={onUseBest}
          />
        ) : (
          <div className="result-empty">
            <span aria-hidden="true">◎</span>
            <strong>
              {activeRun?.result?.recommendation_status === 'NO VICTORY FOUND' ? '未找到获胜站位' : '还没有搜索结果'}
            </strong>
            <p>
              {activeRun?.error
                ? runErrorSummary(activeRun.error, activeRun.canceled)
                : activeRun?.result?.recommendation_status === 'NO VICTORY FOUND'
                  ? '已搜索的站位中没有可复制的获胜阵型；可调整推荐舰队或增加搜索预算后重试。'
                  : '搜索完成后，Best Found 会直接显示在这里。'}
            </p>
            {activeRun?.error ? (
              <details>
                <summary>查看详情</summary>
                <pre>{activeRun.error}</pre>
              </details>
            ) : null}
          </div>
        )}
      </section>
    </section>
  )
}

function BestFound({
  result,
  changes,
  fromRerun,
  applied,
  busy,
  target,
  onUseBest,
}: {
  result: NonNullable<RunResult['result']>
  changes: number
  fromRerun: boolean
  applied: boolean
  busy: boolean
  target?: SearchTaskState['snapshot']
  onUseBest: () => void
}) {
  const best = result.best_result!
  const baseline = result.verified_baseline
  const usedFr = usedFrIntegerChange(baseline, best)
  const improvement = (result.improvement_vs_baseline ?? {}) as Record<string, unknown>
  const saved =
    typeof baseline?.fleet_resources_used === 'number' && typeof best.fleet_resources_used === 'number'
      ? baseline.fleet_resources_used - best.fleet_resources_used
      : null
  const byPosition = new Map(best.formation.map(entry => [entry.position, entry]))
  const columns = formationColumnLabels(resultFormationColumns(result.base_config, target?.formation_columns)).reverse()
  const resultGridStyle = { gridTemplateColumns: `2rem repeat(${columns.length}, minmax(6rem, 1fr))` }
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
  const hasKillComparison =
    Boolean(result.affordable_kill_status?.trim()) ||
    Boolean(result.per_battle_best_result?.formation.length) ||
    Boolean(result.affordable_best_result?.formation.length)
  return (
    <div className="best-found">
      <div className="best-found-heading">
        <div>
          <h2>Best Found</h2>
          <p>
            {typeof best.campaign_boss_damage === 'number'
              ? `当前资源方案：${best.campaign_battles} 场，累计伤害 ${best.campaign_boss_damage}，剩余 BOSS 血量 ${best.boss_final_hp}。`
              : usedFr
                ? `Used FR 取整：${usedFr.baselineUsed} → ${usedFr.bestUsed}，${usedFr.saved > 0 ? `减少 ${usedFr.saved}` : usedFr.saved < 0 ? `增加 ${-usedFr.saved}` : '变化 0'}。${changes ? `阵型或装配有 ${changes} 项差异。` : ''}`
                : changes
                  ? `相对当前配置有 ${changes} 项阵型或装配变化。`
                  : 'Best Found 与当前配置一致。'}
          </p>
        </div>
        <button
          className="success use-best"
          onClick={onUseBest}
          disabled={busy || (fromRerun ? !hasRerunChange(baseline, best) : changes === 0) || !target || applied}
        >
          <Icon name="check" />
          {applied ? '已同步到配置' : '使用最优配置'}
        </button>
      </div>
      {target ? (
        <p className="apply-target">
          应用到：{target.galaxy.toUpperCase()} / {target.node} / {target.versionName}
        </p>
      ) : null}
      {hasKillComparison ? (
        <section aria-label="Boss 完整击杀结果">
          <p>
            当前 FR：{result.current_fleet_resources ?? '—'} ·{' '}
            {result.affordable_kill_status ||
              (result.affordable_best_result?.formation.length ? '已找到可负担的完整击杀' : '未找到可负担的完整击杀')}
          </p>
          <KillCandidateDetails title="每战 FR 限额最低总成本" candidate={result.per_battle_best_result} />
          <KillCandidateDetails title="当前 FR 可负担最低总成本" candidate={result.affordable_best_result} />
        </section>
      ) : null}
      {typeof best.campaign_boss_damage === 'number' ? (
        <section aria-label="当前资源战斗方案">
          <p>
            累计消耗 {best.refined_fr_spent} FR · 剩余资源 {best.campaign_remaining_fr} FR
          </p>
          <p>下方编队和“使用最优配置”对应第 1 场。后续各场按方案调整阵型与装配。</p>
          {best.kill_sequence?.map(battle => (
            <details key={battle.battle}>
              <summary>
                第 {battle.battle} 场：BOSS {battle.boss_hp_before} → {battle.boss_hp_after} · 消耗 {battle.used_fr} FR
              </summary>
              <p>
                部署 {battle.committed_fr} FR · 战后剩余 {battle.fr_remaining ?? '—'} FR
              </p>
              <p>
                {battle.formation?.map(entry => `${entry.position} ${shipDisplayName(entry.ship, false)}`).join('、')}
              </p>
              {Object.entries(battle.loadouts ?? {}).map(([ship, loadout]) => (
                <p key={ship}>
                  {shipDisplayName(ship, false)}：Primary {modText(loadout.primary)} · Secondary{' '}
                  {modText(loadout.secondary)}
                </p>
              ))}
            </details>
          ))}
        </section>
      ) : null}
      <dl className="result-metrics">
        <div>
          <dt>{best.campaign_battles ? '首场 Outcome' : 'Outcome'}</dt>
          <dd>{best.outcome ?? '—'}</dd>
        </div>
        <div>
          <dt>{best.campaign_battles ? '首场 Committed FR' : 'Committed FR'}</dt>
          <dd>{best.fleet_resources_committed ?? '—'}</dd>
        </div>
        <div>
          <dt>{best.campaign_battles ? '首场 Used FR' : 'Used FR'}</dt>
          <dd>{best.fleet_resources_used ?? '—'}</dd>
        </div>
        {typeof best.boss_damage === 'number' && best.boss_damage > 0 ? (
          <div>
            <dt>{best.campaign_battles ? '首场 Boss Damage' : 'Boss Damage'}</dt>
            <dd>{best.boss_damage}</dd>
          </div>
        ) : null}
        {saved !== null && !best.campaign_battles ? (
          <div>
            <dt>Saved FR</dt>
            <dd>{saved.toFixed(2)}</dd>
          </div>
        ) : null}
        {!best.campaign_battles &&
        (typeof improvement.percent === 'number' ||
          (saved !== null &&
            typeof baseline?.fleet_resources_used === 'number' &&
            baseline.fleet_resources_used > 0)) ? (
          <div>
            <dt>改善比例</dt>
            <dd>
              {(typeof improvement.percent === 'number'
                ? improvement.percent
                : (saved! / baseline!.fleet_resources_used!) * 100
              ).toFixed(2)}
              %
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="best-grid">
        <section>
          <h3>最终编队</h3>
          <div className="best-formation" role="table" aria-label={`最终编队 ${columns.join('/')} 横向、1 到 5 纵向`}>
            <div className="formation-header" role="row" style={resultGridStyle}>
              <span />
              {columns.map(column => (
                <strong role="columnheader" key={column}>
                  {column}
                </strong>
              ))}
            </div>
            {FORMATION_ROWS.map(row => (
              <div className="formation-row" role="row" key={row} style={resultGridStyle}>
                <strong className="formation-row-label" role="rowheader">
                  {row}
                </strong>
                {columns.map(column => {
                  const position = `${column}${row}`
                  const entry = byPosition.get(position)
                  const ship = entry ? shipSelectorToId(entry.ship) : null
                  return (
                    <div
                      role="cell"
                      aria-label={`${position} ${entry ? shipDisplayName(entry.ship, false) : '空位'}`}
                      className={`formation-cell ${ship ? `ship-${ship.toLowerCase()}` : 'ship-empty'}`}
                      key={position}
                    >
                      <b>{position}</b>
                      <span>{entry ? shipDisplayName(entry.ship, false) : '空位'}</span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </section>
        <section>
          <h3>舰船最终配置</h3>
          <div className="best-loadouts">
            {orderedLoadouts.map(([ship, loadout]) => (
              <div className={`ship-${ship.toLowerCase()}`} key={ship}>
                <strong>{shipDisplayName(ship, false)}</strong>
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

type KillCandidate = NonNullable<NonNullable<RunResult['result']>['best_result']>

function KillCandidateDetails({ title, candidate }: { title: string; candidate?: KillCandidate | null }) {
  const formation = [...(candidate?.formation ?? [])].sort((a, b) => a.position.localeCompare(b.position))
  const loadouts = new Map<string, { primary?: unknown; secondary?: unknown; tertiary?: unknown }>()
  for (const [ship, value] of Object.entries(candidate?.ship_loadouts ?? {})) {
    loadouts.set(shipSelectorToId(ship) || ship, {
      primary: value.primary,
      secondary: value.secondary,
      tertiary: value.tertiary_mods ?? value.tertiary,
    })
  }
  for (const entry of formation) {
    const ship = shipSelectorToId(entry.ship) || entry.ship
    if (!loadouts.has(ship))
      loadouts.set(ship, { primary: entry.primary_mod, secondary: entry.secondary_mod, tertiary: entry.tertiary_mods })
  }
  const modText = (value: unknown) =>
    value === null || value === undefined || value === '' ? '无' : modDisplayName(String(value))
  return (
    <details>
      <summary>
        {title}：完整击杀 {candidate?.refined_battles_to_kill ?? '—'} 场 · 总成本{' '}
        {candidate?.refined_total_kill_fr ?? '—'} FR
      </summary>
      {formation.length ? (
        <div className="best-grid">
          <section>
            <h3>阵型</h3>
            <p>{formation.map(entry => `${entry.position} ${shipDisplayName(entry.ship, false)}`).join('、') || '—'}</p>
          </section>
          <section>
            <h3>装配</h3>
            {loadouts.size ? (
              <div className="best-loadouts">
                {[...loadouts.entries()].map(([ship, loadout]) => (
                  <div key={ship}>
                    <strong>{shipDisplayName(ship, false)}</strong>
                    <p>
                      Primary：{modText(loadout.primary)} · Secondary：{modText(loadout.secondary)}
                    </p>
                    {Array.isArray(loadout.tertiary) && loadout.tertiary.length ? (
                      <p>Tertiary：{loadout.tertiary.map(modText).join('、')}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p>—</p>
            )}
          </section>
        </div>
      ) : (
        <p>尚无完整击杀候选。</p>
      )}
    </details>
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

function LockedNotice({ node, label, kind = '搜索' }: { node: string; label: string; kind?: '搜索' | '重跑' }) {
  return (
    <p className="lock-notice" role="status">
      {label}正在被 {node} {kind}任务使用，任务结束后可编辑。
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
  common,
  optimizer,
  onChange,
}: {
  config: NodeConfig
  common: CommonConfig | null
  optimizer: OptimizerConfig | null
  onChange: (n: NodeConfig) => void
}) {
  const columns = formationColumns(config.formation_columns)
  const [columnError, setColumnError] = useState('')
  const counts = common ? effectiveShipCounts(config, common) : config.player_state.ships
  const available = new Set(
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([ship]) => ship),
  )
  const searchable = new Set(optimizer?.ship_types ?? SHIP_TYPES.map(item => item.id))
  const selected = new Set(Object.values(config.baseline.formation).map(shipSelectorToId))
  const options = SHIP_TYPES.filter(
    item => (available.has(item.id) && searchable.has(item.id)) || selected.has(item.id),
  )
  const update = (position: string, ship: ShipId | '') => {
    const previous = config.baseline.formation[position]
    const numeric = Object.values(config.baseline.formation).some(
      value => typeof value === 'number' || (typeof value === 'string' && /^[0-5]$/.test(value.trim())),
    )
    onChange({
      ...config,
      baseline: {
        ...config.baseline,
        formation: {
          ...config.baseline.formation,
          [position]: preserveShipSelectorFormat(previous, ship),
        },
        loadouts:
          ship && !Object.hasOwn(config.baseline.loadouts, ship)
            ? {
                ...config.baseline.loadouts,
                [ship]: { primary: numeric ? 0 : null, secondary: numeric ? 0 : null },
              }
            : config.baseline.loadouts,
      },
    })
  }
  const updateColumns = (next: number) => {
    const occupied = Object.entries(config.baseline.formation)
      .filter(([position, ship]) => shipSelectorToId(ship) && !validFormationPosition(position, next))
      .map(([position]) => position)
    if (occupied.length) {
      setColumnError(`请先清空 ${occupied.join('、')}，再缩小到 ${next} 列。`)
      return
    }
    setColumnError('')
    onChange({ ...config, formation_columns: next })
  }
  return (
    <section className="config-section">
      <div className="section-heading">
        <div>
          <h3>阵型</h3>
          <p>每列五格；数字与英文格式会按原配置保留。</p>
        </div>
        <label>
          阵型列数
          <select aria-label="阵型列数" value={columns} onChange={event => updateColumns(Number(event.target.value))}>
            {Array.from({ length: MAX_FORMATION_COLUMNS }, (_, index) => index + 1).map(count => (
              <option value={count} key={count}>
                {count} 列
              </option>
            ))}
          </select>
        </label>
      </div>
      {columnError ? <p role="alert">{columnError}</p> : null}
      <div className="formation-board">
        {formationColumnLabels(columns).map(column => (
          <div className="formation-row" key={column}>
            <strong>{column} 列</strong>
            <div className="formation-slots">
              {FORMATION_ROWS.map(row => {
                const position = `${column}${row}`
                const raw = config.baseline.formation[position]
                return (
                  <label className="formation-slot" key={position}>
                    <span>{position}</span>
                    <SmartSelect
                      label={`${position} 舰种`}
                      value={shipSelectorToId(raw)}
                      onChange={value => update(position, value as ShipId | '')}
                      options={[
                        { value: '', label: '空位' },
                        ...options.map(ship => ({
                          value: ship.id,
                          label: `${ship.name} · ${ship.id} · ${ship.numeric}`,
                        })),
                      ]}
                    />
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
    <SmartSelect
      label={label}
      value={resolved ?? ''}
      onChange={value => onChange(value || null)}
      searchable
      options={[
        ...(allowsNone ? [{ value: '', label: '无' }] : []),
        ...concrete.map(id => ({ value: id, label: modDisplayName(id, true) })),
        ...(resolved && !concrete.includes(resolved) ? [{ value: resolved, label: `不兼容：${resolved}` }] : []),
      ]}
    />
  )
}

function CommonEditor({ config, onChange }: { config: CommonConfig; onChange: (value: CommonConfig) => void }) {
  const update = (group: 'permanent' | 'temporary', field: 'damage_scale' | 'health_scale', value: string) =>
    onChange({ ...config, [group]: { ...config[group], [field]: Number(value) } })
  const updateShip = (ship: string, value: string) =>
    onChange({
      ...config,
      ships: { ...config.ships, [ship]: Math.max(0, Math.trunc(Number(value))) },
    })
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
      <div className="section-heading">
        <div>
          <h3>公共舰船数量</h3>
          <p>本 Galaxy 所有节点共用；节点的额外数量会与此相加。</p>
        </div>
      </div>
      <div className="fleet-ship-grid">
        {SHIP_TYPES.map(ship => (
          <Label text={ship.name} key={ship.id}>
            <input
              aria-label={`common.ships.${ship.id}`}
              type="number"
              min="0"
              step="1"
              value={config.ships?.[ship.id] ?? 0}
              onChange={event => updateShip(ship.id, event.target.value)}
            />
          </Label>
        ))}
      </div>
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
            <SmartSelect
              label="部署模式"
              value={config.mode}
              onChange={value => onChange({ ...config, mode: value })}
              options={[
                { value: 'realistic', label: '真实部署（realistic）' },
                { value: 'practice', label: '练习（practice）' },
              ]}
            />
          </Label>
          <Label text="舰队总组数上限">
            <input
              type="number"
              min="1"
              value={config.max_total_groups}
              onChange={event => updateNumber('max_total_groups', event.target.value)}
            />
          </Label>
          <p>实际可部署组数上限取节点阵型格子数（每列 5 格）与公共组数上限中的较小值。</p>
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

function TargetUsedFrSetting({
  value,
  disabled,
  onChange,
}: {
  value: number | null | undefined
  disabled: boolean
  onChange: (value: number | undefined) => void
}) {
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  return (
    <Label text="普通战目标 Used FR（可选）">
      <input
        aria-label="普通战目标 Used FR（可选）"
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        placeholder="留空则用完整预算"
        onChange={event => {
          const next = event.target.value
          if (!/^\d*(?:\.\d*)?$/.test(next)) return
          setDraft(next)
          if (next === '') onChange(undefined)
          else if (/^\d+(?:\.\d+)?$/.test(next)) onChange(Number(next))
        }}
        onBlur={() => setDraft(String(value ?? ''))}
      />
    </Label>
  )
}

function SearchSettings({ config, onChange }: { config: SearchConfig; onChange: (value: SearchConfig) => void }) {
  const update = <K extends keyof SearchConfig>(field: K, value: SearchConfig[K]) =>
    onChange({ ...config, [field]: value })
  return (
    <div className="search-settings">
      <div className="settings-group">
        <h3>常用</h3>
        <Label text="搜索策略">
          <SmartSelect
            label="搜索策略"
            value={config.strategy ?? 'portfolio'}
            onChange={value =>
              onChange({
                ...config,
                strategy: value === 'portfolio' ? undefined : (value as SearchConfig['strategy']),
                profile: value === 'advisor_seeded' && config.profile === 'exhaustive' ? 'fast' : config.profile,
              })
            }
            options={[
              { value: 'portfolio', label: '常规优化' },
              { value: 'advisor_seeded', label: '推荐舰队搜站位' },
            ]}
          />
        </Label>
        <p className="setting-help">
          {config.strategy === 'advisor_seeded'
            ? '将游戏推荐的舰种、数量和 Mods 填入节点 Baseline；只搜索站位，起始站位可以战败。未找到胜利时不能覆盖配置。'
            : '搜索舰队组合、Mods 和站位；Baseline 用作当前方案。'}
        </p>
        <Label text="搜索方式">
          <SmartSelect
            label="搜索方式"
            value={config.profile}
            onChange={value =>
              onChange({
                ...config,
                profile: value as SearchConfig['profile'],
                strategy: value === 'exhaustive' ? undefined : config.strategy,
              })
            }
            options={[
              { value: 'fast', label: '日常搜索' },
              { value: 'balanced', label: '扩大探索' },
              ...(config.strategy === 'advisor_seeded' ? [] : [{ value: 'exhaustive', label: '遍历搜索' }]),
            ]}
          />
        </Label>
        <p className="setting-help">
          {config.profile === 'fast'
            ? config.strategy === 'advisor_seeded'
              ? '在时间或模拟次数预算内搜索推荐舰队的站位。'
              : '全局探索约占四分之一，其余尝试改进已有候选。'
            : config.profile === 'balanced'
              ? config.strategy === 'advisor_seeded'
                ? '为推荐舰队的站位搜索提供更宽的探索预算。'
                : '全局探索约占四成，会尝试更多不同舰队组合。'
              : '按配置空间逐项搜索；只有全部完成时才可称为穷举结果。'}
        </p>
        <div className="budget-group">
          <div>
            <strong>搜索预算</strong>
            <p>时间与模拟次数共同限制本次搜索；先达到限制时进入收尾，当前战斗可能继续完成。</p>
          </div>
          <div className="numeric-settings">
            <Label text="最长时间（秒）">
              <input
                aria-label="最长时间（秒）"
                type="number"
                min="1"
                value={config.max_wall_seconds}
                onChange={event => update('max_wall_seconds', Number(event.target.value))}
              />
            </Label>
            <Label text="最多模拟（次）">
              <input
                aria-label="最多模拟（次）"
                type="number"
                min="1"
                step="1"
                value={config.max_simulations}
                onChange={event => update('max_simulations', Number(event.target.value))}
              />
            </Label>
          </div>
        </div>
      </div>
      <details className="settings-advanced">
        <summary>高级设置</summary>
        <div className="settings-group">
          <Label text="并行进程">
            <input
              aria-label="并行进程"
              type="number"
              min="1"
              max="4"
              step="1"
              value={config.workers}
              onChange={event => update('workers', Number(event.target.value))}
            />
          </Label>
          <p className="setting-help">
            同时运行的 Godot Worker 数（1–4）。启动失败时会回退到单进程；并行数不保证等比提速。
          </p>
          <Label text="模拟时钟">
            <SmartSelect
              label="模拟时钟"
              value={config.simulation_clock}
              onChange={value => update('simulation_clock', value as SearchConfig['simulation_clock'])}
              options={[
                { value: 'offline_fixed_step', label: '固定 60Hz 物理步进' },
                { value: 'realtime', label: '实时同步（对照 / 调试）' },
              ]}
            />
          </Label>
          <p className="setting-help">
            固定步进不等待现实时间推进物理帧；实时同步用于对照。这个选择独立于搜索方式，并会传到 Godot 启动参数。
          </p>
          <Label text="优化目标">
            <SmartSelect
              label="优化目标"
              value={config.goal}
              onChange={value => update('goal', value as SearchConfig['goal'])}
              options={[
                { value: 'best', label: goalName('best') },
                { value: 'beat_baseline', label: goalName('beat_baseline') },
              ]}
            />
          </Label>
          <p className="setting-help">
            当前 v3 仍会搜索到预算结束，并按 Best Found 推荐；“必须优于当前方案”仅记录在任务中，不改变 v3 推荐。旧版 v2
            才会在没有严格改善时保留 Baseline。
          </p>
        </div>
      </details>
    </div>
  )
}
