import React, { useEffect, useState, useCallback } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { fetchHealth } from '../api/client'
import { usePolling } from '../hooks/usePolling'

const NAV_ITEMS = [
  { to: '/', label: 'Chat Tester', icon: '💬', end: true },
  { to: '/metrics', label: 'KPI Dashboard', icon: '📊', end: false },
  { to: '/traces', label: 'Turn Traces', icon: '🔍', end: false },
  { to: '/session', label: 'Session Inspector', icon: '📋', end: false },
]

export default function Layout() {
  const [online, setOnline] = useState<boolean | null>(null)
  const navigate = useNavigate()

  const checkHealth = useCallback(async () => {
    try {
      await fetchHealth()
      setOnline(true)
    } catch {
      setOnline(false)
    }
  }, [])

  useEffect(() => { checkHealth() }, [checkHealth])
  usePolling(checkHealth, 10_000)

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      {/* Sidebar */}
      <aside className="flex flex-col w-56 shrink-0 bg-gray-900 border-r border-gray-800">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-gray-800">
          <div className="text-sm font-bold text-white tracking-wide">SuccessVan</div>
          <div className="text-xs text-gray-500 mt-0.5">Agent Dashboard</div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV_ITEMS.map(({ to, label, icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white font-medium'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
                }`
              }
            >
              <span>{icon}</span>
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Status indicator */}
        <div className="px-4 py-3 border-t border-gray-800">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                online === null ? 'bg-gray-500' : online ? 'bg-green-400' : 'bg-red-400'
              }`}
            />
            <span className="text-xs text-gray-500">
              {online === null ? 'Checking…' : online ? 'Backend online' : 'Backend offline'}
            </span>
          </div>
          <div className="text-xs text-gray-700 mt-0.5">:4010</div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Offline banner */}
        {online === false && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-red-900/60 border-b border-red-800 text-red-200 text-sm shrink-0">
            <span className="text-red-400">⚠</span>
            <span>Backend offline — all API calls will fail. Is the server running at <code className="text-red-300">http://localhost:4010</code>?</span>
            <button
              onClick={checkHealth}
              className="ml-auto text-xs bg-red-800 hover:bg-red-700 px-2 py-1 rounded"
            >
              Retry
            </button>
          </div>
        )}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

// ── Reusable CollapsibleCard ────────────────────────────────────────────────

interface CollapsibleCardProps {
  title: string
  badge?: React.ReactNode
  layer?: string
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
}

export function CollapsibleCard({
  title,
  badge,
  layer,
  defaultOpen = true,
  children,
  className = '',
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`bg-gray-900 rounded-lg border border-gray-800 overflow-hidden ${className}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-200">{title}</span>
          {layer && <span className="text-xs text-gray-600 font-mono">{layer}</span>}
          {badge}
        </div>
        <span className="text-gray-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

// ── Stat Card ───────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  accent?: 'default' | 'red' | 'yellow' | 'green'
}

export function StatCard({ label, value, sub, accent = 'default' }: StatCardProps) {
  const accentColor = {
    default: 'text-white',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    green: 'text-green-400',
  }[accent]

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 px-4 py-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${accentColor}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Section Heading ─────────────────────────────────────────────────────────

export function SectionHeading({ title, layer }: { title: string; layer?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-3">
      <h2 className="text-sm font-bold text-gray-200">{title}</h2>
      {layer && (
        <span className="text-xs text-gray-600 font-mono">{layer}</span>
      )}
    </div>
  )
}
