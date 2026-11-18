import { useState, useCallback, useMemo } from 'react'
import { ToastContext } from './contexts.js'

let toastIdCounter = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const addToast = useCallback((message, type = 'info', durationMs = 4000) => {
    const id = ++toastIdCounter
    const newToast = { id, message, type }
    setToasts((prev) => [...prev, newToast])

    if (durationMs > 0) {
      setTimeout(() => {
        removeToast(id)
      }, durationMs)
    }
    return id
  }, [removeToast])

  const toast = useMemo(() => ({
    success: (msg, dur) => addToast(msg, 'success', dur),
    error: (msg, dur) => addToast(msg, 'error', dur || 5000),
    warning: (msg, dur) => addToast(msg, 'warning', dur),
    info: (msg, dur) => addToast(msg, 'info', dur),
    remove: removeToast,
  }), [addToast, removeToast])

  return (
    <ToastContext.Provider value={{ toast, toasts, removeToast }}>
      {children}
    </ToastContext.Provider>
  )
}
