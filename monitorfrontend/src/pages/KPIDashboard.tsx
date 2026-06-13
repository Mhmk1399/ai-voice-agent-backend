import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { fetchMetrics } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { StatCard, SectionHeading, CollapsibleCard } from '../components/Layout'
import type { MetricsResponse } from '../types/api'

// ── Helpers ──────────────────────────────────────────────────────────────────

const PHASE_COLORS: Record<string, string> = {
  state_load: '#3b82f6',
  memory_read: '#8b5cf6',
  context_load: '#06b6d4',
  rule_check: '#f59e0b',
  llm: '#10b981',
  tool: '#f97316',
  guardrail: '#ef4444',
  state_save: '#6366f1',
}

function pct(num: number, denom: number) {
  if (!denom) return '0%'
  return ((num / denom) * 100).toFixed(1) + '%'
}

function fmt(n: number | undefined, decimals = 0) {
  if (n === undefined || n === null) return '—'
  return n.toFixed(decimals)
}

// Animated value ref for highlight
function useFlash(value: number) {
  const elRef = useRef<HTMLDivElement>(null)
  const prevRef = useRef(value)
  useEffect(() => {
    if (value > prevRef.current && elRef.current) {
      elRef.current.classList.remove('highlight-flash')
      void elRef.current.offsetWidth
      elRef.current.classList.add('highlight-flash')
    }
    prevRef.current = value
  }, [value])
  return elRef
}

function FlashStatCard({
  label, value, sub, accent,
}: {
  label: string
  value: number
  sub?: string
  accent?: 'default' | 'red' | 'yellow' | 'green'
}) {
  const ref = useFlash(value)
  const accentColor = {
    default: 'text-white',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    green: 'text-green-400',
  }[accent ?? 'default']

  return (
    <div ref={ref} className="bg-gray-900 rounded-lg border border-gray-800 px-4 py-3 transition-colors rounded-sm">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${accentColor}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  )
}

// Circle gauge (same as ChatTester)
function CircleGauge({ value, color, label }: { value: number; color: string; label: string }) {
  const pctVal = Math.round(value * 100)
  const r = 26
  const circ = 2 * Math.PI * r
  const offset = circ - (pctVal / 100) * circ
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative w-16 h-16 flex items-center justify-center">
        <svg width="64" height="64" className="-rotate-90">
          <circle cx="32" cy="32" r={r} stroke="#374151" strokeWidth="5" fill="none" />
          <circle
            cx="32" cy="32" r={r}
            stroke={color} strokeWidth="5" fill="none"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <span className="absolute text-xs font-bold text-white">{pctVal}%</span>
      </div>
      <div className="text-xs text-gray-400 text-center">{label}</div>
    </div>
  )
}

const DONUT_REND_LABEL = ({
  cx, cy, name, value,
}: {
  cx: number; cy: number; name: string; value: number
}) => null

// ── Main Component ────────────────────────────────────────────────────────────

export default function KPIDashboard() {
  const [data, setData] = useState<MetricsResponse | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetchMetrics()
      setData(res)
      setLastUpdated(new Date())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load metrics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  usePolling(load, 5_000)

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
        Loading metrics…
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400 text-sm">
        {error}
      </div>
    )
  }

  if (!data) return null
  const m = data.metrics

  // ── Derived data for charts ───────────────────────────────────────────────

  const latencyData = [
    { name: 'state_load', ms: 0 },
    { name: 'memory_read', ms: 0 },
    { name: 'context_load', ms: m.context.avg_context_load_latency_ms },
    { name: 'rule_check', ms: m.rules.avg_rule_check_latency_ms },
    { name: 'llm', ms: m.llm.avg_llm_latency_ms },
    { name: 'tool', ms: m.tools.avg_tool_latency_ms },
    { name: 'guardrail', ms: m.guardrails.avg_guardrail_latency_ms },
    { name: 'state_save', ms: 0 },
  ]

  const llmPieData = [
    { name: 'Success', value: m.llm.llm_success_total, fill: '#10b981' },
    { name: 'Error', value: m.llm.llm_error_total, fill: '#ef4444' },
  ]

  const toolBarData = Object.entries(m.tools.most_used_tools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, value]) => ({ name, value }))

  const rulesPieData = [
    { name: 'Hard Blocks', value: m.rules.hard_rule_blocks_total, fill: '#ef4444' },
    { name: 'Soft Warnings', value: m.rules.soft_rule_warnings_total, fill: '#f59e0b' },
  ]

  const workflowStepData = Object.entries(m.workflow.current_step_distribution)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value }))

  const guardrailBarData = [
    { name: 'invented_price', value: m.guardrails.invented_price_block_total },
    { name: 'invented_office', value: m.guardrails.invented_office_block_total },
    { name: 'invented_category', value: m.guardrails.invented_category_block_total },
    { name: 'no_confirm', value: m.guardrails.reservation_without_confirmation_block_total },
  ]

  const contextPieData = [
    { name: 'Cache Hit', value: Math.round(m.context.context_cache_hit_rate * 100), fill: '#10b981' },
    { name: 'Cache Miss', value: Math.round(m.context.context_cache_miss_rate * 100), fill: '#6b7280' },
  ]

  const ruleViolations = Object.entries(m.rules.rule_violation_by_rule_id)
    .sort((a, b) => b[1] - a[1])

  return (
    <div className="p-5 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-white">KPI Dashboard</h1>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-yellow-400">⚠ Refresh failed</span>
          )}
          <span className="text-xs text-gray-500">
            Updated: {lastUpdated?.toLocaleTimeString() ?? '—'}
          </span>
          <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">
            Auto-refresh 5s
          </span>
        </div>
      </div>

      {/* ── Customer Protection Monitor ── */}
      <section>
        <SectionHeading title="Customer Protection Monitor" />
        {/* Plain-English: shows whether the agent is behaving safely toward real customers */}
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-2">
          {/* Safety status pill */}
          {(() => {
            const totalDangers =
              m.guardrails.guardrail_blocks_total +
              m.rules.hard_rule_blocks_total +
              m.evaluation.human_handoff_recommended_total
            const isHealthy = totalDangers === 0 && m.global.error_rate < 0.05
            return (
              <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-4 ${
                isHealthy
                  ? 'bg-green-900/40 border border-green-700/50 text-green-300'
                  : 'bg-red-900/40 border border-red-700/50 text-red-300'
              }`}>
                <span className={`w-2 h-2 rounded-full ${isHealthy ? 'bg-green-400' : 'bg-red-400'}`} />
                {isHealthy ? 'Agent is operating safely' : 'Attention required — see details below'}
              </div>
            )
          })()}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Guardrail Saves */}
            <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
              <div className="text-2xl font-bold text-white mb-1">{m.guardrails.guardrail_blocks_total}</div>
              <div className="text-xs font-semibold text-gray-300">Unsafe Responses Caught</div>
              <div className="text-xs text-gray-500 mt-1 leading-relaxed">
                Times the guardrail layer rewrote or blocked a response before the customer saw it.
                Zero is ideal.
              </div>
              {m.guardrails.guardrail_blocks_total > 0 && (
                <div className="mt-2 space-y-0.5">
                  {m.guardrails.invented_price_block_total > 0 && (
                    <div className="text-xs text-red-400">• Invented price ×{m.guardrails.invented_price_block_total}</div>
                  )}
                  {m.guardrails.invented_office_block_total > 0 && (
                    <div className="text-xs text-red-400">• Wrong office ×{m.guardrails.invented_office_block_total}</div>
                  )}
                  {m.guardrails.invented_category_block_total > 0 && (
                    <div className="text-xs text-red-400">• Wrong van type ×{m.guardrails.invented_category_block_total}</div>
                  )}
                  {m.guardrails.reservation_without_confirmation_block_total > 0 && (
                    <div className="text-xs text-red-400">• Booking without confirmation ×{m.guardrails.reservation_without_confirmation_block_total}</div>
                  )}
                </div>
              )}
            </div>

            {/* Rule Violations */}
            <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
              <div className={`text-2xl font-bold mb-1 ${m.rules.hard_rule_blocks_total > 0 ? 'text-red-400' : 'text-white'}`}>
                {m.rules.hard_rule_blocks_total}
              </div>
              <div className="text-xs font-semibold text-gray-300">Hard Rule Violations</div>
              <div className="text-xs text-gray-500 mt-1 leading-relaxed">
                Times the rule engine stopped the agent from doing something forbidden.
                E.g. wrong driver age, creating a booking without asking the customer first.
              </div>
              {m.rules.soft_rule_warnings_total > 0 && (
                <div className="text-xs text-yellow-400 mt-2">
                  + {m.rules.soft_rule_warnings_total} soft warnings
                </div>
              )}
            </div>

            {/* Human Handoffs */}
            <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
              <div className={`text-2xl font-bold mb-1 ${m.evaluation.human_handoff_recommended_total > 0 ? 'text-yellow-400' : 'text-white'}`}>
                {m.evaluation.human_handoff_recommended_total}
              </div>
              <div className="text-xs font-semibold text-gray-300">Human Handoffs</div>
              <div className="text-xs text-gray-500 mt-1 leading-relaxed">
                Times the agent was unable to help the customer and recommended connecting to a real person.
                High numbers mean the agent needs improvement.
              </div>
            </div>

            {/* Overall Quality */}
            <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700/50">
              {(() => {
                const avgQuality = m.evaluation.turns_evaluated_total > 0
                  ? Math.round(((
                      m.evaluation.extraction_accuracy_score_avg +
                      m.evaluation.rule_compliance_score_avg +
                      m.evaluation.task_progress_score_avg +
                      m.evaluation.response_quality_score_avg
                    ) / 4) * 100)
                  : null
                return (
                  <>
                    <div className={`text-2xl font-bold mb-1 ${
                      avgQuality === null ? 'text-gray-600'
                      : avgQuality >= 80 ? 'text-green-400'
                      : avgQuality >= 60 ? 'text-yellow-400'
                      : 'text-red-400'
                    }`}>
                      {avgQuality !== null ? `${avgQuality}%` : '—'}
                    </div>
                    <div className="text-xs font-semibold text-gray-300">Overall Quality Score</div>
                    <div className="text-xs text-gray-500 mt-1 leading-relaxed">
                      Average across: how accurately it extracts information, follows rules, progresses the booking, and answers naturally.
                    </div>
                  </>
                )
              })()}
            </div>
          </div>
        </div>
      </section>

      {/* ── Global Health ── */}
      <section>
        <SectionHeading title="Global Health" layer="Channel Adapters" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <FlashStatCard
            label="Total Turns"
            value={m.global.total_turns}
            sub={`${pct(m.global.successful_turns, m.global.total_turns)} success`}
          />
          <FlashStatCard
            label="Active Sessions"
            value={m.global.active_sessions}
            sub={`${m.global.sessions_created} created total`}
          />
          <FlashStatCard
            label="Error Rate"
            value={parseFloat((m.global.error_rate * 100).toFixed(1))}
            sub="percent"
            accent={m.global.error_rate > 0.05 ? 'red' : 'default'}
          />
          <FlashStatCard
            label="Avg Total Latency"
            value={Math.round(m.global.avg_total_turn_latency_ms)}
            sub={`ms · p95: ${Math.round(m.global.p95_total_turn_latency_ms)}ms`}
            accent={m.global.avg_total_turn_latency_ms > 1000 ? 'yellow' : 'default'}
          />
        </div>
      </section>

      {/* ── Latency by Layer ── */}
      <section>
        <SectionHeading title="Latency by Layer" />
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={latencyData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 10 }} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} unit="ms" />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                labelStyle={{ color: '#f3f4f6', fontSize: 11 }}
                formatter={(v: number) => [`${v.toFixed(1)}ms`]}
              />
              <Bar dataKey="ms" radius={[4, 4, 0, 0]}>
                {latencyData.map((entry, i) => (
                  <Cell key={i} fill={PHASE_COLORS[entry.name] ?? '#6b7280'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Two-column sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── LLM Layer ── */}
        <CollapsibleCard title="LLM Provider" layer="LLM Provider">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="text-xs">
              <div className="text-gray-500">Calls Total</div>
              <div className="text-lg font-bold text-white">{m.llm.llm_calls_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Est. Cost</div>
              <div className="text-lg font-bold text-white">${fmt(m.llm.total_estimated_cost, 4)}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Avg Prompt Tokens</div>
              <div className="font-semibold text-gray-200">{fmt(m.llm.avg_prompt_tokens, 0)}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Avg Completion Tokens</div>
              <div className="font-semibold text-gray-200">{fmt(m.llm.avg_completion_tokens, 0)}</div>
            </div>
          </div>
          {m.llm.json_parse_failure_rate > 0 && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-2 py-1 mb-2">
              JSON parse failure rate: {(m.llm.json_parse_failure_rate * 100).toFixed(1)}%
            </div>
          )}
          <ResponsiveContainer width="100%" height={140}>
            <PieChart>
              <Pie data={llmPieData} cx="50%" cy="50%" innerRadius={35} outerRadius={55} dataKey="value" paddingAngle={2}>
                {llmPieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Pie>
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                formatter={(v: number) => [v]}
              />
              <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
            </PieChart>
          </ResponsiveContainer>
        </CollapsibleCard>

        {/* ── Tool Registry ── */}
        <CollapsibleCard title="Tool Registry" layer="Tool Registry">
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="text-xs">
              <div className="text-gray-500">Total Calls</div>
              <div className="text-lg font-bold text-white">{m.tools.tool_calls_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Success</div>
              <div className="text-lg font-bold text-green-400">{m.tools.tool_success_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Errors</div>
              <div className={`text-lg font-bold ${m.tools.tool_error_total > 0 ? 'text-red-400' : 'text-gray-600'}`}>
                {m.tools.tool_error_total}
              </div>
            </div>
          </div>
          {toolBarData.length > 0 ? (
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={toolBarData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 9 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: '#9ca3af', fontSize: 9 }} width={100} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                  formatter={(v: number) => [`${v} calls`]}
                />
                <Bar dataKey="value" fill="#f97316" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-xs text-gray-600 py-4 text-center">No tool call data yet</div>
          )}
        </CollapsibleCard>

        {/* ── Rule Engine ── */}
        <CollapsibleCard title="Rule Engine" layer="Rule Engine">
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="text-xs">
              <div className="text-gray-500">Rules Checked</div>
              <div className="text-lg font-bold text-white">{m.rules.rules_checked_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Violations</div>
              <div className={`text-lg font-bold ${m.rules.rule_violations_total > 0 ? 'text-red-400' : 'text-gray-600'}`}>
                {m.rules.rule_violations_total}
              </div>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <ResponsiveContainer width="100%" height={120}>
                <PieChart>
                  <Pie data={rulesPieData} cx="50%" cy="50%" innerRadius={25} outerRadius={45} dataKey="value" paddingAngle={2}>
                    {rulesPieData.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                    formatter={(v: number) => [v]}
                  />
                  <Legend wrapperStyle={{ fontSize: 9, color: '#9ca3af' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {ruleViolations.length > 0 && (
              <div className="flex-1 overflow-auto max-h-32">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="py-0.5 text-left text-gray-600">Rule</th>
                      <th className="py-0.5 text-right text-gray-600">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ruleViolations.map(([rule, count]) => (
                      <tr key={rule} className="border-b border-gray-800/40">
                        <td className="py-0.5 font-mono text-gray-400 text-xs">{rule}</td>
                        <td className="py-0.5 text-right text-red-400">{count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CollapsibleCard>

        {/* ── Workflow ── */}
        <CollapsibleCard title="Workflow Graph" layer="Workflow Graph">
          <div className="flex gap-4 mb-3">
            <div className="text-xs">
              <div className="text-gray-500">Completion Rate</div>
              <div className="text-lg font-bold text-white">
                {(m.workflow.workflow_completion_rate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Repeated Questions</div>
              <div className={`text-lg font-bold ${m.workflow.repeated_question_count > 0 ? 'text-yellow-400' : 'text-gray-400'}`}>
                {m.workflow.repeated_question_count}
              </div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Step Repetitions</div>
              <div className="text-lg font-bold text-gray-400">{m.workflow.step_repetition_count}</div>
            </div>
          </div>
          {workflowStepData.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(100, workflowStepData.length * 22)}>
              <BarChart data={workflowStepData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 9 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: '#9ca3af', fontSize: 9 }} width={120} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                  formatter={(v: number) => [`${v} sessions`]}
                />
                <Bar dataKey="value" fill="#06b6d4" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-xs text-gray-600 py-4 text-center">No step distribution data</div>
          )}
        </CollapsibleCard>

        {/* ── Guardrails ── */}
        <CollapsibleCard title="Guardrails" layer="Guardrails">
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="text-xs">
              <div className="text-gray-500">Total Checks</div>
              <div className="text-lg font-bold text-white">{m.guardrails.guardrail_checks_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Blocks</div>
              <div className={`text-lg font-bold ${m.guardrails.guardrail_blocks_total > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                {m.guardrails.guardrail_blocks_total}
              </div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={guardrailBarData} margin={{ top: 0, right: 8, left: 0, bottom: 4 }}>
              <XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 9 }} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 9 }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                formatter={(v: number) => [`${v} blocks`]}
              />
              <Bar dataKey="value" fill="#ef4444" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CollapsibleCard>

        {/* ── Evaluation Quality ── */}
        <CollapsibleCard title="Logs / Evaluation" layer="Logs/Evaluation">
          <div className="grid grid-cols-2 gap-4 mb-3">
            <CircleGauge value={m.evaluation.extraction_accuracy_score_avg} color="#10b981" label="Extraction" />
            <CircleGauge value={m.evaluation.rule_compliance_score_avg} color="#3b82f6" label="Rule Compliance" />
            <CircleGauge value={m.evaluation.task_progress_score_avg} color="#8b5cf6" label="Task Progress" />
            <CircleGauge value={m.evaluation.response_quality_score_avg} color="#f59e0b" label="Response Quality" />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Turns Evaluated</span>
            <span className="text-white font-bold">{m.evaluation.turns_evaluated_total}</span>
          </div>
          {m.evaluation.human_handoff_recommended_total > 0 && (
            <div className="mt-2 text-xs text-red-300 bg-red-900/20 border border-red-800/40 rounded px-2 py-1">
              Human Handoff Recommended: {m.evaluation.human_handoff_recommended_total} times
            </div>
          )}
        </CollapsibleCard>

        {/* ── Memory + Context ── */}
        <CollapsibleCard title="Memory + Context" layer="Memory · Context/RAG">
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="text-xs">
              <div className="text-gray-500">Memory Reads</div>
              <div className="font-bold text-white">{m.memory.memory_reads_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Avg Transcript</div>
              <div className="font-bold text-white">{fmt(m.memory.transcript_message_count_avg, 1)}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Pruned</div>
              <div className="font-bold text-white">{m.memory.memory_pruned_total}</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={120}>
            <PieChart>
              <Pie data={contextPieData} cx="50%" cy="50%" innerRadius={28} outerRadius={48} dataKey="value" paddingAngle={2}>
                {contextPieData.map((e, i) => <Cell key={i} fill={e.fill} />)}
              </Pie>
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}
                formatter={(v: number) => [`${v}%`]}
              />
              <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
            </PieChart>
          </ResponsiveContainer>
        </CollapsibleCard>

        {/* ── Pricing + Availability ── */}
        <CollapsibleCard title="Pricing + Availability" layer="State Manager">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="text-xs">
              <div className="text-gray-500">Pricing Calcs</div>
              <div className="text-lg font-bold text-white">{m.pricing.price_calculation_total}</div>
              <div className="text-gray-500 mt-0.5">
                {m.pricing.price_calculation_success_total} ok · {m.pricing.price_calculation_error_total} err
              </div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Tier Fallbacks</div>
              <div className="text-lg font-bold text-white">{m.pricing.pricing_tier_fallback_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Availability Checks</div>
              <div className="font-bold text-white">{m.availability.time_slot_generation_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Closed Dates</div>
              <div className="font-bold text-white">{m.availability.closed_date_detected_total}</div>
            </div>
          </div>
          {m.availability.overlap_check_not_enforced_warning_total > 0 && (
            <div className="text-xs text-orange-300 bg-orange-900/20 border border-orange-800/40 rounded px-2 py-1.5">
              ⚠ Known gap: Overlap check not enforced ×{m.availability.overlap_check_not_enforced_warning_total}
            </div>
          )}
        </CollapsibleCard>

        {/* ── State Manager ── */}
        <CollapsibleCard title="State Manager" layer="State Manager">
          <div className="grid grid-cols-2 gap-3">
            <div className="text-xs">
              <div className="text-gray-500">Sessions Loaded</div>
              <div className="text-lg font-bold text-white">{m.state.sessions_loaded_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Sessions Created</div>
              <div className="text-lg font-bold text-white">{m.state.sessions_created_total}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Avg Missing Fields</div>
              <div className="font-bold text-white">{fmt(m.state.missing_field_count_avg, 1)}</div>
            </div>
            <div className="text-xs">
              <div className="text-gray-500">Booking Completion</div>
              <div className="font-bold text-green-400">{(m.state.booking_completion_rate * 100).toFixed(1)}%</div>
            </div>
          </div>
        </CollapsibleCard>

      </div>
    </div>
  )
}
