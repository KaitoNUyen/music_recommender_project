import { useState, useEffect, useCallback, useMemo } from 'react'
import { useToast } from '../hooks/useToast.js'
import { PlaylistContext } from './contexts.js'

const STORAGE_KEY = 'embeat_taste_basket'

export function PlaylistProvider({ children }) {
  const toast = useToast()
  const [tasteBasket, setTasteBasket] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasteBasket))
    } catch {
      // storage quota or disabled
    }
  }, [tasteBasket])

  const addToBasket = useCallback((track) => {
    if (!track?.track_id) return
    setTasteBasket((prev) => {
      if (prev.some((t) => t.track_id === track.track_id)) {
        toast.info(`"${track.track_name || 'Bài hát'}" đã có trong Giỏ gu nhạc`)
        return prev
      }
      if (prev.length >= 15) {
        toast.warning('Giỏ gu nhạc tối đa 15 bài hát.')
        return prev
      }
      toast.success(`Đã thêm "${track.track_name || 'Bài hát'}" vào Giỏ gu nhạc`)
      return [...prev, track]
    })
  }, [toast])

  const removeFromBasket = useCallback((trackId) => {
    setTasteBasket((prev) => prev.filter((t) => t.track_id !== trackId))
  }, [])

  const clearBasket = useCallback(() => {
    setTasteBasket([])
    toast.info('Đã làm trống Giỏ gu nhạc')
  }, [toast])

  const isInBasket = useCallback((trackId) => {
    return tasteBasket.some((t) => t.track_id === trackId)
  }, [tasteBasket])

  const value = useMemo(() => ({
    tasteBasket,
    addToBasket,
    removeFromBasket,
    clearBasket,
    isInBasket,
  }), [tasteBasket, addToBasket, removeFromBasket, clearBasket, isInBasket])

  return (
    <PlaylistContext.Provider value={value}>
      {children}
    </PlaylistContext.Provider>
  )
}
