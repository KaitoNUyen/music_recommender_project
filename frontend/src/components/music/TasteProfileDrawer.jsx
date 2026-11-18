import { useState } from 'react'
import { usePlaylist } from '../../hooks/usePlaylist.js'
import Button from '../common/Button.jsx'

export default function TasteProfileDrawer({ onGenerateProfile, loading = false }) {
  const { tasteBasket, removeFromBasket, clearBasket } = usePlaylist()
  const [isExpanded, setIsExpanded] = useState(false)
  const [alpha, setAlpha] = useState(0.7)

  if (tasteBasket.length === 0) return null

  const handleGenerate = () => {
    const trackIds = tasteBasket.map((t) => t.track_id)
    onGenerateProfile?.({ trackIds, alpha })
  }

  return (
    <div className={`taste-profile-dock ${isExpanded ? 'expanded' : ''}`}>
      <div className="taste-dock-bar">
        <div className="taste-dock-left" onClick={() => setIsExpanded(!isExpanded)}>
          <span className="taste-dock-icon">🧪</span>
          <div className="taste-dock-info">
            <span className="taste-dock-title">
              Giỏ gu nhạc ({tasteBasket.length} bài)
            </span>
            <span className="taste-dock-sub text-muted">
              {isExpanded ? 'Bấm để thu gọn' : 'Bấm để xem danh sách & phối đề xuất'}
            </span>
          </div>
        </div>

        <div className="taste-dock-actions">
          <Button
            variant="spotify"
            size="sm"
            onClick={handleGenerate}
            loading={loading}
          >
            Phối đề xuất AI
          </Button>
          <button
            type="button"
            className="taste-dock-toggle"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-label={isExpanded ? 'Thu gọn giỏ' : 'Mở rộng giỏ'}
          >
            {isExpanded ? '▼' : '▲'}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="taste-dock-body">
          <div className="taste-slider-row">
            <label className="taste-slider-label">
              <span>Độ sâu âm học vs Thể loại: <strong>{Math.round(alpha * 100)}% Audio / {Math.round((1 - alpha) * 100)}% Genre</strong></span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={alpha}
                onChange={(e) => setAlpha(Number(e.target.value))}
                className="taste-slider-input"
              />
            </label>
            <button type="button" className="text-danger small btn-link" onClick={clearBasket}>
              Xóa tất cả
            </button>
          </div>

          <div className="taste-track-chips">
            {tasteBasket.map((t) => (
              <span key={t.track_id} className="taste-chip">
                <span className="taste-chip-name">{t.track_name}</span>
                <button
                  type="button"
                  className="taste-chip-remove"
                  onClick={() => removeFromBasket(t.track_id)}
                  aria-label={`Xóa bài ${t.track_name}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
