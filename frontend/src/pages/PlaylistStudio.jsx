import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AUDIO_FEATURE_KEYS,
  MAX_LOCAL_AUDIO_LIMIT,
  PLAYLIST_MODEL_LABELS,
  clearLocalAudioCache,
  expandPlaylist,
  extractSpotifyTracks,
  getAudioResolverConfig,
  getLocalAudioStatus,
  makeLocalDjMix,
  parseSpotifyUrl,
  sequencePlaylist,
} from '../api/index.js'
import SpotifyPlayer from '../components/SpotifyPlayer.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import { useAudioPlayer } from '../hooks/useAudioPlayer.js'
import { useToast } from '../hooks/useToast.js'

const MODEL_DESCRIPTIONS = {
  dj_mix:
    'Thuật toán AI DJ Mix (2-opt Harmonic): Kết hợp khoảng cách Cosine 9D, khớp nhịp BPM (hỗ trợ half/double-time), độ dốc Energy và đề xuất thông số Crossfade + Cân bằng âm lượng từng bài.',
  vibe_smooth:
    'Thuật toán DJ Arc: Dẫn dắt năng lượng tăng mượt mà (Warm-up -> Peak -> Blend), hạn chế tối đa chuyển bài hụt nhịp.',
  hybrid:
    'Kết hợp vector sóng âm EmBeat (70%) với thể loại nghệ sĩ TF-IDF (30%) để sắp xếp và làm mượt playlist.',
  audio:
    'Sử dụng khoảng cách Cosine trên 9 đặc trưng âm học chuẩn hóa để chuyển bài êm ái nhất.',
  popular:
    'Ưu tiên mở đầu bằng các bản Hit phổ biến nhất rồi dẫn dắt qua toàn bộ danh sách phát.',
}

const AUDIO_LIMIT_OPTIONS = [5, 10, 15, 20]

function escapeCsvCell(val) {
  const s = String(val ?? '').replace(/"/g, '""')
  return `"${s}"`
}

function parseCsvRow(line) {
  const cells = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i += 1
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}

function formatFeatureValue(af, feat) {
  if (!af || af[feat.key] == null) return '—'
  const raw = Number(af[feat.key])
  if (Number.isNaN(raw)) return '—'
  const scaled = raw * feat.scale
  return `${scaled.toFixed(feat.decimals)}${feat.unit}`
}

function formatDelta(val, feat) {
  if (val == null || Number.isNaN(Number(val))) return null
  const scaled = Number(val) * feat.scale
  const sign = scaled > 0 ? '+' : ''
  return `${sign}${scaled.toFixed(feat.decimals)}${feat.unit}`
}

function getFeatureBarWidth(af, feat) {
  if (!af || af[feat.key] == null) return 0
  const raw = Number(af[feat.key])
  if (feat.key === 'tempo') return Math.min(100, Math.max(5, ((raw - 40) / 160) * 100))
  if (feat.key === 'loudness') return Math.min(100, Math.max(5, ((raw + 30) / 30) * 100))
  return Math.min(100, Math.max(2, raw * 100))
}

function DjFlowSparkline({ tracks }) {
  if (!tracks || tracks.length < 2) return null

  const width = 620
  const height = 84
  const padX = 16
  const padY = 12
  const innerW = width - padX * 2
  const innerH = height - padY * 2

  const makePoints = (extractor) =>
    tracks
      .map((t, idx) => {
        const x = padX + (idx / (tracks.length - 1)) * innerW
        const yNorm = Math.max(0, Math.min(1, extractor(t)))
        const y = padY + (1 - yNorm) * innerH
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  const energyPts = makePoints((t) => Number(t.audio_features?.energy ?? t.energy ?? 0.5))
  const tempoPts = makePoints((t) => ((Number(t.audio_features?.tempo ?? t.tempo ?? 120) - 55) / 135))
  const valencePts = makePoints((t) => Number(t.audio_features?.valence ?? t.valence ?? 0.5))

  return (
    <div className="dj-sparkline-card">
      <div className="dj-sparkline-header">
        <span className="dj-sparkline-title">📈 Biểu Đồ Dòng Chảy Mixing (#1 → #{tracks.length})</span>
        <div className="dj-sparkline-legend">
          <span className="legend-dot energy">● Energy</span>
          <span className="legend-dot tempo">● Tempo (BPM)</span>
          <span className="legend-dot valence">● Valence</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="dj-sparkline-svg" aria-label="Biểu đồ đồng bộ giai điệu playlist">
        <polyline fill="none" stroke="#1db954" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={energyPts} />
        <polyline fill="none" stroke="#38bdf8" strokeWidth="2" strokeDasharray="5 3" strokeLinejoin="round" strokeLinecap="round" points={tempoPts} />
        <polyline fill="none" stroke="#c084fc" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" points={valencePts} />
      </svg>
    </div>
  )
}

export default function PlaylistStudio() {
  const toast = useToast()
  const {
    playQueue,
    currentTrack,
    isPlaying,
    crossfadeEnabled,
    crossfadeSeconds,
    autoAiMixEnabled,
    setCrossfadeEnabled,
    setCrossfadeSeconds,
    setAutoAiMixEnabled,
    unlockAudioEngine,
  } = useAudioPlayer()

  const [spotifyInput, setSpotifyInput] = useState(() => {
    try {
      return localStorage.getItem('ps_spotify_input') || ''
    } catch {
      return ''
    }
  })
  const [spotifyId, setSpotifyId] = useState(() => {
    try {
      return localStorage.getItem('ps_spotify_id') || ''
    } catch {
      return ''
    }
  })
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      const m = localStorage.getItem('ps_selected_model')
      return m && PLAYLIST_MODEL_LABELS[m] ? m : 'dj_mix'
    } catch {
      return 'dj_mix'
    }
  })
  const [maxAudioLimit, setMaxAudioLimit] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('ps_max_audio_limit') || MAX_LOCAL_AUDIO_LIMIT)
      return Math.max(2, Math.min(MAX_LOCAL_AUDIO_LIMIT, saved))
    } catch {
      return MAX_LOCAL_AUDIO_LIMIT
    }
  })
  const [selectionMode, setSelectionMode] = useState('smart_cohesive')
  const [extractedSpotifyTracks, setExtractedSpotifyTracks] = useState(() => {
    try {
      const raw = localStorage.getItem('ps_extracted_tracks')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })

  const [extractingSpotify, setExtractingSpotify] = useState(false)
  const [makingLocalMix, setMakingLocalMix] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)
  const [resultViewMode, setResultViewMode] = useState('flow') // 'flow' | 'matrix'
  const [sortByFeature, setSortByFeature] = useState('step')
  const [cacheStatus, setCacheStatus] = useState(null)
  const [audioConfig, setAudioConfig] = useState(null)

  const [sequenceResult, setSequenceResult] = useState(() => {
    try {
      const raw = localStorage.getItem('ps_sequence_result')
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tracks)) {
        return parsed
      }
      localStorage.removeItem('ps_sequence_result')
      return null
    } catch {
      return null
    }
  })

  const [expandedResult, setExpandedResult] = useState(() => {
    try {
      const raw = localStorage.getItem('ps_expanded_result')
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.full_playlist)) {
        return parsed
      }
      localStorage.removeItem('ps_expanded_result')
      return null
    } catch {
      return null
    }
  })

  const refreshCacheStatus = useCallback(async () => {
    try {
      const st = await getLocalAudioStatus()
      setCacheStatus(st)
    } catch {
      // Backend offline
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    getLocalAudioStatus()
      .then((st) => {
        if (!cancelled) setCacheStatus(st)
      })
      .catch(() => {})
    getAudioResolverConfig()
      .then((cfg) => {
        if (!cancelled && cfg) setAudioConfig(cfg)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Auto-save to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('ps_spotify_input', spotifyInput)
    } catch {}
  }, [spotifyInput])

  useEffect(() => {
    try {
      localStorage.setItem('ps_spotify_id', spotifyId)
    } catch {}
  }, [spotifyId])

  useEffect(() => {
    try {
      localStorage.setItem('ps_selected_model', selectedModel)
    } catch {}
  }, [selectedModel])

  useEffect(() => {
    try {
      localStorage.setItem('ps_max_audio_limit', String(maxAudioLimit))
    } catch {}
  }, [maxAudioLimit])

  useEffect(() => {
    try {
      localStorage.setItem('ps_extracted_tracks', JSON.stringify(extractedSpotifyTracks))
    } catch {}
  }, [extractedSpotifyTracks])

  useEffect(() => {
    try {
      localStorage.setItem('ps_sequence_result', JSON.stringify(sequenceResult))
    } catch {}
  }, [sequenceResult])

  useEffect(() => {
    try {
      localStorage.setItem('ps_expanded_result', JSON.stringify(expandedResult))
    } catch {}
  }, [expandedResult])

  function handleClearStudio() {
    setSpotifyInput('')
    setSpotifyId('')
    setExtractedSpotifyTracks([])
    setSequenceResult(null)
    setExpandedResult(null)
    setError(null)
    setSuccessMsg(null)
    setSortByFeature('step')
    try {
      localStorage.removeItem('ps_spotify_input')
      localStorage.removeItem('ps_spotify_id')
      localStorage.removeItem('ps_extracted_tracks')
      localStorage.removeItem('ps_sequence_result')
      localStorage.removeItem('ps_expanded_result')
    } catch {}
    toast.info('Đã xóa dữ liệu Playlist Studio.')
  }

  async function handleClearDiskAudioCache() {
    try {
      const res = await clearLocalAudioCache()
      setCacheStatus({ cached_files: 0, max_limit: MAX_LOCAL_AUDIO_LIMIT, total_size_mb: 0 })
      toast.success(`Đã xóa ${res.deleted_files} file audio trong bộ nhớ đệm cục bộ.`)
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function handleParseSpotify(e) {
    if (e) e.preventDefault()
    const rawUrl = spotifyInput.trim()
    if (!rawUrl) {
      setError('Vui lòng dán link Playlist Spotify vào ô nhập liệu trước khi xem Player!')
      return
    }
    setError(null)
    try {
      const res = await parseSpotifyUrl(rawUrl)
      if (res.valid) {
        setSpotifyId(res.playlist_id)
        toast.success('Đã nhận diện Playlist ID hợp lệ!')
      } else {
        setError('Không tìm thấy ID playlist Spotify hợp lệ từ đường dẫn.')
      }
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleExtractAndSequenceSpotify(customModel = selectedModel) {
    const rawUrl = spotifyInput.trim()
    if (!rawUrl) {
      setError('Vui lòng dán link Playlist Spotify vào ô nhập liệu bên trên trước khi bấm bóc tách!')
      return
    }
    setExtractingSpotify(true)
    setError(null)
    setSuccessMsg(null)
    setExpandedResult(null)
    setSortByFeature('step')

    try {
      const data = await extractSpotifyTracks(rawUrl)
      setSpotifyId(data.playlist_id)
      setExtractedSpotifyTracks(data.tracks)

      if (data.tracks.length === 0) {
        setError('Không bóc tách được bài hát nào từ playlist này.')
        return
      }

      setSuccessMsg(
        `Đã bóc tách thành công toàn bộ ${data.tracks.length} bài hát! Đang chạy mô hình sắp xếp...`
      )

      const seq = await sequencePlaylist({ tracks: data.tracks, model: customModel })
      setSequenceResult(seq)
      const msg = `Đã bóc tách toàn bộ ${seq.tracks.length} bài hát và sắp xếp liền mạch theo ${PLAYLIST_MODEL_LABELS[customModel]} (giảm ${seq.cost_reduction_percent}% độ gãy giai điệu)!`
      setSuccessMsg(msg)
      toast.success(msg)
    } catch (err) {
      setError(err.message)
      toast.error(err.message)
    } finally {
      setExtractingSpotify(false)
    }
  }

  /**
   * Tự động tải tối đa 20 bản audio về máy cục bộ -> Model can thiệp đồng bộ giai điệu & mixing -> Phát nghe luôn!
   */
  async function handleDownloadAndPlayDjMix(startAutoPlay = true) {
    const rawUrl = spotifyInput.trim()
    if (!rawUrl && extractedSpotifyTracks.length === 0) {
      setError('Vui lòng dán link Playlist Spotify (hoặc bấm "Link mẫu" / Import CSV) trước khi Make DJ Mix!')
      return
    }

    if (startAutoPlay) {
      unlockAudioEngine()
    }

    setMakingLocalMix(true)
    setError(null)
    setExpandedResult(null)
    setSortByFeature('step')
    setSuccessMsg(`Đang chọn lọc tối đa ${maxAudioLimit} bài đồng điệu nhất, tự động tải audio về local và tối ưu AI DJ Mixing...`)

    try {
      const mixRes = await makeLocalDjMix({
        urlOrId: extractedSpotifyTracks.length === 0 ? rawUrl : undefined,
        tracks: extractedSpotifyTracks.length > 0 ? extractedSpotifyTracks : undefined,
        model: selectedModel,
        maxTracks: maxAudioLimit,
        selectionMode,
        autoDownload: true,
      })

      if (mixRes.playlist_id) setSpotifyId(mixRes.playlist_id)
      setSequenceResult(mixRes)
      refreshCacheStatus()

      const dl = mixRes.download_stats || {}
      const msg = `🎧 Sẵn sàng! Đã tải ${dl.ready_local ?? mixRes.tracks.length}/${mixRes.tracks.length} bản audio về local (Giới hạn ≤${MAX_LOCAL_AUDIO_LIMIT} bài) · Độ mượt giai điệu ${mixRes.avg_smoothness_percent ?? '—'}%!`
      setSuccessMsg(msg)
      toast.success(msg)

      if (startAutoPlay && mixRes.tracks?.length > 0) {
        await playQueue(mixRes.tracks, 0, {
          title: mixRes.title || 'AI DJ Local Mix',
        })
      }
    } catch (err) {
      setError(err.message)
      toast.error(err.message)
    } finally {
      setMakingLocalMix(false)
    }
  }

  async function handleModelChange(nextModel) {
    setSelectedModel(nextModel)
    const basePool = sequenceResult?.tracks?.length >= 2 && sequenceResult?.download_stats
      ? sequenceResult.tracks
      : extractedSpotifyTracks

    if (basePool.length >= 2) {
      setLoading(true)
      setError(null)
      setExpandedResult(null)
      setSortByFeature('step')
      try {
        const seq = await sequencePlaylist({ tracks: basePool, model: nextModel })
        setSequenceResult((prev) => ({
          ...seq,
          download_stats: prev?.download_stats,
          curation_stats: prev?.curation_stats,
        }))
        const msg = `Đã sắp xếp lại ${seq.tracks.length} bài theo ${PLAYLIST_MODEL_LABELS[nextModel]} (độ mượt: ${seq.avg_smoothness_percent ?? '—'}%).`
        setSuccessMsg(msg)
        toast.success(msg)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
  }

  async function handleInfill(mode = 'infill') {
    const baseTracks = sequenceResult?.tracks ?? extractedSpotifyTracks
    if (!baseTracks || baseTracks.length < 2) {
      setError('Vui lòng bấm bóc tách hoặc Make DJ Mix trước khi chèn hoặc nối dài bài hát.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await expandPlaylist({
        tracks: baseTracks,
        numToInsert: 3,
        mode,
        model: selectedModel,
      })
      setExpandedResult(res)
      const msg =
        mode === 'infill'
          ? `Đã chèn thêm ${res.num_inserted} bài hát cầu nối giai điệu vào Playlist (Tổng: ${res.full_playlist.length} bài).`
          : `Đã nối dài thêm ${res.num_inserted} bài hát hợp gu vào cuối Playlist (Tổng: ${res.full_playlist.length} bài).`
      setSuccessMsg(msg)
      toast.success(msg)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const activeTracks = useMemo(() => {
    if (expandedResult?.full_playlist) return expandedResult.full_playlist
    return sequenceResult?.tracks ?? []
  }, [expandedResult, sequenceResult])

  const featureAverages = useMemo(() => {
    if (activeTracks.length === 0) return null
    const avgs = {}
    for (const { key } of AUDIO_FEATURE_KEYS) {
      const sum = activeTracks.reduce(
        (acc, t) => acc + Number(t.audio_features?.[key] ?? t[key] ?? 0),
        0
      )
      avgs[key] = sum / activeTracks.length
    }
    return avgs
  }, [activeTracks])

  const sortedMatrixTracks = useMemo(() => {
    if (sortByFeature === 'step') return activeTracks
    return [...activeTracks].sort((a, b) => {
      const va = Number(a.audio_features?.[sortByFeature] ?? a[sortByFeature] ?? 0)
      const vb = Number(b.audio_features?.[sortByFeature] ?? b[sortByFeature] ?? 0)
      return vb - va
    })
  }, [activeTracks, sortByFeature])

  function handlePlayTrackInMix(idx) {
    if (!activeTracks.length) return
    playQueue(activeTracks, idx, { title: 'AI DJ Mix Queue' })
  }

  function handleExportCsv() {
    if (activeTracks.length === 0) return

    const headers = [
      'Track URI',
      'Track Name',
      'Artist URI(s)',
      'Artist Name(s)',
      'Album URI',
      'Album Name',
      'Album Artist URI(s)',
      'Album Artist Name(s)',
      'Album Release Date',
      'Album Image URL',
      'Disc Number',
      'Track Number',
      'Track Duration (ms)',
      'Track Preview URL',
      'Explicit',
      'Popularity',
      'ISRC',
      'Added By',
      'Added At',
    ]

    const rows = activeTracks.map((t, idx) => {
      const trackUri =
        t.spotify_uri ||
        (t.track_id && !String(t.track_id).startsWith('sp_') && String(t.track_id).length === 22
          ? `spotify:track:${t.track_id}`
          : '')
      return [
        trackUri,
        t.track_name ?? '',
        t.artist_uris ?? '',
        t.artist ?? t.artist_name ?? '',
        t.album_uri ?? '',
        t.album_name ?? '',
        t.album_artist_uris ?? t.artist_uris ?? '',
        t.album_artist_names ?? t.artist ?? '',
        t.album_release_date ?? '',
        t.album_image_url ?? '',
        t.disc_number != null && t.disc_number !== '' ? String(t.disc_number) : '1',
        t.track_number != null && t.track_number !== '' ? String(t.track_number) : String(t.step ?? idx + 1),
        t.duration_ms != null && t.duration_ms !== '' ? String(t.duration_ms) : '0',
        t.preview_url ?? '',
        t.explicit != null && t.explicit !== '' ? String(t.explicit) : 'false',
        t.popularity != null ? String(t.popularity) : '',
        t.isrc ?? '',
        t.added_by ?? '',
        t.added_at ?? '',
      ]
        .map(escapeCsvCell)
        .join(',')
    })

    const csvContent = [headers.map(escapeCsvCell).join(','), ...rows].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const downloadUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = `spotify_playlist_${spotifyId || 'optimized'}_${selectedModel}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(downloadUrl)
    toast.success(`Đã xuất ${activeTracks.length} bài hát ra file CSV chuẩn Spotify!`)
  }

  async function handleImportCsvFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setSuccessMsg(null)
    setExpandedResult(null)
    setLoading(true)
    setSortByFeature('step')

    try {
      const text = await file.text()
      const lines = text
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)

      if (lines.length < 2) {
        setError('File CSV không có dữ liệu bài hát hợp lệ.')
        return
      }

      const headerCols = parseCsvRow(lines[0]).map((h) => h.trim())
      const colIdx = (name) => headerCols.findIndex((h) => h.toLowerCase() === name.toLowerCase())

      const iUri = colIdx('Track URI')
      const iName = colIdx('Track Name')
      const iArtUris = colIdx('Artist URI(s)')
      const iArtNames = colIdx('Artist Name(s)')
      const iAlbUri = colIdx('Album URI')
      const iAlbName = colIdx('Album Name')
      const iAlbArtUris = colIdx('Album Artist URI(s)')
      const iAlbArtNames = colIdx('Album Artist Name(s)')
      const iAlbDate = colIdx('Album Release Date')
      const iAlbImg = colIdx('Album Image URL')
      const iDisc = colIdx('Disc Number')
      const iTrackNum = colIdx('Track Number')
      const iDur = colIdx('Track Duration (ms)')
      const iPrev = colIdx('Track Preview URL')
      const iExp = colIdx('Explicit')
      const iPop = colIdx('Popularity')
      const iIsrc = colIdx('ISRC')
      const iAddedBy = colIdx('Added By')
      const iAddedAt = colIdx('Added At')

      const parsedTracks = []
      for (let r = 1; r < lines.length; r += 1) {
        const cols = parseCsvRow(lines[r])
        const getVal = (idx) => (idx >= 0 && idx < cols.length ? cols[idx] : '')
        const uri = getVal(iUri).trim()
        const name = getVal(iName).trim()
        const artist = getVal(iArtNames).trim() || 'Unknown Artist'
        if (!name && !uri) continue

        const tid = uri.includes(':') ? uri.split(':').pop() : `csv_${r}`
        parsedTracks.push({
          track_id: tid,
          spotify_uri: uri || null,
          track_name: name || `Track ${r}`,
          artist_uris: getVal(iArtUris),
          artist,
          album_uri: getVal(iAlbUri),
          album_name: getVal(iAlbName),
          album_artist_uris: getVal(iAlbArtUris),
          album_artist_names: getVal(iAlbArtNames),
          album_release_date: getVal(iAlbDate),
          album_image_url: getVal(iAlbImg),
          disc_number: getVal(iDisc) || '1',
          track_number: getVal(iTrackNum) || String(r),
          duration_ms: Number(getVal(iDur) || 0),
          preview_url: getVal(iPrev),
          explicit: getVal(iExp) || 'false',
          popularity: getVal(iPop),
          isrc: getVal(iIsrc),
          added_by: getVal(iAddedBy),
          added_at: getVal(iAddedAt),
        })
      }

      if (parsedTracks.length === 0) {
        setError('Không đọc được bài hát nào từ file CSV.')
        return
      }

      setExtractedSpotifyTracks(parsedTracks)
      const seq = await sequencePlaylist({ tracks: parsedTracks, model: selectedModel })
      setSequenceResult(seq)
      const msg = `Đã nạp toàn bộ ${parsedTracks.length} bài từ "${file.name}" và sắp xếp liền mạch theo ${PLAYLIST_MODEL_LABELS[selectedModel]} (giảm ${seq.cost_reduction_percent}% độ gãy giai điệu)!`
      setSuccessMsg(msg)
      toast.success(msg)
    } catch (err) {
      setError(err.message)
      toast.error(err.message)
    } finally {
      setLoading(false)
      e.target.value = ''
    }
  }

  async function handleCopySpotifyUris() {
    if (activeTracks.length === 0) return
    const uris = activeTracks
      .map((t) => {
        if (t.spotify_uri) return t.spotify_uri
        if (t.track_id && String(t.track_id).length === 22) return `spotify:track:${t.track_id}`
        return `${t.track_name} - ${t.artist}`
      })
      .join('\n')

    try {
      await navigator.clipboard.writeText(uris)
      toast.success(`Đã copy ${activeTracks.length} Spotify Track URIs! Dán Ctrl+V vào Spotify Desktop ngay.`)
    } catch {
      toast.error('Không thể tự động copy vào clipboard.')
    }
  }

  return (
    <section className="playlist-studio">
      <div className="studio-page-header">
        <h2>🎛️ Smart Playlist Studio — Tự Tải Local, AI DJ Mixing &amp; Spotify Crossfade</h2>
        <p className="text-muted small">
          Dán playlist Spotify, tự động tải tối đa <strong>20 bản audio</strong> về cục bộ để AI can thiệp sắp xếp đồng bộ giai điệu &amp; BPM, sau đó nghe liền mạch ngay với tính năng <strong>Crossfade giống Spotify</strong>.
        </p>
      </div>

      <div className="studio-grid-layout">
        {/* Control Panel */}
        <div className="card-box spotify-section">
          <h3>1. Nhập Playlist &amp; Cấu Hình AI DJ Local Mix (Limit ≤ 20 bài)</h3>
          <p className="text-muted small">
            Dán link playlist Spotify công khai (hoặc thử nhanh link mẫu bên dưới). Bạn có thể phân tích toàn bộ hoặc giới hạn ≤ 20 bài tải local để nghe DJ Mix mượt mà ngay lập tức.
          </p>

          <form onSubmit={handleParseSpotify} className="spotify-form">
            <input
              type="text"
              value={spotifyInput}
              onChange={(e) => setSpotifyInput(e.target.value)}
              placeholder="Dán link playlist Spotify vào đây (vd: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M)..."
            />
            <Button type="button" variant="secondary" size="sm" onClick={handleParseSpotify}>
              Xem Player
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSpotifyInput('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')}
              title="Điền nhanh link Spotify Today's Top Hits"
            >
              Link mẫu
            </Button>
          </form>

          <div className="studio-csv-import-row">
            <span className="text-muted small">Hoặc nạp trực tiếp file từ máy:</span>
            <label className="btn btn-outline btn-sm csv-upload-label">
              📂 Import CSV (Exportify)
              <input
                type="file"
                accept=".csv"
                onChange={handleImportCsvFile}
                style={{ display: 'none' }}
              />
            </label>

            {cacheStatus && (
              <div className="local-cache-chip">
                <span>
                  💾 Cache Local: <strong>{cacheStatus.cached_files}/{cacheStatus.max_limit}</strong> bản ({cacheStatus.total_size_mb} MB)
                </span>
                {cacheStatus.cached_files > 0 && (
                  <button
                    type="button"
                    className="btn-clear-mini"
                    onClick={handleClearDiskAudioCache}
                    title="Dọn sạch file audio đã tải cục bộ"
                  >
                    🗑️ Xóa Audio Cache
                  </button>
                )}
              </div>
            )}

            {audioConfig && (
              <div
                className={`resolver-mode-chip ${(audioConfig.rapidapi_configured || audioConfig.native_engine_available) ? 'is-full' : 'is-preview'}`}
                title={
                  audioConfig.native_engine_available
                    ? 'Đang dùng Spodown Native Engine (yt-dlp + ffmpeg) & RapidAPI để lấy 100% Full Audio'
                    : audioConfig.rapidapi_configured
                    ? `Đang dùng ${audioConfig.primary_host} & ${audioConfig.backup_host} để lấy Full Audio`
                    : 'Chưa cấu hình Full Audio — đang dùng fallback nghe thử 30s'
                }
              >
                {audioConfig.native_engine_available
                  ? '⚡ Full Audio (Spodown Engine: 100% Full)'
                  : audioConfig.rapidapi_configured
                  ? `⚡ Full Audio (RapidAPI: ${audioConfig.primary_host})`
                  : '⏱️ Preview 30s Mode'}
              </div>
            )}
          </div>

          <fieldset className="model-picker studio-model-picker">
            <legend>Chọn Thuật Toán Can Thiệp &amp; Sắp Xếp Giai Điệu</legend>
            {Object.entries(PLAYLIST_MODEL_LABELS).map(([modeKey, label]) => (
              <label key={modeKey} className={selectedModel === modeKey ? 'selected' : ''}>
                <input
                  type="radio"
                  name="studio_model"
                  value={modeKey}
                  checked={selectedModel === modeKey}
                  onChange={() => handleModelChange(modeKey)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="text-muted small studio-model-hint">💡 {MODEL_DESCRIPTIONS[selectedModel]}</p>

          {/* Local Audio Limit & Spotify Crossfade Panel */}
          <div className="studio-dj-settings-grid">
            <div className="dj-setting-box">
              <div className="dj-setting-title">
                <span>🎚️ Kiểm soát giới hạn tải Audio Local</span>
                <Badge variant="info" size="sm">Tối đa {MAX_LOCAL_AUDIO_LIMIT} bản</Badge>
              </div>
              <div className="limit-pill-group">
                {AUDIO_LIMIT_OPTIONS.map((num) => (
                  <button
                    key={num}
                    type="button"
                    className={`limit-pill-btn ${maxAudioLimit === num ? 'active' : ''}`}
                    onClick={() => setMaxAudioLimit(num)}
                  >
                    {num} bài {num === MAX_LOCAL_AUDIO_LIMIT ? '(Max)' : ''}
                  </button>
                ))}
              </div>
              <div className="selection-mode-row">
                <label className="small text-muted">Khi playlist &gt; {maxAudioLimit} bài:</label>
                <select
                  className="ui-select"
                  value={selectionMode}
                  onChange={(e) => setSelectionMode(e.target.value)}
                >
                  <option value="smart_cohesive">AI lọc {maxAudioLimit} bài đồng điệu nhất (Khuyên dùng)</option>
                  <option value="first_n">Lấy {maxAudioLimit} bài đầu danh sách</option>
                </select>
              </div>
            </div>

            <div className="dj-setting-box">
              <div className="dj-setting-title">
                <span>🎧 Spotify Crossfade &amp; Beatmatch Sync</span>
                <label className="inline-switch-label small">
                  <input
                    type="checkbox"
                    checked={crossfadeEnabled}
                    onChange={(e) => setCrossfadeEnabled(e.target.checked)}
                  />
                  <span>{crossfadeEnabled ? `Bật (${crossfadeSeconds}s)` : 'Đang tắt'}</span>
                </label>
              </div>
              <div className="studio-cf-slider-row">
                <span className="small text-muted">0s</span>
                <input
                  type="range"
                  min="0"
                  max="12"
                  step="1"
                  disabled={!crossfadeEnabled}
                  value={crossfadeEnabled ? crossfadeSeconds : 0}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setCrossfadeSeconds(v)
                    if (v > 0 && !crossfadeEnabled) setCrossfadeEnabled(true)
                  }}
                  className="cf-range-slider flex-1"
                  style={{
                    background: `linear-gradient(to right, #1db954 ${((crossfadeEnabled ? crossfadeSeconds : 0) / 12) * 100}%, #334155 ${((crossfadeEnabled ? crossfadeSeconds : 0) / 12) * 100}%)`,
                  }}
                />
                <span className="small text-muted">12s</span>
              </div>
              <label className="inline-switch-label small text-muted" style={{ marginTop: '0.45rem' }}>
                <input
                  type="checkbox"
                  checked={autoAiMixEnabled}
                  onChange={(e) => setAutoAiMixEnabled(e.target.checked)}
                />
                <span>AI Tự cân âm lượng (Loudness) &amp; Khớp nhịp BPM khi chuyển bài</span>
              </label>
            </div>
          </div>

          <div className="studio-main-actions">
            <Button
              type="button"
              variant="spotify"
              size="lg"
              loading={makingLocalMix}
              onClick={() => handleDownloadAndPlayDjMix(true)}
              className="studio-extract-btn"
            >
              {makingLocalMix
                ? `Đang tải audio về local (≤${maxAudioLimit} bài) & Make DJ Mix...`
                : `🎧 Tự Down Local (${maxAudioLimit} bài) & Make DJ Mix · Nghe Luôn`}
            </Button>

            <Button
              type="button"
              variant="secondary"
              size="lg"
              loading={extractingSpotify || loading}
              onClick={() => handleExtractAndSequenceSpotify(selectedModel)}
            >
              {extractingSpotify
                ? 'Đang bóc tách toàn bộ...'
                : extractedSpotifyTracks.length > 0
                  ? `🔎 Phân tích toàn bộ (${extractedSpotifyTracks.length} bài)`
                  : '🔎 Chỉ bóc tách toàn bộ & xem 9 đặc trưng'}
            </Button>

            {(spotifyInput || extractedSpotifyTracks.length > 0 || sequenceResult) && (
              <Button type="button" variant="danger" size="md" onClick={handleClearStudio}>
                🔄 Làm mới
              </Button>
            )}
          </div>

          {successMsg && <p className="success-msg small">{successMsg}</p>}
          {error && <p className="error small" role="alert">{error}</p>}

          <SpotifyPlayer playlistId={spotifyId} />
        </div>

        {/* Results & 9-Feature Comparison Section */}
        <div className="card-box studio-results-card">
          <div className="result-header">
            <div>
              <h3>2. Danh Sách Mix Đã Tối Ưu &amp; Bảng Thông Số 9 Đặc Trưng</h3>
              {activeTracks.length > 0 && (
                <span className="text-muted small">
                  Hiển thị <strong>{activeTracks.length}</strong> bài hát
                  {sequenceResult?.download_stats && (
                    <>
                      {' '}· Đã lưu Local: <strong>{sequenceResult.download_stats.ready_local}/{sequenceResult.tracks.length}</strong> bản audio
                      {sequenceResult.download_stats.full_count > 0 && (
                        <> · Full: <strong>{sequenceResult.download_stats.full_count}</strong></>
                      )}
                    </>
                  )}
                </span>
              )}
            </div>
            {sequenceResult && (
              <div className="result-badges-cluster">
                <Badge variant="success" size="md">
                  Giảm {sequenceResult.cost_reduction_percent}% gãy giai điệu
                </Badge>
                {sequenceResult.avg_smoothness_percent != null && (
                  <Badge variant="spotify" size="md">
                    Độ mượt Mix: {sequenceResult.avg_smoothness_percent}%
                  </Badge>
                )}
              </div>
            )}
          </div>

          {activeTracks.length > 0 && (
            <>
              {/* Action Toolbar */}
              <div className="export-toolbar">
                <Button
                  variant="spotify"
                  size="sm"
                  onClick={() => playQueue(activeTracks, 0, { title: sequenceResult?.title || 'AI DJ Mix' })}
                >
                  ▶ Phát Mix Liền Mạch ({activeTracks.length} bài · Crossfade {crossfadeEnabled ? `${crossfadeSeconds}s` : 'Off'})
                </Button>
                <Button variant="secondary" size="sm" onClick={handleExportCsv}>
                  📥 Xuất CSV Spotify (19 cột)
                </Button>
                <Button variant="secondary" size="sm" onClick={handleCopySpotifyUris}>
                  📋 Copy {activeTracks.length} URIs
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleInfill('infill')}
                  loading={loading}
                >
                  ✨ Chèn bài cầu nối (Infill)
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleInfill('append')}
                  loading={loading}
                >
                  ➕ Nối dài Playlist
                </Button>
              </div>

              {/* Sequence Optimization Summary */}
              {sequenceResult && (
                <div className="metric-compare-bar">
                  <div>
                    <span className="text-muted small">Thuật toán: </span>
                    <strong className="pill">{PLAYLIST_MODEL_LABELS[sequenceResult.model || selectedModel] || sequenceResult.model}</strong>
                  </div>
                  <div>
                    <span className="text-muted small">Chi phí gốc: </span>
                    <strong>{sequenceResult.original_transition_cost.toFixed(4)}</strong>
                  </div>
                  <div>
                    <span className="text-muted small">Chi phí sau Mix: </span>
                    <strong style={{ color: '#4ade80' }}>
                      {sequenceResult.optimized_transition_cost.toFixed(4)}
                    </strong>
                  </div>
                  {sequenceResult.avg_bpm_jump != null && (
                    <div>
                      <span className="text-muted small">Độ lệch BPM TB: </span>
                      <strong>±{sequenceResult.avg_bpm_jump} BPM</strong>
                    </div>
                  )}
                  <div>
                    <span className="text-muted small">Tổng bài phát: </span>
                    <strong>{activeTracks.length} bài</strong>
                  </div>
                </div>
              )}

              {/* DJ Flow Sparkline Curve */}
              <DjFlowSparkline tracks={activeTracks} />

              {/* 9-Feature Playlist Average Overview */}
              {featureAverages && (
                <div className="ps-averages-section">
                  <div className="ps-averages-title">
                    <span>📊 Trung Bình 9 Đặc Trưng Âm Học Toàn Playlist ({activeTracks.length} bài)</span>
                  </div>
                  <div className="ps-averages-grid">
                    {AUDIO_FEATURE_KEYS.map((feat) => (
                      <div key={feat.key} className="ps-avg-cell" title={`${feat.vi} (${feat.label})`}>
                        <span className="ps-avg-label">{feat.label}</span>
                        <strong className="ps-avg-val">{formatFeatureValue(featureAverages, feat)}</strong>
                        <span className="ps-avg-sub text-muted">{feat.vi}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Result View Mode Switcher */}
              <div className="track-list-toolbar" style={{ marginTop: '1.25rem' }}>
                <div className="view-mode-toggle" role="group" aria-label="Chế độ xem Playlist">
                  <button
                    type="button"
                    className={`view-toggle-btn ${resultViewMode === 'flow' ? 'active' : ''}`}
                    onClick={() => setResultViewMode('flow')}
                  >
                    🌊 Dòng chảy &amp; Thông số Mix từng bài
                  </button>
                  <button
                    type="button"
                    className={`view-toggle-btn ${resultViewMode === 'matrix' ? 'active' : ''}`}
                    onClick={() => setResultViewMode('matrix')}
                  >
                    📊 Bảng so sánh 9 đặc trưng ({activeTracks.length} bài)
                  </button>
                </div>

                {resultViewMode === 'matrix' && (
                  <div className="matrix-sort-controls">
                    <span className="small text-muted">Sắp xếp bảng theo:</span>
                    <select
                      className="ui-select"
                      value={sortByFeature}
                      onChange={(e) => setSortByFeature(e.target.value)}
                    >
                      <option value="step">Thứ tự tối ưu AI (#1 → #{activeTracks.length})</option>
                      {AUDIO_FEATURE_KEYS.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label} ({f.vi}) cao → thấp
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Empty State vs Active Results */}
          {activeTracks.length === 0 ? (
            <div className="empty-state">
              <p className="text-muted">
                Dán link Playlist Spotify ở khung trên (hoặc bấm <strong>&quot;Link mẫu&quot;</strong>) rồi nhấn{' '}
                <strong>&quot;🎧 Tự Down Local (20 bài) &amp; Make DJ Mix · Nghe Luôn&quot;</strong> để model chọn lọc tối đa 20 bài hát, tự động tải về máy, đồng bộ giai điệu và phát ngay với hiệu ứng Crossfade!
              </p>
            </div>
          ) : resultViewMode === 'flow' ? (
            <ol className="sequenced-list">
              {activeTracks.map((t, idx) => {
                const isInserted = Boolean(t.is_inserted)
                const simNext = t.transition_similarity_to_next
                const mixPlan = t.mix_plan
                const showTransition = idx < activeTracks.length - 1 && (simNext != null || mixPlan != null)
                const af = t.audio_features || t
                const deltas = t.deltas_to_next
                const isPlayingRow = currentTrack?.track_id === t.track_id && isPlaying

                return (
                  <li key={`${t.track_id}_${idx}`} className={`sequence-item ${isInserted ? 'inserted-item' : ''}`}>
                    <div className={`sequence-card ${isPlayingRow ? 'is-playing-card' : ''}`}>
                      <div className="sequence-card-top">
                        <span className="sequence-index">#{t.step ?? idx + 1}</span>
                        <button
                          type="button"
                          className="row-play-btn"
                          onClick={() => handlePlayTrackInMix(idx)}
                          title="Phát DJ Mix từ bài hát này (tự động crossfade sang các bài tiếp theo)"
                        >
                          {isPlayingRow ? '⏸' : '▶'}
                        </button>
                        <div className="sequence-info">
                          <div className="sequence-title-line">
                            <strong title={t.track_name}>{t.track_name}</strong>
                            {t.original_step != null && t.original_step !== (t.step ?? idx + 1) && (
                              <span className="orig-step-chip" title="Vị trí ban đầu trong playlist gốc">
                                Gốc #{t.original_step}
                              </span>
                            )}
                            {t.audio_cached && (
                              <span className="local-ready-chip" title="Bản audio đã tải sẵn ở backend local">
                                💾 Local Ready
                              </span>
                            )}
                            {t.audio_kind === 'full' && (
                              <span className="full-audio-chip" title="Bản nhạc đầy đủ (Full Audio)">
                                🎵 Full
                              </span>
                            )}
                            {t.audio_kind === 'preview' && (
                              <span className="preview-audio-chip" title="Bản nghe thử 30s (Preview)">
                                ⏱️ 30s
                              </span>
                            )}
                            {t.loudness_trim_db != null && (
                              <span className="gain-trim-chip" title="Hệ số cân bằng âm lượng tự động của mô hình DJ">
                                Gain: {t.loudness_trim_db > 0 ? `+${t.loudness_trim_db}` : t.loudness_trim_db} dB
                              </span>
                            )}
                          </div>
                          <span className="text-muted small">
                            {t.artist || t.artist_name} · Popularity: {t.popularity ?? '—'}/100 · {t.vibe_label || 'Cân bằng'}
                          </span>
                          {isInserted && (
                            <span className="pill small inserted-badge">
                              {t.reason || 'Bài chèn tương thích AI'}
                            </span>
                          )}
                        </div>
                        {(t.spotify_uri || t.track_id) && (
                          <a
                            href={`https://open.spotify.com/track/${(t.spotify_uri || t.track_id).replace('spotify:track:', '')}`}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-outline btn-sm"
                            style={{ textDecoration: 'none' }}
                          >
                            Spotify ↗
                          </a>
                        )}
                      </div>

                      {/* All 9 Acoustic Features Grid per Track */}
                      <div className="sequence-9-features-grid">
                        {AUDIO_FEATURE_KEYS.map((feat) => {
                          const barPct = getFeatureBarWidth(af, feat)
                          const avgVal = featureAverages?.[feat.key]
                          const curVal = Number(af?.[feat.key] ?? 0)
                          const diffFromAvg = avgVal != null ? curVal - avgVal : 0
                          const isAbove = diffFromAvg > 0.05
                          return (
                            <div key={feat.key} className="seq-feat-pill">
                              <div className="seq-feat-head">
                                <span className="seq-feat-name">{feat.label}</span>
                                <span className={`seq-feat-val ${isAbove ? 'above-avg' : ''}`}>
                                  {formatFeatureValue(af, feat)}
                                </span>
                              </div>
                              <div className="seq-feat-bar-bg">
                                <div className="seq-feat-bar-fill" style={{ width: `${barPct}%` }} />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {showTransition && (
                      <div className="transition-connector" aria-hidden="true">
                        <span className="transition-line" />
                        <div className="transition-badge-group">
                          <span
                            className="transition-pill"
                            style={{
                              color: (simNext ?? 0.7) >= 0.65 ? '#4ade80' : (simNext ?? 0.5) >= 0.4 ? '#fbbf24' : '#f87171',
                            }}
                          >
                            {mixPlan ? `🎛️ ${mixPlan.mix_style}` : 'Liền mạch'}: {simNext != null ? `${(simNext * 100).toFixed(1)}%` : ''}
                          </span>
                          {mixPlan && (
                            <span className="transition-cf-tag">
                              Crossfade gợi ý: {mixPlan.recommended_crossfade_sec}s · Khớp BPM {mixPlan.bpm_match_percent}%
                            </span>
                          )}
                          {deltas && (
                            <span className="transition-deltas small text-muted">
                              Δ Energy: {formatDelta(deltas.energy, AUDIO_FEATURE_KEYS[1])} · Δ Tempo: {formatDelta(deltas.tempo, AUDIO_FEATURE_KEYS[3])} · Δ Valence: {formatDelta(deltas.valence, AUDIO_FEATURE_KEYS[2])}
                            </span>
                          )}
                        </div>
                        <span className="transition-line" />
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          ) : (
            /* Full 9-Feature Comparison Matrix Table */
            <div className="ps-matrix-table-wrap">
              <table className="ps-matrix-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Bài hát / Nghệ sĩ</th>
                    <th>Pop</th>
                    {AUDIO_FEATURE_KEYS.map((feat) => (
                      <th
                        key={feat.key}
                        className={`sortable-th ${sortByFeature === feat.key ? 'sorted-col' : ''}`}
                        onClick={() => setSortByFeature(feat.key)}
                        title={`Nhấn để sắp xếp theo ${feat.vi}`}
                      >
                        {feat.label}
                      </th>
                    ))}
                    <th>Chuyển bài</th>
                  </tr>
                </thead>
                <tbody>
                  {featureAverages && (
                    <tr className="matrix-avg-row">
                      <td>Ø</td>
                      <td>
                        <strong>Trung bình toàn Playlist</strong>
                        <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                          Mốc đối chiếu ({activeTracks.length} bài)
                        </div>
                      </td>
                      <td>—</td>
                      {AUDIO_FEATURE_KEYS.map((feat) => (
                        <td key={feat.key} className="num">
                          <strong>{formatFeatureValue(featureAverages, feat)}</strong>
                        </td>
                      ))}
                      <td>—</td>
                    </tr>
                  )}

                  {sortedMatrixTracks.map((t, idx) => {
                    const af = t.audio_features || t
                    const simNext = t.transition_similarity_to_next
                    const isPlayingRow = currentTrack?.track_id === t.track_id && isPlaying
                    const playIdx = activeTracks.findIndex((item) => item.track_id === t.track_id)
                    return (
                      <tr key={`${t.track_id}_m_${idx}`} className={isPlayingRow ? 'active-playing-row' : ''}>
                        <td className="num">
                          <div className="matrix-rank-cell">
                            <span>#{t.step ?? idx + 1}</span>
                            <button
                              type="button"
                              className="matrix-play-btn"
                              onClick={() => handlePlayTrackInMix(playIdx >= 0 ? playIdx : idx)}
                              title="Phát DJ Mix từ bài này"
                            >
                              {isPlayingRow ? '⏸' : '▶'}
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="matrix-track-cell">
                            <strong title={t.track_name}>
                              {t.audio_cached ? '💾 ' : ''}
                              {t.track_name}
                            </strong>
                            <span className="text-muted" style={{ fontSize: '0.74rem' }}>
                              {t.artist || t.artist_name}
                            </span>
                          </div>
                        </td>
                        <td className="num">{t.popularity ?? '—'}</td>
                        {AUDIO_FEATURE_KEYS.map((feat) => {
                          const cur = Number(af?.[feat.key] ?? 0)
                          const avg = featureAverages?.[feat.key] ?? cur
                          const diff = cur - avg
                          const cls =
                            feat.key === 'tempo'
                              ? diff > 15
                                ? 'val-high'
                                : diff < -15
                                  ? 'val-low'
                                  : ''
                              : feat.key === 'loudness'
                                ? diff > 3
                                  ? 'val-high'
                                  : diff < -3
                                    ? 'val-low'
                                    : ''
                                : diff > 0.15
                                  ? 'val-high'
                                  : diff < -0.15
                                    ? 'val-low'
                                    : ''
                          return (
                            <td
                              key={feat.key}
                              className={`num ${cls} ${sortByFeature === feat.key ? 'sorted-col-cell' : ''}`}
                              title={`Chênh lệch so với trung bình: ${diff >= 0 ? '+' : ''}${(diff * feat.scale).toFixed(feat.decimals)}${feat.unit}`}
                            >
                              {formatFeatureValue(af, feat)}
                            </td>
                          )
                        })}
                        <td className="num">
                          {simNext != null ? (
                            <span
                              style={{
                                color: simNext >= 0.65 ? '#4ade80' : simNext >= 0.4 ? '#fbbf24' : '#f87171',
                                fontWeight: 700,
                              }}
                            >
                              {(simNext * 100).toFixed(0)}%
                            </span>
                          ) : (
                            'Cuối'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
