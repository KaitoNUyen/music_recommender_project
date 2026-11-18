import { useState } from 'react'
import Badge from '../common/Badge.jsx'
import { useAudioPlayer } from '../../hooks/useAudioPlayer.js'
import { usePlaylist } from '../../hooks/usePlaylist.js'

export default function TrackTableRow({
  rank,
  track,
  onFindSimilar,
}) {
  const { playTrack, isPlaying, currentTrack, openSpotifyEmbed } = useAudioPlayer()
  const { addToBasket, isInBasket, removeFromBasket } = usePlaylist()
  const [hovered, setHovered] = useState(false)

  const isCurrentPlaying = currentTrack?.track_id === track.track_id && isPlaying
  const inBasket = isInBasket(track.track_id)
  const artist = track.artist_name || track.artist || 'Nghệ sĩ'
  const score = track.similarity_score ?? track.score

  return (
    <tr
      className={`track-table-row ${isCurrentPlaying ? 'active-playing-row' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <td className="row-col-rank">
        {hovered || isCurrentPlaying ? (
          <button
            type="button"
            className="row-play-btn"
            onClick={() => playTrack(track)}
            aria-label={isCurrentPlaying ? 'Dừng' : 'Phát'}
          >
            {isCurrentPlaying ? '⏸' : '▶'}
          </button>
        ) : (
          <span className="row-rank-text">{rank ?? '•'}</span>
        )}
      </td>

      <td className="row-col-title">
        <div className="row-title-wrap">
          <span
            className="row-track-name"
            onClick={() => openSpotifyEmbed(track)}
            role="button"
            tabIndex={0}
          >
            {track.track_name}
          </span>
          <span className="row-artist-name text-muted">{artist}</span>
        </div>
      </td>

      <td className="row-col-genres">
        <span className="text-muted small truncate-cell">
          {track.artist_genres || '—'}
        </span>
      </td>

      <td className="row-col-score">
        {score != null ? (
          <Badge variant="purple" size="sm">
            {Math.round(score * (score <= 1 ? 100 : 1))}%
          </Badge>
        ) : track.popularity != null ? (
          <span className="small text-muted">{track.popularity}/100</span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>

      <td className="row-col-actions">
        <div className="row-actions-group">
          <button
            type="button"
            className={`row-action-btn ${inBasket ? 'in-basket' : ''}`}
            onClick={() => inBasket ? removeFromBasket(track.track_id) : addToBasket(track)}
            title={inBasket ? 'Xóa khỏi Giỏ gu' : 'Thêm vào Giỏ gu nhạc'}
          >
            {inBasket ? '✓' : '+'}
          </button>
          <button
            type="button"
            className="row-action-btn"
            onClick={() => openSpotifyEmbed(track)}
            title="Mở trình phát Spotify chính thức"
          >
            🎧
          </button>
          {onFindSimilar && (
            <button
              type="button"
              className="row-action-btn"
              onClick={() => onFindSimilar(track)}
              title="Tìm các bài tương tự"
            >
              🔄
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}
