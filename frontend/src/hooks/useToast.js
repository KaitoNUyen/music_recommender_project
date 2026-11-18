import { useContext } from 'react'
import { ToastContext } from '../context/contexts.js'

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context.toast
}

export function useToastList() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToastList must be used within a ToastProvider')
  }
  return { toasts: context.toasts, removeToast: context.removeToast }
}
