/**
 * Media & Full-Track Audio Resolution Service.
 * Combines:
 * - Backend MusicFab-style RapidAPI / Proxy audio resolver (/api/audio/resolve & /api/audio/config)
 * - Apple iTunes Search fallback for cover art & 30s previews
 * - Bounded LRU in-memory cache + in-flight request deduplication + concurrency queue
 */

import { api, BASE_URL } from './client.js'

const mediaCache = new Map()
const inFlightRequests = new Map()
const audioResolveCache = new Map()
const inFlightAudioResolves = new Map()
const MAX_CACHE_SIZE = 400
const MAX_CONCURRENT = 4

let activeCount = 0
const waitQueue = []
let cachedResolverConfig = null

function acquireSlot() {
  if (activeCount < MAX_CONCURRENT) {
    activeCount += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve)
  })
}

function releaseSlot() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift()
    next()
  } else {
    activeCount = Math.max(0, activeCount - 1)
  }
}

function toAbsoluteBackendUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return rawUrl
  return `${BASE_URL}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`
}

export function clearMediaCache() {
  mediaCache.clear()
  inFlightRequests.clear()
  audioResolveCache.clear()
  inFlightAudioResolves.clear()
  cachedResolverConfig = null
}

/**
 * Fetch non-secret backend audio resolver configuration (RapidAPI availability & mode).
 */
export async function getAudioResolverConfig({ refresh = false } = {}) {
  if (cachedResolverConfig && !refresh) return cachedResolverConfig
  try {
    const cfg = await api.get('/api/audio/config', undefined, { timeoutMs: 5000 })
    cachedResolverConfig = cfg
    return cfg
  } catch {
    return null
  }
}

/**
 * Resolve full-length audio (via backend RapidAPI chain + proxy/cache) or 30s fallback.
 */
export async function resolveTrackAudio(track, { preferFull = true, cacheLocally = true } = {}) {
  if (!track) return null
  const trackKey = [
    track.track_id || '',
    track.track_name || '',
    track.artist_name || track.artist || '',
    preferFull ? 'full' : 'prev',
  ].join('__').toLowerCase()

  if (audioResolveCache.has(trackKey)) {
    const cached = audioResolveCache.get(trackKey)
    audioResolveCache.delete(trackKey)
    audioResolveCache.set(trackKey, cached)
    return cached
  }

  if (inFlightAudioResolves.has(trackKey)) {
    return inFlightAudioResolves.get(trackKey)
  }

  const promise = (async () => {
    await acquireSlot()
    try {
      const payload = {
        track_id: track.track_id || undefined,
        spotify_uri: track.spotify_uri || undefined,
        spotify_url: track.spotify_url || undefined,
        track_name: track.track_name || undefined,
        artist_name: track.artist_name || track.artist || undefined,
        duration_ms: track.duration_ms ? Number(track.duration_ms) : undefined,
        preview_url: track.preview_url || undefined,
        prefer_full: preferFull,
        cache_locally: cacheLocally,
      }
      const res = await api.post('/api/audio/resolve', payload, { timeoutMs: 35000 })
      if (!res || !res.stream_url) return null

      const normalized = {
        ...res,
        stream_url: toAbsoluteBackendUrl(res.stream_url),
        local_audio_url: toAbsoluteBackendUrl(res.local_audio_url),
      }
      if (audioResolveCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = audioResolveCache.keys().next().value
        if (oldestKey !== undefined) audioResolveCache.delete(oldestKey)
      }
      audioResolveCache.set(trackKey, normalized)
      return normalized
    } catch {
      return null
    } finally {
      releaseSlot()
      inFlightAudioResolves.delete(trackKey)
    }
  })()

  inFlightAudioResolves.set(trackKey, promise)
  return promise
}

export async function fetchTrackMedia(trackName, artist) {
  if (!trackName) {
    return { preview_url: null, album_cover_url: null }
  }

  const cleanTrack = String(trackName).trim()
  const cleanArtist = artist ? String(artist).trim() : ''
  const key = `${cleanTrack}__${cleanArtist}`.toLowerCase()

  // True LRU hit: refresh key order
  if (mediaCache.has(key)) {
    const cached = mediaCache.get(key)
    mediaCache.delete(key)
    mediaCache.set(key, cached)
    return cached
  }

  // Deduplicate concurrent identical requests
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key)
  }

  const requestPromise = (async () => {
    await acquireSlot()
    const result = { preview_url: null, album_cover_url: null }

    try {
      const term = encodeURIComponent(`${cleanTrack} ${cleanArtist}`.trim())
      const res = await fetch(
        `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=1`,
        { headers: { Accept: 'application/json' } }
      )

      if (res.ok) {
        const data = await res.json()
        const hit = data?.results?.[0]
        if (hit) {
          result.preview_url = hit.previewUrl ?? null
          result.album_cover_url = hit.artworkUrl100
            ? hit.artworkUrl100.replace('100x100bb', '300x300bb')
            : null
        }
      }
    } catch {
      // Network failure or offline mode: gracefully return nulls
    } finally {
      releaseSlot()
      inFlightRequests.delete(key)
    }

    if (mediaCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = mediaCache.keys().next().value
      if (oldestKey !== undefined) mediaCache.delete(oldestKey)
    }

    mediaCache.set(key, result)
    return result
  })()

  inFlightRequests.set(key, requestPromise)
  return requestPromise
}
