import { useEffect, useState } from 'react'
import type { GalaxyRerunNode, GalaxyRerunProgress } from '../shared/contracts'
import { runErrorSummary } from '../shared/run-errors'

const statusLabel = {
  queued: '○ 等待',
  running: '→ 搜索中',
  succeeded: '✓ 完成',
  failed: '✕ 失败',
  canceled: '■ 已停止',
} as const

function elapsed(start?: string, end?: string, now = Date.now()) {
  if (!start) return '—'
  const milliseconds = (end ? Date.parse(end) : now) - Date.parse(start)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  const seconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function GalaxyRerunPanel({
  progress,
  onOpen,
}: {
  progress: GalaxyRerunProgress
  onOpen: (node: GalaxyRerunNode) => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (progress.status !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [progress.status])
  const changed = progress.nodes.filter(node => node.status === 'succeeded' && node.changed)
  const failed = progress.nodes.filter(node => node.status === 'failed')
  const canceled = progress.nodes.filter(node => node.status === 'canceled')
  const unchanged = progress.nodes.filter(node => node.status === 'succeeded' && !node.changed).length
  return (
    <section className="panel galaxy-rerun" aria-label="Galaxy 全局重跑">
      <div className="rerun-heading">
        <div>
          <h2>{progress.galaxy.toUpperCase()} 全局重跑</h2>
          <p>
            {progress.completed} / {progress.total} · 总耗时 {elapsed(progress.startedAt, progress.finishedAt, now)}
            {progress.currentNode ? ` · 当前 ${progress.currentNode}` : ''}
          </p>
        </div>
        <span className={`run-state ${progress.status}`}>{progress.status === 'running' ? '运行中' : '已完成'}</span>
      </div>
      {progress.status === 'running' ? (
        <div className="rerun-nodes">
          {progress.nodes.map(node => (
            <div className={`rerun-node ${node.status}`} key={node.node}>
              <strong>{node.node}</strong>
              <span>{statusLabel[node.status]}</span>
              <span>{elapsed(node.startedAt, node.finishedAt, now)}</span>
              {node.error ? <small>{runErrorSummary(node.error, node.status === 'canceled')}</small> : null}
            </div>
          ))}
        </div>
      ) : (
        <>
          <p className="rerun-summary">
            发现 {changed.length} 个配置变化；{unchanged} 个节点配置不变，已从结果列表过滤；{failed.length} 个失败；
            {canceled.length} 个已停止。
          </p>
          <h3>需要重新配置的节点</h3>
          {changed.length ? (
            <div className="changed-nodes">
              {changed.map(node => (
                <button key={node.node} onClick={() => onOpen(node)}>
                  <strong>{node.node}</strong>
                  <span>查看 Baseline / Best Found / Diff</span>
                  <small>耗时 {elapsed(node.startedAt, node.finishedAt)}</small>
                </button>
              ))}
            </div>
          ) : (
            <p>没有发现 Formation / Loadout 变化。</p>
          )}
          {failed.length ? (
            <>
              <h3>失败节点</h3>
              <div className="failed-nodes">
                {failed.map(node => (
                  <div key={node.node}>
                    <strong>{node.node}</strong>
                    <span>
                      {runErrorSummary(node.error)}{' '}
                      <details>
                        <summary>查看详情</summary>
                        <pre>{node.error}</pre>
                      </details>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {canceled.length ? <p>已停止：{canceled.map(node => node.node).join('、')}</p> : null}
        </>
      )}
    </section>
  )
}
