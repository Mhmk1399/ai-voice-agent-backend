import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { fetchTraces } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import type { TurnTrace } from '../types/api'

const PHASE_COLORS: Record<string, string> = {
  stateLoadMs: '#3b82f6',
  memoryReadMs: '#8b5cf6',
  contextLoadMs: '#06b6d4',
  ruleCheckMs: '#f59e0b',
  llmMs: '#10b981',
  toolMs: '#f97316',
  guardrailMs: '#ef4444',
  stateSaveMs: '#6366f1',
}

const PHASE_LABELS: Record<string, string> = {
  stateLoadMs: 'State Load',
  memoryReadMs: 'Memory Read',
  contextLoadMs: 'Context Load',
  ruleCheckMs: 'Rule Check',
  llmMs: 'LLM',
  toolMs: 'Tools',
  guardrailMs: 'Guardrails',
  stateSaveMs: 'State Save',
}

function truncate(s: string, n = 12) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ── Drawer ────────────────────────────────────────────────────────────────────

function TraceDrawer({ trace, onClose }: { trace: TurnTrace; onClose: () => void }) {
  const navigate = useNavigate()

  const phaseData = (Object.keys(PHASE_LABELS) as (keyof typeof PHASE_LABELS)[]).map(key => ({
    name: PHASE_LABELS[key],
    value: trace.metrics[key as keyof typeof trace.metrics] as number,
    fill: PHASE_COLORS[key],
  }))

  return (
    <div
      className="fixed inset-0 z-50 flex"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div className="w-[700px] max-w-full bg-gray-900 border-l border-gray-800 overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <div>
            <div className="font-semibold text-gray-100">Turn Detail</div>
            <div className="text-xs font-mono text-gray-500 mt-0.5">{trace.turnId}</div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-xl">×</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Input / Step transition */}
          <div className="space-y-2">
            <div className="text-xs text-gray-500 font-medium">INPUT</div>
            <div className="bg-gray-800 rounded px-3 py-2 text-sm text-gray-200">"{trace.input}"</div>
            <div className="flex items-center gap-2 text-xs">
              <span className="bg-gray-800 px-2 py-0.5 rounded font-mono text-gray-300">{trace.workflowStepBefore}</span>
              <span className="text-gray-600">→</span>
              <span className="bg-blue-900/40 border border-blue-700/40 px-2 py-0.5 rounded font-mono text-blue-300">{trace.workflowStepAfter}</span>
            </div>
          </div>

          {/* Phase latencies */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">PHASE LATENCIES</div>
            <div className="text-xs text-gray-500 mb-1">
              Total: <span className="text-white font-bold">{trace.metrics.totalMs}ms</span>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={phaseData} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
                <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} unit="ms" />
                <YAxis type="category" dataKey="name" tick={{ fill: '#9ca3af', fontSize: 10 }} width={90} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                  formatter={(v: number) => [`${v}ms`]}
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {phaseData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* LLM Calls */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">LLM CALLS ({trace.llmCalls.length})</div>
            {trace.llmCalls.length === 0 ? (
              <div className="text-xs text-gray-700">None</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="py-1 text-left text-gray-600 font-medium">Model</th>
                    <th className="py-1 text-left text-gray-600 font-medium">Purpose</th>
                    <th className="py-1 text-right text-gray-600 font-medium">Prompt</th>
                    <th className="py-1 text-right text-gray-600 font-medium">Completion</th>
                    <th className="py-1 text-right text-gray-600 font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.llmCalls.map((c, i) => (
                    <tr key={i} className="border-b border-gray-800/50">
                      <td className="py-1 font-mono text-gray-400 text-xs">{c.model}</td>
                      <td className="py-1 text-gray-300">{c.purpose}</td>
                      <td className="py-1 text-right text-gray-400">{c.promptTokens}</td>
                      <td className="py-1 text-right text-gray-400">{c.completionTokens}</td>
                      <td className="py-1 text-right text-gray-400">{c.latencyMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Tool Calls */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">TOOL CALLS ({trace.toolCalls.length})</div>
            {trace.toolCalls.length === 0 ? (
              <div className="text-xs text-gray-700">None</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="py-1 text-left text-gray-600">Tool</th>
                    <th className="py-1 text-left text-gray-600">Status</th>
                    <th className="py-1 text-right text-gray-600">Latency</th>
                    <th className="py-1 text-left text-gray-600">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.toolCalls.map((t, i) => (
                    <tr key={i} className="border-b border-gray-800/50">
                      <td className="py-1 font-mono text-gray-300">{t.toolName}</td>
                      <td className="py-1">
                        {t.success
                          ? <span className="text-green-400">✓ ok</span>
                          : <span className="text-red-400">✗ err</span>}
                      </td>
                      <td className="py-1 text-right text-gray-400">{t.latencyMs}ms</td>
                      <td className="py-1 text-red-400 text-xs">{t.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Rules Checked */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">RULES CHECKED ({trace.rulesChecked.length})</div>
            {trace.rulesChecked.length === 0 ? (
              <div className="text-xs text-gray-700">None</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="py-1 text-left text-gray-600">Rule ID</th>
                    <th className="py-1 text-left text-gray-600">Severity</th>
                    <th className="py-1 text-left text-gray-600">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.rulesChecked.map((r, i) => (
                    <tr key={i} className="border-b border-gray-800/50">
                      <td className="py-1 font-mono text-gray-300">{r.ruleId}</td>
                      <td className="py-1">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                          r.severity === 'hard'
                            ? 'bg-red-900/50 text-red-300'
                            : 'bg-yellow-900/50 text-yellow-300'
                        }`}>
                          {r.severity}
                        </span>
                      </td>
                      <td className="py-1">
                        {r.passed ? <span className="text-green-400">✓</span> : <span className="text-red-400">✗</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Guardrails */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">GUARDRAILS CHECKED ({trace.guardrailsChecked.length})</div>
            {trace.guardrailsChecked.length === 0 ? (
              <div className="text-xs text-gray-700">None</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="py-1 text-left text-gray-600">Guardrail</th>
                    <th className="py-1 text-left text-gray-600">Passed</th>
                    <th className="py-1 text-left text-gray-600">Blocked</th>
                  </tr>
                </thead>
                <tbody>
                  {trace.guardrailsChecked.map((g, i) => (
                    <tr key={i} className="border-b border-gray-800/50">
                      <td className="py-1 font-mono text-gray-300">{g.guardrailId}</td>
                      <td className="py-1">
                        {g.passed ? <span className="text-green-400">✓</span> : <span className="text-red-400">✗</span>}
                      </td>
                      <td className="py-1">
                        {g.blocked && <span className="bg-red-900/50 text-red-300 px-1.5 py-0.5 rounded text-xs">BLOCKED</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Response */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">RESPONSE</div>
            <div className="bg-gray-800 rounded px-3 py-2 text-sm text-gray-200 leading-relaxed">
              {trace.response}
            </div>
          </div>

          {/* Context */}
          <div>
            <div className="text-xs text-gray-500 font-medium mb-2">CONTEXT USED</div>
            <div className="flex gap-4 text-xs">
              <div>
                <span className="text-gray-600">Offices: </span>
                <span className="text-gray-300">{trace.contextUsed.officeCount}</span>
              </div>
              <div>
                <span className="text-gray-600">Categories: </span>
                <span className="text-gray-300">{trace.contextUsed.categoryCount}</span>
              </div>
              <div>
                <span className="text-gray-600">Cache: </span>
                <span className={trace.contextUsed.cacheHit ? 'text-green-400' : 'text-gray-400'}>
                  {trace.contextUsed.cacheHit ? '✓ hit' : 'miss'}
                </span>
              </div>
            </div>
          </div>

          {/* Errors */}
          {trace.errors.length > 0 && (
            <div>
              <div className="text-xs text-red-500 font-medium mb-2">ERRORS</div>
              <ul className="space-y-1">
                {trace.errors.map((e, i) => (
                  <li key={i} className="text-xs text-red-300 bg-red-900/20 border border-red-800/40 rounded px-2 py-1">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Session link */}
          <button
            onClick={() => { navigate(`/session/${trace.sessionId}`); onClose() }}
            className="text-xs text-blue-400 hover:text-blue-300 underline"
          >
            Open Session Inspector → {trace.sessionId}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function TurnTraces() {
  const [traces, setTraces] = useState<TurnTrace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<TurnTrace | null>(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    try {
      const res = await fetchTraces()
      setTraces(res.traces)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load traces')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  usePolling(load, 5_000)

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-bold text-white">Turn Traces</h1>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-red-400">{error}</span>}
          <button
            onClick={load}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded px-3 py-1"
          >
            Refresh
          </button>
          <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">Last 20</span>
        </div>
      </div>

      {loading && traces.length === 0 ? (
        <div className="text-sm text-gray-500 text-center py-12">Loading traces…</div>
      ) : traces.length === 0 ? (
        <div className="text-sm text-gray-600 text-center py-12">
          No traces yet — send a message in Chat Tester first
        </div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-950/50">
                <th className="py-2 px-3 text-left text-gray-500 font-medium">Turn ID</th>
                <th className="py-2 px-3 text-left text-gray-500 font-medium">Session</th>
                <th className="py-2 px-3 text-left text-gray-500 font-medium">Input</th>
                <th className="py-2 px-3 text-left text-gray-500 font-medium">Step Transition</th>
                <th className="py-2 px-3 text-right text-gray-500 font-medium">Total ms</th>
                <th className="py-2 px-3 text-right text-gray-500 font-medium">LLM</th>
                <th className="py-2 px-3 text-right text-gray-500 font-medium">Tools</th>
                <th className="py-2 px-3 text-right text-gray-500 font-medium">Rules</th>
                <th className="py-2 px-3 text-right text-gray-500 font-medium">Guards</th>
                <th className="py-2 px-3 text-center text-gray-500 font-medium">Errors</th>
              </tr>
            </thead>
            <tbody>
              {traces.map(trace => {
                const rulesPassed = trace.rulesChecked.filter(r => r.passed).length
                const guardsOk = trace.guardrailsChecked.filter(g => g.passed).length

                return (
                  <tr
                    key={trace.turnId}
                    onClick={() => setSelected(trace)}
                    className="border-b border-gray-800/60 hover:bg-gray-800/40 cursor-pointer transition-colors"
                  >
                    <td className="py-2 px-3 font-mono text-gray-500">{truncate(trace.turnId, 10)}</td>
                    <td className="py-2 px-3">
                      <button
                        onClick={e => { e.stopPropagation(); navigate(`/session/${trace.sessionId}`) }}
                        className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {truncate(trace.sessionId, 10)}
                      </button>
                    </td>
                    <td className="py-2 px-3 text-gray-300 max-w-[160px] truncate">{trace.input}</td>
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-gray-500 text-xs">{truncate(trace.workflowStepBefore, 14)}</span>
                        <span className="text-gray-700">→</span>
                        <span className="font-mono text-blue-400 text-xs">{truncate(trace.workflowStepAfter, 14)}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right text-gray-300">{trace.metrics.totalMs}</td>
                    <td className="py-2 px-3 text-right text-gray-400">{trace.llmCalls.length}</td>
                    <td className="py-2 px-3 text-right text-gray-400">{trace.toolCalls.length}</td>
                    <td className="py-2 px-3 text-right">
                      <span className={rulesPassed === trace.rulesChecked.length ? 'text-green-400' : 'text-red-400'}>
                        {rulesPassed}/{trace.rulesChecked.length}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right">
                      <span className={guardsOk === trace.guardrailsChecked.length ? 'text-green-400' : 'text-red-400'}>
                        {guardsOk}/{trace.guardrailsChecked.length}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-center">
                      {trace.errors.length > 0 ? (
                        <span className="inline-block bg-red-900/60 text-red-300 rounded px-1.5 py-0.5 text-xs font-bold">
                          {trace.errors.length}
                        </span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Drawer */}
      {selected && (
        <TraceDrawer trace={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
