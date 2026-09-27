import { useEffect, useState } from 'react'
import type { GalaxyRerunNode, GalaxyRerunProgress } from '../shared/contracts'
import { usedFrIntegerChange } from '../shared/formation-diff'
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

function usedFrSummary(node: GalaxyRerunNode) {
  const result = node.run?.result
  if (!result) return null
  const usedFr = usedFrIntegerChange(result.verified_baseline, result.best_result)
  if (!usedFr) return null
  const difference = usedFr.saved > 0 ? `减少 ${usedFr.saved}` : usedFr.saved < 0 ? `增加 ${-usedFr.saved}` : '变化 0'
  return `Used FR 取整：${usedFr.baselineUsed} → ${usedFr.bestUsed}（${difference}）`
}

export function GalaxyRerunPanel({
  progress,
  onOpen,
  onStopCurrent,
  onStopAll,
  onApplyAll,
  applicableCount,
  applying,
}: {
  progress: GalaxyRerunProgress
  onOpen: (node: GalaxyRerunNode) => void
  onStopCurrent: () => void
  onStopAll: () => void
  onApplyAll: () => void
  applicableCount: number
  applying: boolean
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
  const waiting = progress.nodes.filter(node => node.status === 'queued').length
  const current = progress.nodes.find(node => node.status === 'running')
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
        <div className="rerun-heading-actions">
          <span className={`run-state ${progress.status}`}>{progress.status === 'running' ? '运行中' : '已完成'}</span>
          {progress.status !== 'running' ? (
            <button className="success" onClick={onApplyAll} disabled={applying || applicableCount === 0}>
              {applying ? '正在逐个应用…' : `一键使用最优配置（${applicableCount}）`}
            </button>
          ) : null}
          {progress.status === 'running' ? (
            <>
              <button onClick={onStopCurrent}>停止当前节点</button>
              <button onClick={onStopAll}>停止整个批次</button>
            </>
          ) : null}
        </div>
      </div>
      <div className="rerun-counts" aria-label="重跑状态汇总">
        <span>
          等待 <strong>{waiting}</strong>
        </span>
        <span>
          当前 <strong>{current?.node ?? '—'}</strong>
        </span>
        <span>
          已完成 <strong>{progress.nodes.filter(node => node.status === 'succeeded').length}</strong>
        </span>
        <span>
          变化 <strong>{changed.length}</strong>
        </span>
        <span>
          失败 <strong>{failed.length}</strong>
        </span>
      </div>
      <p className="rerun-status-hint">
        有变化按本次验证的 Baseline 与 Best Found 的 Used FR 各自向下取整后比较；整数相同视为无有效变化。 结果缺少 Used
        FR 时回退比较阵型和装配。点击已结束的节点查看详情。
      </p>
      <div className="rerun-nodes" aria-label="节点重跑进度">
        {progress.nodes.map(node => {
          const usedFr = usedFrSummary(node)
          const label =
            node.status === 'succeeded'
              ? node.changed
                ? '✓ 完成 · 有变化'
                : '✓ 完成 · 无有效变化'
              : statusLabel[node.status]
          const inspectable =
            (node.status === 'succeeded' && Boolean(node.run?.result)) ||
            ((node.status === 'failed' || node.status === 'canceled') && Boolean(node.error || node.run?.error))
          const content = (
            <>
              <strong>{node.node}</strong>
              <span>{label}</span>
              <span>{elapsed(node.startedAt, node.finishedAt, now)}</span>
              {usedFr ? <small className="rerun-fr-change">{usedFr}</small> : null}
              {node.error ? <small>{runErrorSummary(node.error, node.status === 'canceled')}</small> : null}
            </>
          )
          return inspectable ? (
            <button
              type="button"
              className={`rerun-node ${node.status}${node.changed ? ' changed' : ''}`}
              key={node.node}
              onClick={() => onOpen(node)}
              aria-label={`${node.node} ${label}，查看详情`}
            >
              {content}
            </button>
          ) : (
            <div className={`rerun-node ${node.status}`} key={node.node}>
              {content}
            </div>
          )
        })}
      </div>
      <p className="rerun-summary">
        {unchanged} 个节点无有效变化，已从变化结果过滤；{canceled.length} 个已停止。
      </p>
      {changed.length || progress.status !== 'running' ? (
        <>
          <h3>发现变化的节点</h3>
          {changed.length ? (
            <div className="changed-nodes">
              {changed.map(node => (
                <button key={node.node} onClick={() => onOpen(node)}>
                  <strong>{node.node}</strong>
                  <span>查看 Best Found 结果</span>
                  <small>{usedFrSummary(node) ?? '阵型或装配有变化'}</small>
                  <small>耗时 {elapsed(node.startedAt, node.finishedAt)}</small>
                </button>
              ))}
            </div>
          ) : (
            <p>没有发现有效变化。</p>
          )}
        </>
      ) : null}
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
    </section>
  )
}
