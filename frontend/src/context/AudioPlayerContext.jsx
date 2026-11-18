import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { fetchTrackMedia, getAudioResolverConfig, resolveTrackAudio } from '../api/mediaApi.js'
import { isFullAudioTrack, resolvePlayableAudioUrl } from '../api/playlistApi.js'
import { useToast } from '../hooks/useToast.js'
import { AudioPlayerContext } from './contexts.js'

const DEFAULT_CROSSFADE_SECONDS = 5

function createAudioDeck() {
  const audio = new Audio()
  audio.preload = 'auto'
  audio.crossOrigin = 'anonymous'
  if ('preservesPitch' in audio) audio.preservesPitch = true
  if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true
  return audio
}

export function AudioPlayerProvider({ children }) {
  const toast = useToast()

  // Persistent Dual Decks initialized lazily outside render for React Compiler safety
  const decksRef = useRef(null)
  const getDecks = useCallback(() => {
    if (!decksRef.current) {
      decksRef.current = [createAudioDeck(), createAudioDeck()]
    }
    return decksRef.current
  }, [])

  const activeDeckRef = useRef(0)
  const audioGraphRef = useRef({
    ctx: null,
    sources: [null, null],
    filters: [null, null],
    gains: [null, null],
    compressor: null,
    masterGain: null,
    ready: false,
    disabled: false,
  })

  const [currentTrack, setCurrentTrack] = useState(null)
  const [queue, setQueue] = useState([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [queueTitle, setQueueTitle] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoadingMedia, setIsLoadingMedia] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(30)
  const [volume, setVolume] = useState(0.85)
  const [isMuted, setIsMuted] = useState(false)
  const [embedModalTrack, setEmbedModalTrack] = useState(null)
  const [audioResolverConfig, setAudioResolverConfig] = useState(null)

  // Spotify Crossfade + AI DJ Mixing states
  const [crossfadeEnabled, setCrossfadeEnabled] = useState(true)
  const [crossfadeSeconds, setCrossfadeSeconds] = useState(DEFAULT_CROSSFADE_SECONDS)
  const [autoAiMixEnabled, setAutoAiMixEnabled] = useState(true)
  const [isCrossfading, setIsCrossfading] = useState(false)
  const [crossfadeProgress, setCrossfadeProgress] = useState(0)
  const [crossfadeTargetTrack, setCrossfadeTargetTrack] = useState(null)
  const [transitionNote, setTransitionNote] = useState(null)

  // Synced refs for real-time RAF & audio callbacks
  const queueRef = useRef([])
  const currentIndexRef = useRef(-1)
  const currentTrackRef = useRef(null)
  const volumeRef = useRef(0.85)
  const isMutedRef = useRef(false)
  const crossfadeEnabledRef = useRef(true)
  const crossfadeSecondsRef = useRef(DEFAULT_CROSSFADE_SECONDS)
  const autoAiMixEnabledRef = useRef(true)

  const preResolvedUrlsRef = useRef(new Map())
  const audioResolverConfigRef = useRef(null)
  const loadingNextRef = useRef(false)
  const rateRestoreTimerRef = useRef(null)
  const noteTimeoutRef = useRef(null)
  const cfStateRef = useRef({
    active: false,
    outDeck: 0,
    inDeck: 1,
    targetIndex: -1,
    targetTrack: null,
    durationSec: DEFAULT_CROSSFADE_SECONDS,
    startTs: 0,
    pausedElapsedMs: 0,
    rafId: null,
    lastUiEmitTs: 0,
    outBaseGain: 1,
    inBaseGain: 1,
    bassSwap: false,
    inStartRate: 1,
    fromTrack: null,
  })

  useEffect(() => {
    queueRef.current = queue
  }, [queue])
  useEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])
  useEffect(() => {
    currentTrackRef.current = currentTrack
  }, [currentTrack])
  useEffect(() => {
    volumeRef.current = volume
  }, [volume])
  useEffect(() => {
    isMutedRef.current = isMuted
  }, [isMuted])
  useEffect(() => {
    crossfadeEnabledRef.current = crossfadeEnabled
  }, [crossfadeEnabled])
  useEffect(() => {
    crossfadeSecondsRef.current = crossfadeSeconds
  }, [crossfadeSeconds])
  useEffect(() => {
    autoAiMixEnabledRef.current = autoAiMixEnabled
  }, [autoAiMixEnabled])

  const getTrackGain = useCallback((track) => {
    if (!autoAiMixEnabledRef.current || !track?.recommended_gain) return 1.0
    const g = Number(track.recommended_gain)
    if (Number.isNaN(g) || g <= 0) return 1.0
    return Math.max(0.55, Math.min(1.45, g))
  }, [])

  const applyDeckOutput = useCallback((deckIdx, curveGain, bassAttenuationDb = 0) => {
    const master = isMutedRef.current ? 0 : volumeRef.current
    const clampedLevel = Math.max(0, Math.min(1, curveGain * master))
    const graph = audioGraphRef.current
    const audio = getDecks()[deckIdx]

    if (graph.ready && graph.gains[deckIdx] && graph.masterGain) {
      audio.volume = 1
      graph.masterGain.gain.value = master
      graph.gains[deckIdx].gain.value = Math.max(0, Math.min(1.5, curveGain))
      if (graph.filters[deckIdx]) {
        graph.filters[deckIdx].gain.value = bassAttenuationDb
      }
    } else {
      audio.volume = clampedLevel
    }
  }, [getDecks])

  const unlockAudioEngine = useCallback(() => {
    const graph = audioGraphRef.current
    if (graph.disabled) return
    try {
      if (!graph.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        if (!AudioCtx) {
          graph.disabled = true
          return
        }
        const ctx = new AudioCtx()
        const compressor = ctx.createDynamicsCompressor()
        compressor.threshold.value = -10
        compressor.ratio.value = 3.5

        const masterGain = ctx.createGain()
        masterGain.gain.value = isMutedRef.current ? 0 : volumeRef.current

        compressor.connect(masterGain)
        masterGain.connect(ctx.destination)

        const sources = []
        const filters = []
        const gains = []
        const decks = getDecks()

        for (let i = 0; i < 2; i += 1) {
          const src = ctx.createMediaElementSource(decks[i])
          const lowShelf = ctx.createBiquadFilter()
          lowShelf.type = 'lowshelf'
          lowShelf.frequency.value = 210
          lowShelf.gain.value = 0

          const gainNode = ctx.createGain()
          gainNode.gain.value = i === activeDeckRef.current ? 1 : 0

          src.connect(lowShelf)
          lowShelf.connect(gainNode)
          gainNode.connect(compressor)

          sources.push(src)
          filters.push(lowShelf)
          gains.push(gainNode)
        }

        graph.ctx = ctx
        graph.sources = sources
        graph.filters = filters
        graph.gains = gains
        graph.compressor = compressor
        graph.masterGain = masterGain
        graph.ready = true
      }

      if (graph.ctx && graph.ctx.state === 'suspended') {
        graph.ctx.resume().catch(() => {})
      }
    } catch {
      graph.disabled = true
      graph.ready = false
    }
  }, [getDecks])

  const showTransitionNotice = useCallback((payload, autoSettleMs = 0) => {
    if (noteTimeoutRef.current) {
      clearTimeout(noteTimeoutRef.current)
      noteTimeoutRef.current = null
    }
    setTransitionNote({
      id: Date.now(),
      settled: false,
      ...payload,
    })
    if (autoSettleMs > 0) {
      noteTimeoutRef.current = setTimeout(() => {
        setTransitionNote((prev) => (prev ? { ...prev, settled: true } : null))
      }, autoSettleMs)
    }
  }, [])

  const dismissTransitionNote = useCallback(() => {
    if (noteTimeoutRef.current) {
      clearTimeout(noteTimeoutRef.current)
      noteTimeoutRef.current = null
    }
    setTransitionNote(null)
  }, [])

  const stopCrossfadeLoop = useCallback((resetIncomingDeck = true) => {
    const cf = cfStateRef.current
    if (cf.rafId) {
      cancelAnimationFrame(cf.rafId)
      cf.rafId = null
    }
    if (cf.active && resetIncomingDeck) {
      const incoming = getDecks()[cf.inDeck]
      incoming.pause()
      incoming.playbackRate = 1
      applyDeckOutput(cf.inDeck, 0, 0)
    }
    cf.active = false
    cf.pausedElapsedMs = 0
    loadingNextRef.current = false
    setIsCrossfading(false)
    setCrossfadeProgress(0)
    setCrossfadeTargetTrack(null)
  }, [applyDeckOutput, getDecks])

  useEffect(() => {
    let cancelled = false
    getAudioResolverConfig().then((cfg) => {
      if (!cancelled && cfg) {
        audioResolverConfigRef.current = cfg
        setAudioResolverConfig(cfg)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const resolveTrackAudioSource = useCallback(async (track) => {
    if (!track) return null
    const key = track.track_id || `${track.track_name}_${track.artist_name || track.artist || ''}`
    if (preResolvedUrlsRef.current.has(key)) {
      return preResolvedUrlsRef.current.get(key)
    }

    const directUrl = resolvePlayableAudioUrl(track)
    const cfg = audioResolverConfigRef.current
    const canSkipBackendResolve =
      Boolean(directUrl)
      && (isFullAudioTrack(track) || (cfg && !cfg.rapidapi_configured && !cfg.native_engine_available))

    if (canSkipBackendResolve) {
      const entry = { url: directUrl, meta: null }
      preResolvedUrlsRef.current.set(key, entry)
      return entry
    }

    const backendResolved = await resolveTrackAudio(track, {
      preferFull: true,
      cacheLocally: true,
    })
    if (backendResolved?.stream_url) {
      const entry = {
        url: backendResolved.stream_url,
        meta: {
          local_audio_url: backendResolved.local_audio_url || track.local_audio_url,
          stream_url: backendResolved.stream_url,
          preview_url: backendResolved.preview_url || track.preview_url,
          album_cover_url: backendResolved.album_cover_url || track.album_cover_url,
          audio_cached: Boolean(backendResolved.audio_cached),
          audio_source: backendResolved.audio_source,
          audio_kind: backendResolved.audio_kind,
          audio_duration_ms: backendResolved.audio_duration_ms,
          catalog_duration_ms: backendResolved.catalog_duration_ms,
        },
      }
      preResolvedUrlsRef.current.set(key, entry)
      return entry
    }

    if (directUrl) {
      const entry = { url: directUrl, meta: null }
      preResolvedUrlsRef.current.set(key, entry)
      return entry
    }

    const media = await fetchTrackMedia(track.track_name, track.artist_name || track.artist)
    if (media?.preview_url || media?.album_cover_url) {
      const entry = {
        url: media?.preview_url || null,
        meta: {
          album_cover_url: media?.album_cover_url || track.album_cover_url,
          preview_url: media?.preview_url || track.preview_url,
          audio_kind: media?.preview_url ? 'preview' : track.audio_kind,
        },
      }
      if (entry.url) {
        preResolvedUrlsRef.current.set(key, entry)
        return entry
      }
    }
    return null
  }, [])

  const smoothRestorePlaybackRate = useCallback((deckIdx) => {
    if (rateRestoreTimerRef.current) {
      clearInterval(rateRestoreTimerRef.current)
      rateRestoreTimerRef.current = null
    }
    const audio = getDecks()[deckIdx]
    const initialRate = audio.playbackRate || 1
    if (Math.abs(initialRate - 1) < 0.002) {
      audio.playbackRate = 1
      return
    }
    let step = 0
    const totalSteps = 16
    rateRestoreTimerRef.current = setInterval(() => {
      step += 1
      const ratio = step / totalSteps
      audio.playbackRate = initialRate + (1 - initialRate) * ratio
      if (step >= totalSteps) {
        audio.playbackRate = 1
        clearInterval(rateRestoreTimerRef.current)
        rateRestoreTimerRef.current = null
      }
    }, 125)
  }, [getDecks])

  const finishCrossfade = useCallback(() => {
    const cf = cfStateRef.current
    if (!cf.active) return

    if (cf.rafId) {
      cancelAnimationFrame(cf.rafId)
      cf.rafId = null
    }

    const decks = getDecks()
    const outAudio = decks[cf.outDeck]
    const inAudio = decks[cf.inDeck]

    outAudio.pause()
    outAudio.playbackRate = 1
    outAudio.currentTime = 0
    applyDeckOutput(cf.outDeck, 0, 0)
    applyDeckOutput(cf.inDeck, cf.inBaseGain, 0)

    activeDeckRef.current = cf.inDeck
    const nextTrack = cf.targetTrack
    const prevTrack = cf.fromTrack
    const nextIdx = cf.targetIndex

    cf.active = false
    cf.pausedElapsedMs = 0
    loadingNextRef.current = false

    setCurrentTrack(nextTrack)
    setCurrentIndex(nextIdx)
    setCurrentTime(inAudio.currentTime || 0)
    if (inAudio.duration && !Number.isNaN(inAudio.duration)) {
      setDuration(inAudio.duration)
    }
    setIsCrossfading(false)
    setCrossfadeProgress(0)
    setCrossfadeTargetTrack(null)
    setIsPlaying(!inAudio.paused)

    smoothRestorePlaybackRate(cf.inDeck)

    if (nextTrack) {
      showTransitionNotice(
        {
          type: 'switched',
          fromTrackName: prevTrack?.track_name || 'Bài trước',
          toTrackName: nextTrack.track_name || 'Bài mới',
          toArtist: nextTrack.artist_name || nextTrack.artist || '',
          trackIndex: nextIdx,
          totalTracks: queueRef.current.length,
          matchScore: prevTrack?.mix_plan?.smoothness_score ?? prevTrack?.transition_similarity_to_next,
          mixStyle: prevTrack?.mix_plan?.mix_style || 'Crossfade Blend',
          crossfadeSec: cf.durationSec,
        },
        9500
      )
    }
  }, [applyDeckOutput, getDecks, showTransitionNotice, smoothRestorePlaybackRate])

  const stepCrossfadeFrame = useCallback(function stepFrame(nowTs) {
    const cf = cfStateRef.current
    if (!cf.active) return

    const elapsedMs = (nowTs - cf.startTs) + cf.pausedElapsedMs
    const totalMs = Math.max(400, cf.durationSec * 1000)
    const p = Math.min(1, Math.max(0, elapsedMs / totalMs))

    // Equal-power Spotify crossfade gain curve preserves constant perceived energy
    const outCurve = Math.cos(p * Math.PI * 0.5)
    const inCurve = Math.sin(p * Math.PI * 0.5)

    // Gentle DJ bass swap across mid-transition so kick drums stay clean
    let outBassDb = 0
    let inBassDb = 0
    if (cf.bassSwap) {
      outBassDb = -4.5 * Math.sin(p * Math.PI)
      inBassDb = -4.5 * (1 - p)
    }

    applyDeckOutput(cf.outDeck, outCurve * cf.outBaseGain, outBassDb)
    applyDeckOutput(cf.inDeck, inCurve * cf.inBaseGain, inBassDb)

    if (nowTs - cf.lastUiEmitTs > 65 || p >= 1) {
      cf.lastUiEmitTs = nowTs
      setCrossfadeProgress(p)
    }

    if (p >= 1) {
      finishCrossfade()
      return
    }

    cf.rafId = requestAnimationFrame(stepFrame)
  }, [applyDeckOutput, finishCrossfade])

  const playQueueIndex = useCallback(async (index, options = {}) => {
    const {
      fromAutoEnd = false,
      prevTrack = currentTrackRef.current,
      customQueue = null,
    } = options
    const targetQueue = customQueue || queueRef.current
    if (!targetQueue || index < 0 || index >= targetQueue.length) {
      return
    }

    unlockAudioEngine()
    stopCrossfadeLoop(true)

    let idx = index
    let chosenTrack = null
    let chosenUrl = null

    setIsLoadingMedia(true)
    while (idx < targetQueue.length) {
      const candidate = targetQueue[idx]
      const resolved = await resolveTrackAudioSource(candidate)
      if (resolved?.url) {
        chosenTrack = resolved.meta ? { ...candidate, ...resolved.meta } : candidate
        chosenUrl = resolved.url
        break
      }
      idx += 1
    }
    setIsLoadingMedia(false)

    if (!chosenTrack || !chosenUrl) {
      if (targetQueue.length === 1) {
        toast.warning(`Không tìm thấy nguồn âm thanh cho "${targetQueue[0].track_name}". Đang mở Spotify Web...`)
        setEmbedModalTrack(targetQueue[0])
      } else {
        toast.info('Đã phát hết các bài hát có bản audio khả dụng trong playlist.')
        setIsPlaying(false)
      }
      return
    }

    const decks = getDecks()
    const activeIdx = activeDeckRef.current
    const inactiveIdx = 1 - activeIdx
    decks[inactiveIdx].pause()
    decks[inactiveIdx].playbackRate = 1
    applyDeckOutput(inactiveIdx, 0, 0)

    const audio = decks[activeIdx]
    const gainMultiplier = getTrackGain(chosenTrack)

    try {
      audio.pause()
      audio.src = chosenUrl
      audio.currentTime = 0
      audio.playbackRate = 1
      applyDeckOutput(activeIdx, gainMultiplier, 0)

      const estimatedSec = Number(
        chosenTrack.audio_duration_ms || chosenTrack.catalog_duration_ms || chosenTrack.duration_ms || 0
      ) / 1000

      setCurrentTrack({
        ...chosenTrack,
        artist_name: chosenTrack.artist_name || chosenTrack.artist || '',
      })
      setCurrentIndex(idx)
      setCurrentTime(0)
      setDuration(estimatedSec > 1 ? estimatedSec : 30)

      await audio.play()
      setIsPlaying(true)

      if (fromAutoEnd || (prevTrack && prevTrack.track_id !== chosenTrack.track_id && targetQueue.length > 1)) {
        showTransitionNotice(
          {
            type: 'switched',
            fromTrackName: prevTrack?.track_name || null,
            toTrackName: chosenTrack.track_name || 'Bài mới',
            toArtist: chosenTrack.artist_name || chosenTrack.artist || '',
            trackIndex: idx,
            totalTracks: targetQueue.length,
            matchScore: prevTrack?.mix_plan?.smoothness_score ?? prevTrack?.transition_similarity_to_next,
            mixStyle: prevTrack?.mix_plan?.mix_style || 'Liền mạch',
            crossfadeSec: 0,
          },
          9500
        )
      }
    } catch {
      setIsPlaying(false)
      toast.error('Trình duyệt chặn tự phát hoặc không tải được luồng âm thanh.')
    }
  }, [
    applyDeckOutput,
    getDecks,
    getTrackGain,
    resolveTrackAudioSource,
    showTransitionNotice,
    stopCrossfadeLoop,
    toast,
    unlockAudioEngine,
  ])

  const startCrossfadeToIndex = useCallback(async (targetIdx, fadeSec) => {
    const q = queueRef.current
    if (!q || targetIdx < 0 || targetIdx >= q.length || cfStateRef.current.active || loadingNextRef.current) {
      return
    }

    loadingNextRef.current = true
    const outDeck = activeDeckRef.current
    const inDeck = 1 - outDeck
    const outgoingTrack = currentTrackRef.current

    let chosenIdx = targetIdx
    let incomingTrack = null
    let incomingUrl = null

    while (chosenIdx < q.length) {
      const cand = q[chosenIdx]
      const resolved = await resolveTrackAudioSource(cand)
      if (resolved?.url) {
        incomingTrack = resolved.meta ? { ...cand, ...resolved.meta } : cand
        incomingUrl = resolved.url
        break
      }
      chosenIdx += 1
    }

    if (!incomingTrack || !incomingUrl) {
      loadingNextRef.current = false
      return
    }

    const inAudio = getDecks()[inDeck]
    const outBaseGain = getTrackGain(outgoingTrack)
    const inBaseGain = getTrackGain(incomingTrack)
    const mixPlan = outgoingTrack?.mix_plan
    const syncRate =
      autoAiMixEnabledRef.current && mixPlan?.tempo_sync_ratio
        ? Number(mixPlan.tempo_sync_ratio)
        : 1.0

    try {
      inAudio.pause()
      inAudio.src = incomingUrl
      inAudio.currentTime = 0
      inAudio.playbackRate = Math.max(0.95, Math.min(1.05, syncRate))
      applyDeckOutput(inDeck, 0.0001, mixPlan?.eq_bass_swap ? -4.5 : 0)

      await inAudio.play()

      const safeFade = Math.max(0.8, Math.min(12, Number(fadeSec) || DEFAULT_CROSSFADE_SECONDS))
      cfStateRef.current = {
        active: true,
        outDeck,
        inDeck,
        targetIndex: chosenIdx,
        targetTrack: {
          ...incomingTrack,
          artist_name: incomingTrack.artist_name || incomingTrack.artist || '',
        },
        fromTrack: outgoingTrack,
        durationSec: safeFade,
        startTs: performance.now(),
        pausedElapsedMs: 0,
        rafId: null,
        lastUiEmitTs: 0,
        outBaseGain,
        inBaseGain,
        bassSwap: Boolean(autoAiMixEnabledRef.current && mixPlan?.eq_bass_swap),
        inStartRate: syncRate,
      }

      setIsCrossfading(true)
      setCrossfadeProgress(0)
      setCrossfadeTargetTrack(incomingTrack)

      showTransitionNotice({
        type: 'crossfading',
        fromTrackName: outgoingTrack?.track_name || 'Bài hiện tại',
        toTrackName: incomingTrack.track_name || 'Bài tiếp theo',
        toArtist: incomingTrack.artist_name || incomingTrack.artist || '',
        trackIndex: chosenIdx,
        totalTracks: q.length,
        matchScore: mixPlan?.smoothness_score ?? outgoingTrack?.transition_similarity_to_next,
        mixStyle: mixPlan?.mix_style || 'Spotify Crossfade',
        crossfadeSec: safeFade,
      })

      cfStateRef.current.rafId = requestAnimationFrame(stepCrossfadeFrame)
    } catch {
      loadingNextRef.current = false
      inAudio.pause()
      applyDeckOutput(inDeck, 0, 0)
    }
  }, [
    applyDeckOutput,
    getDecks,
    getTrackGain,
    resolveTrackAudioSource,
    showTransitionNotice,
    stepCrossfadeFrame,
  ])

  // Bind listeners to both persistent decks
  useEffect(() => {
    const decks = getDecks()
    const cleanups = []

    decks.forEach((audio, deckIdx) => {
      const onPlay = () => {
        if (deckIdx === activeDeckRef.current) setIsPlaying(true)
      }
      const onPause = () => {
        if (deckIdx === activeDeckRef.current && !cfStateRef.current.active) {
          setIsPlaying(false)
        }
      }
      const onTimeUpdate = () => {
        if (deckIdx !== activeDeckRef.current) return
        setCurrentTime(audio.currentTime)

        const dur = audio.duration
        const idx = currentIndexRef.current
        const q = queueRef.current
        if (!dur || Number.isNaN(dur) || idx < 0 || idx + 1 >= q.length) return

        const remaining = dur - audio.currentTime

        // Pre-buffer next track smoothly ahead of crossfade
        if (audio.currentTime > 3 && q[idx + 1]) {
          resolveTrackAudioSource(q[idx + 1]).catch(() => {})
        }

        if (
          !cfStateRef.current.active
          && !loadingNextRef.current
          && crossfadeEnabledRef.current
          && crossfadeSecondsRef.current > 0
        ) {
          const targetFade = Math.min(crossfadeSecondsRef.current, dur * 0.42)
          if (targetFade >= 0.8 && remaining <= targetFade && remaining > 0.15) {
            startCrossfadeToIndex(idx + 1, targetFade)
          }
        }
      }
      const onDurationChange = () => {
        if (deckIdx === activeDeckRef.current && audio.duration && !Number.isNaN(audio.duration)) {
          setDuration(audio.duration)
          if (audio.duration >= 45) {
            setCurrentTrack((prev) => (
              prev && prev.audio_kind !== 'full'
                ? { ...prev, audio_kind: 'full', audio_duration_ms: Math.round(audio.duration * 1000) }
                : prev
            ))
          }
        }
      }
      const onEnded = () => {
        if (cfStateRef.current.active && deckIdx === cfStateRef.current.outDeck) {
          finishCrossfade()
          return
        }
        if (deckIdx !== activeDeckRef.current) return

        const idx = currentIndexRef.current
        const q = queueRef.current
        if (idx >= 0 && idx + 1 < q.length) {
          playQueueIndex(idx + 1, {
            fromAutoEnd: true,
            prevTrack: currentTrackRef.current,
          })
        } else {
          setIsPlaying(false)
          setCurrentTime(0)
        }
      }
      const onError = () => {
        if (deckIdx === activeDeckRef.current) {
          setIsPlaying(false)
          setIsLoadingMedia(false)
        }
      }

      audio.addEventListener('play', onPlay)
      audio.addEventListener('pause', onPause)
      audio.addEventListener('timeupdate', onTimeUpdate)
      audio.addEventListener('durationchange', onDurationChange)
      audio.addEventListener('ended', onEnded)
      audio.addEventListener('error', onError)

      cleanups.push(() => {
        audio.removeEventListener('play', onPlay)
        audio.removeEventListener('pause', onPause)
        audio.removeEventListener('timeupdate', onTimeUpdate)
        audio.removeEventListener('durationchange', onDurationChange)
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
      })
    })

    return () => {
      cleanups.forEach((fn) => fn())
      if (rateRestoreTimerRef.current) clearInterval(rateRestoreTimerRef.current)
      if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current)
      if (cfStateRef.current.rafId) cancelAnimationFrame(cfStateRef.current.rafId)
      decks.forEach((a) => {
        a.pause()
        a.src = ''
      })
    }
  }, [finishCrossfade, getDecks, playQueueIndex, resolveTrackAudioSource, startCrossfadeToIndex])

  const pause = useCallback(() => {
    const cf = cfStateRef.current
    if (cf.active) {
      if (cf.rafId) {
        cancelAnimationFrame(cf.rafId)
        cf.rafId = null
      }
      cf.pausedElapsedMs += performance.now() - cf.startTs
    }
    getDecks().forEach((a) => a.pause())
    setIsPlaying(false)
  }, [getDecks])

  const resume = useCallback(() => {
    unlockAudioEngine()
    const decks = getDecks()
    const cf = cfStateRef.current
    if (cf.active) {
      cf.startTs = performance.now()
      decks[cf.outDeck].play().catch(() => {})
      decks[cf.inDeck].play().catch(() => {})
      cf.rafId = requestAnimationFrame(stepCrossfadeFrame)
      setIsPlaying(true)
      return
    }
    const active = decks[activeDeckRef.current]
    if (active.src) {
      active.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
    }
  }, [getDecks, stepCrossfadeFrame, unlockAudioEngine])

  const seek = useCallback((timeInSeconds) => {
    stopCrossfadeLoop(true)
    const active = getDecks()[activeDeckRef.current]
    if (active) {
      applyDeckOutput(activeDeckRef.current, getTrackGain(currentTrackRef.current), 0)
      active.currentTime = timeInSeconds
      setCurrentTime(timeInSeconds)
    }
  }, [applyDeckOutput, getDecks, getTrackGain, stopCrossfadeLoop])

  const changeVolume = useCallback((newVol) => {
    const clamped = Math.max(0, Math.min(1, Number(newVol)))
    volumeRef.current = clamped
    setVolume(clamped)
    if (clamped > 0 && isMutedRef.current) {
      isMutedRef.current = false
      setIsMuted(false)
    }

    const graph = audioGraphRef.current
    if (graph.ready && graph.masterGain) {
      graph.masterGain.gain.value = isMutedRef.current ? 0 : clamped
    } else if (!cfStateRef.current.active) {
      applyDeckOutput(activeDeckRef.current, getTrackGain(currentTrackRef.current), 0)
    }
  }, [applyDeckOutput, getTrackGain])

  const toggleMute = useCallback(() => {
    const nextMuted = !isMutedRef.current
    isMutedRef.current = nextMuted
    setIsMuted(nextMuted)
    const graph = audioGraphRef.current
    if (graph.ready && graph.masterGain) {
      graph.masterGain.gain.value = nextMuted ? 0 : volumeRef.current
    } else if (!cfStateRef.current.active) {
      applyDeckOutput(activeDeckRef.current, getTrackGain(currentTrackRef.current), 0)
    }
  }, [applyDeckOutput, getTrackGain])

  const playTrack = useCallback(async (track) => {
    if (!track) return
    unlockAudioEngine()

    if (currentTrackRef.current && currentTrackRef.current.track_id === track.track_id && queueRef.current.length <= 1) {
      if (isPlaying) {
        pause()
      } else {
        resume()
      }
      return
    }

    const singleQueue = [track]
    queueRef.current = singleQueue
    setQueue(singleQueue)
    setQueueTitle('')
    setCurrentIndex(0)
    dismissTransitionNote()
    await playQueueIndex(0, { customQueue: singleQueue, prevTrack: null })
  }, [dismissTransitionNote, isPlaying, pause, playQueueIndex, resume, unlockAudioEngine])

  const playQueue = useCallback(async (tracks, startIndex = 0, options = {}) => {
    if (!Array.isArray(tracks) || tracks.length === 0) return
    unlockAudioEngine()

    const safeStart = Math.max(0, Math.min(tracks.length - 1, Number(startIndex) || 0))
    const cloned = tracks.map((t) => ({ ...t }))
    queueRef.current = cloned
    setQueue(cloned)
    setQueueTitle(options.title || 'AI DJ Mix Queue')
    setCurrentIndex(safeStart)
    dismissTransitionNote()

    await playQueueIndex(safeStart, {
      customQueue: cloned,
      prevTrack: null,
    })
  }, [dismissTransitionNote, playQueueIndex, unlockAudioEngine])

  const nextTrack = useCallback(async (allowQuickCrossfade = true) => {
    const q = queueRef.current
    const idx = currentIndexRef.current
    if (!q.length || idx + 1 >= q.length) return

    unlockAudioEngine()
    if (cfStateRef.current.active) {
      finishCrossfade()
      return
    }

    if (allowQuickCrossfade && crossfadeEnabledRef.current && crossfadeSecondsRef.current > 0 && isPlaying) {
      const quickSec = Math.min(2.5, Math.max(1.2, crossfadeSecondsRef.current * 0.5))
      await startCrossfadeToIndex(idx + 1, quickSec)
      return
    }

    await playQueueIndex(idx + 1, { prevTrack: currentTrackRef.current })
  }, [finishCrossfade, isPlaying, playQueueIndex, startCrossfadeToIndex, unlockAudioEngine])

  const prevTrack = useCallback(async () => {
    const q = queueRef.current
    const idx = currentIndexRef.current
    const active = getDecks()[activeDeckRef.current]
    if (!q.length) return

    if (active && active.currentTime > 4 && idx >= 0) {
      seek(0)
      return
    }
    if (idx > 0) {
      await playQueueIndex(idx - 1, { prevTrack: currentTrackRef.current })
    }
  }, [getDecks, playQueueIndex, seek])

  const clearQueue = useCallback(() => {
    stopCrossfadeLoop(true)
    getDecks().forEach((a) => {
      a.pause()
      a.currentTime = 0
    })
    queueRef.current = []
    setQueue([])
    setQueueTitle('')
    setCurrentIndex(-1)
    setCurrentTrack(null)
    setIsPlaying(false)
    dismissTransitionNote()
  }, [dismissTransitionNote, getDecks, stopCrossfadeLoop])

  const openSpotifyEmbed = useCallback((track) => {
    setEmbedModalTrack(track)
  }, [])

  const closeSpotifyEmbed = useCallback(() => {
    setEmbedModalTrack(null)
  }, [])

  const value = useMemo(() => ({
    currentTrack,
    queue,
    currentIndex,
    queueTitle,
    isPlaying,
    isLoadingMedia,
    currentTime,
    duration,
    volume,
    isMuted,
    crossfadeEnabled,
    crossfadeSeconds,
    autoAiMixEnabled,
    isCrossfading,
    crossfadeProgress,
    crossfadeTargetTrack,
    transitionNote,
    setCrossfadeEnabled,
    setCrossfadeSeconds,
    setAutoAiMixEnabled,
    dismissTransitionNote,
    unlockAudioEngine,
    playTrack,
    playQueue,
    nextTrack,
    prevTrack,
    clearQueue,
    pause,
    resume,
    seek,
    changeVolume,
    toggleMute,
    embedModalTrack,
    openSpotifyEmbed,
    closeSpotifyEmbed,
    audioResolverConfig,
  }), [
    currentTrack,
    queue,
    currentIndex,
    queueTitle,
    isPlaying,
    isLoadingMedia,
    currentTime,
    duration,
    volume,
    isMuted,
    crossfadeEnabled,
    crossfadeSeconds,
    autoAiMixEnabled,
    isCrossfading,
    crossfadeProgress,
    crossfadeTargetTrack,
    transitionNote,
    dismissTransitionNote,
    unlockAudioEngine,
    playTrack,
    playQueue,
    nextTrack,
    prevTrack,
    clearQueue,
    pause,
    resume,
    seek,
    changeVolume,
    toggleMute,
    embedModalTrack,
    openSpotifyEmbed,
    closeSpotifyEmbed,
    audioResolverConfig,
  ])

  return (
    <AudioPlayerContext.Provider value={value}>
      {children}
    </AudioPlayerContext.Provider>
  )
}
