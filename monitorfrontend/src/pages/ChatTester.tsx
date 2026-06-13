import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  RadialBarChart, RadialBar, Cell,
} from 'recharts'
import { sendTextTurn, fetchTraces } from '../api/client'
import { CollapsibleCard } from '../components/Layout'
import type { TextTurnResponse, TurnTrace, BookingDraft } from '../types/api'

// ── Constants ────────────────────────────────────────────────────────────────

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

const SCENARIO_TURNS = [
  "I want a Luton van",
  "From London office",
  "Tomorrow at 10",
  "Friday evening",
  "I am 28",
]

// ── Types ────────────────────────────────────────────────────────────────────

interface MessageMeta {
  guardrailBlocked: boolean
  hardRuleFailed: boolean
  humanHandoffRecommended: boolean
  responseQuality: number
  totalMs: number
  workflowStep: string
}

interface Message {
  id: number
  role: 'user' | 'assistant'
  content: string
  meta?: MessageMeta
}

// ── Sub-components ───────────────────────────────────────────────────────────

function BookingDraftCard({ draft }: { draft: BookingDraft }) {
  const fields: [string, string | number | boolean | undefined][] = [
    ['Office', draft.officeName ?? draft.officeId],
    ['Category', draft.categoryName ?? draft.categoryId],
    ['Pickup Date', draft.pickupDateText],
    ['Return Date', draft.returnDateText],
    ['Pickup ISO', draft.pickupDateISO],
    ['Return ISO', draft.returnDateISO],
    ['Driver Age', draft.driverAge],
    ['Gear', draft.selectedGear],
    ['Phone', draft.customerPhone],
    ['Name', draft.customerName],
    ['Confirmed', draft.confirmed === undefined ? undefined : String(draft.confirmed)],
    ['Ready', draft.readyForReservation === undefined ? undefined : String(draft.readyForReservation)],
  ]

  return (
    <div className="space-y-2">
      {draft.ambiguity && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded p-2.5 text-xs">
          <div className="font-semibold text-yellow-400 mb-1">Ambiguity: {draft.ambiguity.type}</div>
          <div className="text-yellow-300">{draft.ambiguity.message}</div>
          {draft.ambiguity.options.length > 0 && (
            <div className="mt-1 text-yellow-200">Options: {draft.ambiguity.options.join(', ')}</div>
          )}
        </div>
      )}
      <table className="w-full text-xs">
        <tbody>
          {fields.map(([label, val]) => (
            <tr key={label} className="border-b border-gray-800">
              <td className="py-1 pr-3 text-gray-500 font-medium w-28">{label}</td>
              <td className={`py-1 font-mono ${val !== undefined && val !== '' ? 'text-green-400' : 'text-gray-700'}`}>
                {val !== undefined && val !== '' ? String(val) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft.pricePreview && (
        <div className="mt-2 bg-blue-900/30 border border-blue-700/50 rounded p-3 text-xs">
          <div className="font-semibold text-blue-400 mb-1.5">Price Preview</div>
          <div className="text-2xl font-bold text-white mb-1">
            £{draft.pricePreview.totalPrice.toFixed(2)}
          </div>
          <div className="text-gray-400 space-y-0.5">
            <div>{draft.pricePreview.days} day{draft.pricePreview.days !== 1 ? 's' : ''} × £{draft.pricePreview.pricePerDay}/day</div>
            {draft.pricePreview.extraHours > 0 && <div>+{draft.pricePreview.extraHours} extra hours</div>}
            <div className="text-gray-500 italic mt-1">{draft.pricePreview.explanation}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function MetricsChart({ metrics }: { metrics: TextTurnResponse['metrics'] }) {
  const phases = Object.keys(PHASE_LABELS) as (keyof typeof PHASE_LABELS)[]
  const data = phases.map(key => ({
    name: PHASE_LABELS[key],
    value: metrics[key as keyof typeof metrics] as number,
    fill: PHASE_COLORS[key],
  }))

  return (
    <div>
      <div className="text-xs text-gray-500 mb-2">
        Total: <span className="text-white font-bold">{metrics.totalMs}ms</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 30, left: 10, bottom: 0 }}>
          <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} unit="ms" />
          <YAxis type="category" dataKey="name" tick={{ fill: '#9ca3af', fontSize: 10 }} width={80} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 6 }}
            labelStyle={{ color: '#f3f4f6', fontSize: 11 }}
            itemStyle={{ color: '#d1d5db', fontSize: 11 }}
            formatter={(v: number) => [`${v}ms`]}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function EvaluationCard({ evaluation }: { evaluation: TextTurnResponse['evaluation'] }) {
  const scores = [
    { label: 'Extraction', value: evaluation.extractionAccuracy, color: '#10b981' },
    { label: 'Rule Compliance', value: evaluation.ruleCompliance, color: '#3b82f6' },
    { label: 'Task Progress', value: evaluation.taskProgress, color: '#8b5cf6' },
    { label: 'Response Quality', value: evaluation.responseQuality, color: '#f59e0b' },
  ]

  return (
    <div className="space-y-3">
      {evaluation.humanHandoffRecommended && (
        <div className="bg-red-900/40 border border-red-700/60 rounded px-3 py-2 text-xs text-red-300 font-semibold">
          ⚠ Human handoff recommended
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {scores.map(({ label, value, color }) => (
          <div key={label} className="flex flex-col items-center gap-1">
            <CircleGauge value={value} color={color} />
            <div className="text-xs text-gray-400">{label}</div>
          </div>
        ))}
      </div>
      {evaluation.notes.length > 0 && (
        <div className="mt-2">
          <div className="text-xs text-gray-500 mb-1">Notes:</div>
          <ul className="space-y-0.5">
            {evaluation.notes.map((note, i) => (
              <li key={i} className="text-xs text-gray-300">• {note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function CircleGauge({ value, color }: { value: number; color: string }) {
  const pct = Math.round(value * 100)
  const r = 22
  const circ = 2 * Math.PI * r
  const offset = circ - (pct / 100) * circ

  return (
    <div className="relative w-14 h-14 flex items-center justify-center">
      <svg width="56" height="56" className="-rotate-90">
        <circle cx="28" cy="28" r={r} stroke="#374151" strokeWidth="5" fill="none" />
        <circle
          cx="28" cy="28" r={r}
          stroke={color} strokeWidth="5" fill="none"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-xs font-bold text-white">{pct}%</span>
    </div>
  )
}

function RulesTable({ rules }: { rules: TurnTrace['rulesChecked'] }) {
  if (rules.length === 0) return <div className="text-xs text-gray-600">No rules checked</div>
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-gray-800">
          <th className="py-1 text-left text-gray-500 font-medium">Rule ID</th>
          <th className="py-1 text-left text-gray-500 font-medium">Severity</th>
          <th className="py-1 text-left text-gray-500 font-medium">Result</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r, i) => (
          <tr key={i} className="border-b border-gray-800/50">
            <td className="py-1 font-mono text-gray-300">{r.ruleId}</td>
            <td className="py-1">
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                r.severity === 'hard' ? 'bg-red-900/50 text-red-300' : 'bg-yellow-900/50 text-yellow-300'
              }`}>
                {r.severity}
              </span>
            </td>
            <td className="py-1">
              {r.passed
                ? <span className="text-green-400">✓ pass</span>
                : <span className="text-red-400">✗ fail</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GuardrailsTable({ guardrails }: { guardrails: TurnTrace['guardrailsChecked'] }) {
  if (guardrails.length === 0) return <div className="text-xs text-gray-600">No guardrails checked</div>
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-gray-800">
          <th className="py-1 text-left text-gray-500 font-medium">Guardrail ID</th>
          <th className="py-1 text-left text-gray-500 font-medium">Passed</th>
          <th className="py-1 text-left text-gray-500 font-medium">Blocked</th>
        </tr>
      </thead>
      <tbody>
        {guardrails.map((g, i) => (
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
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

let msgCounter = 0

export default function ChatTester() {
  const [messages, setMessages] = useState<Message[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastTurn, setLastTurn] = useState<TextTurnResponse | null>(null)
  const [lastTrace, setLastTrace] = useState<TurnTrace | null>(null)
  const [scenarioRunning, setScenarioRunning] = useState(false)
  const [scenarioDiff, setScenarioDiff] = useState<{ before: BookingDraft | null; after: BookingDraft | null } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const doSend = useCallback(async (text: string, sid?: string) => {
    const trimmed = text.trim()
    if (!trimmed) return null

    const userMsg: Message = { id: ++msgCounter, role: 'user', content: trimmed }
    setMessages(prev => [...prev, userMsg])
    setIsLoading(true)
    setError(null)

    try {
      const res = await sendTextTurn(trimmed, sid ?? sessionId)
      setSessionId(res.sessionId)
      setLastTurn(res)

      // Fetch latest trace to get rules/guardrails
      let trace: TurnTrace | undefined
      try {
        const traceRes = await fetchTraces()
        if (traceRes.traces.length > 0) {
          trace = traceRes.traces[0]
          setLastTrace(trace)
        }
      } catch { /* ignore trace errors */ }

      const guardrailBlocked = trace?.guardrailsChecked.some(g => g.blocked) ?? false
      const hardRuleFailed = trace?.rulesChecked.some(r => !r.passed && r.severity === 'hard') ?? false

      const assistantMsg: Message = {
        id: ++msgCounter,
        role: 'assistant',
        content: res.reply,
        meta: {
          guardrailBlocked,
          hardRuleFailed,
          humanHandoffRecommended: res.evaluation.humanHandoffRecommended,
          responseQuality: res.evaluation.responseQuality,
          totalMs: res.metrics.totalMs,
          workflowStep: res.workflowStep,
        },
      }
      setMessages(prev => [...prev, assistantMsg])

      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      setError(msg)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [sessionId])

  const handleSend = async () => {
    const text = input
    setInput('')
    await doSend(text)
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleNewSession = () => {
    setSessionId(undefined)
    setMessages([])
    setLastTurn(null)
    setLastTrace(null)
    setScenarioDiff(null)
    setError(null)
  }

  const runScenario = async () => {
    setScenarioRunning(true)
    setScenarioDiff(null)
    handleNewSession()

    // small delay so state clears
    await new Promise(r => setTimeout(r, 100))

    const initialDraft: BookingDraft | null = null
    let currentSid: string | undefined = undefined
    let finalDraft: BookingDraft | null = null

    for (let i = 0; i < SCENARIO_TURNS.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 500))

      const userMsg: Message = { id: ++msgCounter, role: 'user', content: SCENARIO_TURNS[i] }
      setMessages(prev => [...prev, userMsg])
      setIsLoading(true)

      try {
        const res = await sendTextTurn(SCENARIO_TURNS[i], currentSid)
        currentSid = res.sessionId
        setSessionId(res.sessionId)
        setLastTurn(res)
        finalDraft = res.bookingDraft

        let traceForMsg: TurnTrace | undefined
        try {
          const traceRes = await fetchTraces()
          if (traceRes.traces.length > 0) {
            traceForMsg = traceRes.traces[0]
            setLastTrace(traceForMsg)
          }
        } catch { /* ignore */ }

        setMessages(prev => [
          ...prev,
          {
            id: ++msgCounter,
            role: 'assistant',
            content: res.reply,
            meta: {
              guardrailBlocked: traceForMsg?.guardrailsChecked.some(g => g.blocked) ?? false,
              hardRuleFailed: traceForMsg?.rulesChecked.some(r => !r.passed && r.severity === 'hard') ?? false,
              humanHandoffRecommended: res.evaluation.humanHandoffRecommended,
              responseQuality: res.evaluation.responseQuality,
              totalMs: res.metrics.totalMs,
              workflowStep: res.workflowStep,
            },
          },
        ])
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error'
        setError(msg)
        break
      } finally {
        setIsLoading(false)
      }
    }

    setScenarioDiff({ before: initialDraft, after: finalDraft })
    setScenarioRunning(false)
  }

  return (
    <div className="flex h-full">
      {/* Left pane — Conversation */}
      <div className="flex flex-col w-1/2 border-r border-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-gray-200">Chat Tester</span>
            {sessionId && (
              <span className="text-xs font-mono text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
                {sessionId.slice(0, 12)}…
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              onChange={e => { if (e.target.value === 'scenario') runScenario() }}
              disabled={scenarioRunning || isLoading}
              className="text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1"
              value=""
            >
              <option value="">Load scenario…</option>
              <option value="scenario">5-turn SuccessVan test</option>
            </select>
            <button
              onClick={handleNewSession}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded px-3 py-1 transition-colors"
            >
              New Session
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="text-xs text-gray-600 text-center py-8">
              Send a message to start testing the agent
            </div>
          )}
          {messages.map(msg => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className="flex flex-col gap-1 max-w-[80%]">
                <div
                  className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-100'
                  }`}
                >
                  {msg.content}
                </div>
                {/* Safety badges — only for assistant messages that have metadata */}
                {msg.role === 'assistant' && msg.meta && (
                  <div className="flex flex-wrap items-center gap-1.5 px-1">
                    {/* Step badge — always shown */}
                    <span className="text-xs font-mono text-blue-400 bg-blue-900/30 border border-blue-800/40 rounded px-1.5 py-0.5">
                      {msg.meta.workflowStep}
                    </span>
                    {/* Latency */}
                    <span className="text-xs text-gray-600">
                      {msg.meta.totalMs}ms
                    </span>
                    {/* Quality bar */}
                    <span className={`text-xs font-medium ${
                      msg.meta.responseQuality >= 0.8 ? 'text-green-400'
                      : msg.meta.responseQuality >= 0.6 ? 'text-yellow-400'
                      : 'text-red-400'
                    }`}>
                      Q:{Math.round(msg.meta.responseQuality * 100)}%
                    </span>
                    {/* Danger badges */}
                    {msg.meta.guardrailBlocked && (
                      <span className="text-xs font-semibold bg-orange-900/50 border border-orange-700/50 text-orange-300 rounded px-1.5 py-0.5">
                        🛡 rewritten
                      </span>
                    )}
                    {msg.meta.hardRuleFailed && (
                      <span className="text-xs font-semibold bg-red-900/50 border border-red-700/50 text-red-300 rounded px-1.5 py-0.5">
                        ⚠ rule block
                      </span>
                    )}
                    {msg.meta.humanHandoffRecommended && (
                      <span className="text-xs font-semibold bg-red-900/60 border border-red-600/60 text-red-200 rounded px-1.5 py-0.5">
                        👤 handoff recommended
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-gray-800 rounded-lg px-3 py-2">
                <span className="text-gray-400 text-sm">…</span>
              </div>
            </div>
          )}
          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-xs text-red-300">
              Error: {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-800 bg-gray-900/50 shrink-0">
          {lastTurn ? (
            <>
              <span className="text-xs bg-blue-900/50 text-blue-300 border border-blue-800/50 rounded px-2 py-0.5 font-mono">
                {lastTurn.workflowStep}
              </span>
              {lastTurn.missingFields.map(f => (
                <span key={f} className="text-xs bg-red-900/40 text-red-300 border border-red-800/40 rounded px-1.5 py-0.5">
                  {f}
                </span>
              ))}
            </>
          ) : (
            <span className="text-xs text-gray-600">No turn data yet</span>
          )}
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-gray-800 shrink-0">
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading || scenarioRunning}
              placeholder="Type a message… (Enter to send)"
              rows={2}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-600 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || scenarioRunning || !input.trim()}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors self-end"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Right pane — Turn Inspector */}
      <div className="w-1/2 overflow-y-auto">
        {!lastTurn ? (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            Turn inspector will appear after first message
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {/* Scenario Diff */}
            {scenarioDiff?.after && (
              <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
                <div className="text-sm font-semibold text-gray-200 mb-2">Scenario Result — Booking Draft</div>
                <BookingDraftCard draft={scenarioDiff.after} />
              </div>
            )}

            <CollapsibleCard title="Booking Draft">
              <BookingDraftCard draft={lastTurn.bookingDraft} />
            </CollapsibleCard>

            <CollapsibleCard title="Turn Metrics">
              <MetricsChart metrics={lastTurn.metrics} />
            </CollapsibleCard>

            <CollapsibleCard title="Tools Called">
              {lastTurn.toolCalls.length === 0 ? (
                <div className="text-xs text-gray-600">No tools called</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="py-1 text-left text-gray-500 font-medium">Tool</th>
                      <th className="py-1 text-left text-gray-500 font-medium">Status</th>
                      <th className="py-1 text-left text-gray-500 font-medium">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lastTurn.toolCalls.map((t, i) => (
                      <tr key={i} className="border-b border-gray-800/50">
                        <td className="py-1 font-mono text-gray-300">{t.tool}</td>
                        <td className="py-1">
                          {t.success
                            ? <span className="text-green-400 text-xs">✓ ok</span>
                            : <span className="text-red-400 text-xs">✗ err</span>}
                        </td>
                        <td className="py-1 text-gray-400">{t.latencyMs}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CollapsibleCard>

            <CollapsibleCard title="Evaluation Scores">
              <EvaluationCard evaluation={lastTurn.evaluation} />
            </CollapsibleCard>

            <CollapsibleCard title="Rules Checked (from trace)">
              <RulesTable rules={lastTrace?.rulesChecked ?? []} />
            </CollapsibleCard>

            <CollapsibleCard title="Guardrails Checked (from trace)">
              <GuardrailsTable guardrails={lastTrace?.guardrailsChecked ?? []} />
            </CollapsibleCard>
          </div>
        )}
      </div>
    </div>
  )
}
