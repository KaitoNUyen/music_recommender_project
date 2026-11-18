import { useState, useEffect } from 'react'
import { fetchTrackMedia, getSimilarTracks } from '../../api/index.js'
import { useAudioPlayer } from '../../hooks/useAudioPlayer.js'
import { usePlaylist } from '../../hooks/usePlaylist.js'
import Tooltip from '../common/Tooltip.jsx'
import Badge from '../common/Badge.jsx'

const COVER_GRADIENTS = [
  'linear-gradient(135deg, #1db954 0%, #0f766e 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
  'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
  'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #6366f1 100%)',
  'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)',
  'linear-gradient(135deg, #f43f5e 0%, #fb923c 100%)',
  'linear-gradient(135deg, #a855f7 0%, #3b82f6 100%)',
]

function pickGradient(id) {
  let hash = 0
  const s = String(id || '')
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return COVER_GRADIENTS[hash % COVER_GRADIENTS.length]
}

export default function TrackCard({ rank, track, onFindSimilar }) {
  const { playTrack, isPlaying, currentTrack, openSpotifyEmbed } = useAudioPlayer()
  const { addToBasket, isInBasket, removeFromBasket } = usePlaylist()

  const [coverUrl, setCoverUrl] = useState(track.album_cover_url || null)
  const [similarOpen, setSimilarOpen] = useState(false)
  const [similarState, setSimilarState] = useState({ loading: false, error: null, items: null })

  const isCurrentPlaying = currentTrack?.track_id === track.track_id && isPlaying
  const inBasket = isInBasket(track.track_id)

  const artist = track.artist_name || track.artist || 'Nghệ sĩ'
  const score = track.similarity_score ?? track.score
  const hasScore = score != null
  const pct = hasScore ? Math.min(100, Math.max(4, score * (score <= 1 ? 100 : 1))) : null
  const rankClass = rank != null && rank <= 3 ? `rank rank-top rank-${rank}` : 'rank'
  const af = track.audio_features

  // Fetch cover art if missing
  useEffect(() => {
    let cancelled = false
    if (!coverUrl && track.track_name) {
      fetchTrackMedia(track.track_name, artist).then((media) => {
        if (!cancelled && media?.album_cover_url) {
          setCoverUrl(media.album_cover_url)
          track.album_cover_url = media.album_cover_url
          if (media.preview_url && !track.preview_url) {
            track.preview_url = media.preview_url
          }
        }
      })
    }
    return () => {
      cancelled = true
    }
  }, [coverUrl, track, artist])

  const handleToggleSimilar = async () => {
    const nextOpen = !similarOpen
    setSimilarOpen(nextOpen)
    if (nextOpen && !similarState.items && !similarState.loading) {
      setSimilarState({ loading: true, error: null, items: null })
      try {
        const items = await getSimilarTracks(track.track_id, 'hybrid', 5)
        setSimilarState({ loading: false, error: null, items })
      } catch (e) {
        setSimilarState({ loading: false, error: e.message, items: [] })
      }
    }
  }

  const handlePlayClick = (e) => {
    e.stopPropagation()
    playTrack(track)
  }

  const handleBasketClick = (e) => {
    e.stopPropagation()
    if (inBasket) {
      removeFromBasket(track.track_id)
    } else {
      addToBasket(track)
    }
  }

  return (
    <li className={`track-card-item ${isCurrentPlaying ? 'is-playing' : ''}`}>
      <div className="track-card">
        {rank != null && <span className={rankClass}>{rank}</span>}

        {/* Album Cover with Play Hover Button */}
        <div
          className="cover-art"
          style={
            coverUrl
              ? { backgroundImage: `url(${coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : { background: pickGradient(track.track_id) }
          }
          onClick={handlePlayClick}
          role="button"
          tabIndex={0}
          title={isCurrentPlaying ? 'Tạm dừng' : 'Phát nhạc (Full nếu có RapidAPI / Preview 30s)'}
        >
          <div className={`cover-art-overlay ${isCurrentPlaying ? 'active' : ''}`}>
            <span className="cover-play-icon">{isCurrentPlaying ? '⏸' : '▶'}</span>
          </div>
          {!coverUrl && (
            <span className="cover-art-default-note" aria-hidden="true">🎵</span>
          )}
        </div>

        {/* Track Metadata */}
        <div className="track-meta" onClick={() => openSpotifyEmbed(track)}>
          <div className="track-name-row">
            <strong className="track-name" title={track.track_name}>
              {track.track_name}
            </strong>
            {isCurrentPlaying && (
              <span className="playing-waveform" title="Đang phát">
                <span className="wave-bar bar-1" />
                <span className="wave-bar bar-2" />
                <span className="wave-bar bar-3" />
              </span>
            )}
          </div>

          <div className="track-sub-row">
            <span className="artist-name" title={artist}>
              {artist}
            </span>
            {track.popularity != null && (
              <span className="track-pop-chip" title="Độ phổ biến trên Spotify">
                🔥 {track.popularity}
              </span>
            )}
          </div>

          {track.artist_genres && (
            <span className="artist-genres-preview text-muted small truncate-cell">
              {track.artist_genres}
            </span>
          )}

          {af && (
            <div className="track-mini-features">
              <span className="mini-feat-pill">⚡ Energy {(af.energy * 100).toFixed(0)}%</span>
              <span className="mini-feat-pill">💃 Dance {(af.danceability * 100).toFixed(0)}%</span>
              <span className="mini-feat-pill">☀️ Valence {(af.valence * 100).toFixed(0)}%</span>
              <span className="mini-feat-pill">⏱️ {Math.round(af.tempo)} BPM</span>
            </div>
          )}

          {/* Score Bar */}
          {hasScore && (
            <div className="score-wrap" title={`Độ tương đồng: ${pct.toFixed(1)}%`}>
              <div className="score-bar">
                <span className="score-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="score-num">{pct.toFixed(0)}% Match</span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="track-actions">
          {onFindSimilar && (
            <Tooltip text="Dùng bài này làm hạt giống để gợi ý">
              <button
                type="button"
                className="btn-seed-pick"
                onClick={() => onFindSimilar(track)}
                aria-label="Chọn làm hạt giống"
              >
                🎯 Hạt giống
              </button>
            </Tooltip>
          )}

          <Tooltip text={inBasket ? 'Xóa khỏi Giỏ gu' : 'Thêm vào Giỏ gu phối nhạc'}>
            <button
              type="button"
              className={`btn-action-icon ${inBasket ? 'in-basket' : ''}`}
              onClick={handleBasketClick}
              aria-label="Thêm vào gu nhạc"
            >
              {inBasket ? '✓ Đã lưu' : '+ Giỏ gu'}
            </button>
          </Tooltip>

          <Tooltip text="Trình phát Spotify chính thức">
            <button
              type="button"
              className="btn-action-icon btn-spotify-icon"
              onClick={() => openSpotifyEmbed(track)}
              aria-label="Spotify"
            >
              🎧 Spotify
            </button>
          </Tooltip>

          <Tooltip text="Xem nhanh 5 bài hát tương tự">
            <button
              type="button"
              className={`btn-similar-toggle ${similarOpen ? 'open' : ''}`}
              onClick={handleToggleSimilar}
              aria-expanded={similarOpen}
              aria-label="Xem bài tương tự"
            >
              {similarOpen ? 'Ẩn tương tự' : 'Tương tự ▾'}
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Similar Tracks Accordion Drawer */}
      {similarOpen && (
        <div className="similar-drawer">
          <div className="similar-drawer-header">
            <span className="small text-muted">Gợi ý tương tự theo thuật toán Hybrid:</span>
            <button
              type="button"
              className="similar-close-btn"
              onClick={() => setSimilarOpen(false)}
            >
              ✕
            </button>
          </div>

          {similarState.loading && (
            <p className="similar-status">Đang tìm các bài hát có rung cảm tương đương...</p>
          )}
          {similarState.error && (
            <p className="similar-status text-danger">{similarState.error}</p>
          )}
          {similarState.items && similarState.items.length === 0 && (
            <p className="similar-status text-muted">Không tìm thấy bài hát tương tự.</p>
          )}

          {similarState.items && similarState.items.length > 0 && (
            <ul className="similar-items-list">
              {similarState.items.map((st) => (
                <li key={st.track_id} className="similar-item-row">
                  <button
                    type="button"
                    className="similar-play-mini"
                    onClick={() => playTrack(st)}
                    title="Nghe thử"
                  >
                    ▶
                  </button>
                  <div className="similar-item-info" onClick={() => openSpotifyEmbed(st)}>
                    <span className="similar-item-title">{st.track_name}</span>
                    <span className="similar-item-artist text-muted">
                      {st.artist_name || st.artist || 'Nghệ sĩ'}
                    </span>
                  </div>
                  {st.similarity_score != null && (
                    <Badge variant="purple" size="sm">
                      {Math.round(st.similarity_score * 100)}%
                    </Badge>
                  )}
                  <button
                    type="button"
                    className="similar-add-btn"
                    onClick={() => addToBasket(st)}
                    title="Thêm vào Giỏ gu nhạc"
                  >
                    + Giỏ gu
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
