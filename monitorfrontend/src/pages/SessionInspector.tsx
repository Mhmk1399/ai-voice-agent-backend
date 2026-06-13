import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { fetchSession } from '../api/client'
import type { SessionResponse, BookingDraft } from '../types/api'

// ── Constants ─────────────────────────────────────────────────────────────────

// These must match the WorkflowStep type in src/workflow/workflow.types.ts
const WORKFLOW_STEPS = [
  'greeting',
  'collect_office',
  'collect_category',
  'collect_pickup_datetime',
  'collect_return_datetime',
  'collect_driver_age',
  'resolve_ambiguity',
  'price_preview',
  'confirmation',
  'ready_for_reservation',
  'human_handoff',
  'completed',
]

// ── Sub-components ────────────────────────────────────────────────────────────

function WorkflowProgress({ currentStep }: { currentStep: string }) {
  const currentIdx = WORKFLOW_STEPS.indexOf(currentStep)

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Workflow Progress</h3>
        <span className="text-xs font-mono text-blue-300 bg-blue-900/30 border border-blue-800/40 rounded px-2 py-0.5">
          {currentStep}
        </span>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {WORKFLOW_STEPS.map((step, i) => {
          const isDone = currentIdx !== -1 && i < currentIdx
          const isCurrent = step === currentStep || (currentIdx === -1 && i === 0)
          return (
            <React.Fragment key={step}>
              <div
                className={`flex flex-col items-center gap-1 ${isCurrent ? 'opacity-100' : isDone ? 'opacity-100' : 'opacity-30'}`}
              >
                <div
                  className={`w-3 h-3 rounded-full border-2 ${
                    isCurrent
                      ? 'bg-blue-500 border-blue-400'
                      : isDone
                      ? 'bg-green-500 border-green-400'
                      : 'bg-gray-700 border-gray-600'
                  }`}
                />
                <div className={`text-xs font-mono leading-tight text-center ${
                  isCurrent ? 'text-blue-300' : isDone ? 'text-green-400' : 'text-gray-600'
                }`} style={{ fontSize: '9px', maxWidth: 60, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {step}
                </div>
              </div>
              {i < WORKFLOW_STEPS.length - 1 && (
                <div className={`h-0.5 w-4 mb-4 ${isDone ? 'bg-green-700' : 'bg-gray-700'}`} />
              )}
            </React.Fragment>
          )
        })}
      </div>
    </div>
  )
}

function DraftView({ draft }: { draft: BookingDraft }) {
  const fieldGroups = [
    {
      title: 'Location & Vehicle',
      fields: [
        ['Office', draft.officeName ?? draft.officeId],
        ['Category', draft.categoryName ?? draft.categoryId],
        ['Gear', draft.selectedGear],
      ],
    },
    {
      title: 'Dates',
      fields: [
        ['Pickup', draft.pickupDateText],
        ['Return', draft.returnDateText],
        ['Pickup ISO', draft.pickupDateISO],
        ['Return ISO', draft.returnDateISO],
      ],
    },
    {
      title: 'Customer',
      fields: [
        ['Name', draft.customerName],
        ['Phone', draft.customerPhone],
        ['Driver Age', draft.driverAge],
      ],
    },
    {
      title: 'Status',
      fields: [
        ['Confirmed', draft.confirmed === undefined ? undefined : String(draft.confirmed)],
        ['Ready', draft.readyForReservation === undefined ? undefined : String(draft.readyForReservation)],
        ['Created', draft.createdAt],
        ['Updated', draft.updatedAt],
      ],
    },
  ]

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-4">Booking Draft</h3>

      {draft.ambiguity && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded p-3 mb-4">
          <div className="text-xs font-semibold text-yellow-400">Ambiguity: {draft.ambiguity.type}</div>
          <div className="text-xs text-yellow-300 mt-1">{draft.ambiguity.message}</div>
          {draft.ambiguity.options.length > 0 && (
            <div className="text-xs text-yellow-200 mt-1">
              Options: {draft.ambiguity.options.join(', ')}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {fieldGroups.map(group => (
          <div key={group.title}>
            <div className="text-xs text-gray-600 font-medium mb-2 uppercase tracking-wide">{group.title}</div>
            <div className="space-y-1">
              {group.fields.map(([label, val]) => (
                <div key={label as string} className="flex items-start gap-2">
                  <span className="text-xs text-gray-600 w-24 shrink-0">{label}:</span>
                  <span className={`text-xs font-mono ${val !== undefined && val !== '' ? 'text-green-400' : 'text-gray-700'}`}>
                    {val !== undefined && val !== '' ? String(val) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {draft.pricePreview && (
        <div className="mt-4 bg-blue-900/30 border border-blue-700/50 rounded p-4">
          <div className="text-xs font-semibold text-blue-400 mb-2">Price Preview</div>
          <div className="text-3xl font-bold text-white mb-2">
            £{draft.pricePreview.totalPrice.toFixed(2)}
          </div>
          <div className="text-xs text-gray-400 space-y-1">
            <div>{draft.pricePreview.days} day{draft.pricePreview.days !== 1 ? 's' : ''} × £{draft.pricePreview.pricePerDay}/day</div>
            {draft.pricePreview.extraHours > 0 && (
              <div>+{draft.pricePreview.extraHours} extra hours</div>
            )}
            <div className="text-gray-500 italic">{draft.pricePreview.explanation}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function Transcript({ messages }: { messages: SessionResponse['transcript'] }) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-4">
        Transcript ({messages.length} messages)
      </h3>
      <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className="text-xs text-gray-600">No messages</div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
                <div
                  className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-100'
                  }`}
                >
                  {msg.content}
                </div>
                <div className="text-xs text-gray-700 px-1">
                  {msg.role} · {new Date(msg.timestamp).toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function SessionInspector() {
  const { sessionId: paramId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const [inputId, setInputId] = useState(paramId ?? '')
  const [data, setData] = useState<SessionResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    if (!id.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetchSession(id.trim())
      setData(res)
      navigate(`/session/${encodeURIComponent(id.trim())}`, { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load session')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [navigate])

  // Load from URL param on mount
  useEffect(() => {
    if (paramId) {
      setInputId(paramId)
      load(paramId)
    }
  }, [paramId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    load(inputId)
  }

  return (
    <div className="p-5">
      <h1 className="text-lg font-bold text-white mb-4">Session Inspector</h1>

      {/* Session ID input */}
      <form onSubmit={handleSubmit} className="flex gap-2 mb-5">
        <input
          type="text"
          value={inputId}
          onChange={e => setInputId(e.target.value)}
          placeholder="Paste a session ID…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-600"
        />
        <button
          type="submit"
          disabled={loading || !inputId.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          {loading ? 'Loading…' : 'Inspect'}
        </button>
      </form>

      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-300 mb-4">
          {error}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="text-sm text-gray-600 text-center py-12">
          Enter a session ID above, or click a session link from the Traces page
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {/* Header */}
          <div className="bg-gray-900 rounded-lg border border-gray-800 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-500">Session ID</div>
                <div className="font-mono text-sm text-gray-200">{data.sessionId}</div>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div>
                  <span className="text-gray-500">Turn Count: </span>
                  <span className="text-white font-bold">{data.turnCount}</span>
                </div>
                {data.draft.confirmed && (
                  <span className="bg-green-900/40 border border-green-700/40 text-green-300 px-2 py-1 rounded text-xs font-medium">
                    CONFIRMED
                  </span>
                )}
                {data.draft.readyForReservation && !data.draft.confirmed && (
                  <span className="bg-yellow-900/40 border border-yellow-700/40 text-yellow-300 px-2 py-1 rounded text-xs font-medium">
                    READY
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Workflow progress */}
          <WorkflowProgress currentStep={data.draft.sessionId ? 'greeting' : 'greeting'} />

          {/* Missing fields */}
          {/* We infer missing fields from the draft */}
          {(() => {
            const d = data.draft
            const missing: string[] = []
            if (!d.officeId && !d.officeName) missing.push('office')
            if (!d.categoryId && !d.categoryName) missing.push('category')
            if (!d.pickupDateISO) missing.push('pickup_date')
            if (!d.returnDateISO) missing.push('return_date')
            if (!d.driverAge) missing.push('driver_age')
            if (!d.selectedGear) missing.push('gear')
            if (!d.customerPhone) missing.push('phone')
            if (!d.customerName) missing.push('name')
            return missing.length > 0 ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-gray-500">Missing:</span>
                {missing.map(f => (
                  <span key={f} className="text-xs bg-red-900/40 text-red-300 border border-red-800/40 rounded px-1.5 py-0.5">
                    {f}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs text-green-400 flex items-center gap-1">
                ✓ All fields collected
              </div>
            )
          })()}

          {/* Draft */}
          <DraftView draft={data.draft} />

          {/* Transcript */}
          <Transcript messages={data.transcript} />
        </div>
      )}
    </div>
  )
}
