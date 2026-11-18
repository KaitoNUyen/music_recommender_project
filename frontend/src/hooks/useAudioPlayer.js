import { useContext } from 'react'
import { AudioPlayerContext } from '../context/contexts.js'

export function useAudioPlayer() {
  const ctx = useContext(AudioPlayerContext)
  if (!ctx) {
    throw new Error('useAudioPlayer must be used within an AudioPlayerProvider')
  }
  return ctx
}
