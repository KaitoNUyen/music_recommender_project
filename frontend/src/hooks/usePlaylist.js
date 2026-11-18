import { useContext } from 'react'
import { PlaylistContext } from '../context/contexts.js'

export function usePlaylist() {
  const ctx = useContext(PlaylistContext)
  if (!ctx) {
    throw new Error('usePlaylist must be used within a PlaylistProvider')
  }
  return ctx
}
