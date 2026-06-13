import { useEffect, useRef, useCallback } from 'react'

export function usePolling(callback: () => void, intervalMs: number, enabled = true) {
  const savedCallback = useRef(callback)
  useEffect(() => { savedCallback.current = callback }, [callback])

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => savedCallback.current(), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])
}

export function useHighlight(value: number) {
  const prevRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const getClass = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return
      if (value > prevRef.current) {
        el.classList.remove('highlight-flash')
        void el.offsetWidth // reflow
        el.classList.add('highlight-flash')
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => el.classList.remove('highlight-flash'), 900)
      }
      prevRef.current = value
    },
    [value],
  )

  return getClass
}
