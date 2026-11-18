import { useState } from 'react'
import { usePlaylist } from '../hooks/usePlaylist.js'
import { useToast } from '../hooks/useToast.js'
import { recommendByTasteProfile } from '../api/index.js'
import TrackList from '../components/TrackList.jsx'
import Button from '../components/common/Button.jsx'
import Tooltip from '../components/common/Tooltip.jsx'

export default function TasteProfilePage() {
  const { tasteBasket, removeFromBasket, clearBasket } = usePlaylist()
  const toast = useToast()

  const [alpha, setAlpha] = useState(0.7)
  const [k, setK] = useState(12)
  const [excludeSameArtist, setExcludeSameArtist] = useState(true)

  const [state, setState] = useState({ loading: false, error: null, data: null })

  const handleGenerate = async () => {
    if (tasteBasket.length === 0) {
      toast.warning('Vui lòng thêm ít nhất 1 bài hát vào giỏ gu nhạc.')
      return
    }

    const trackIds = tasteBasket.map((t) => t.track_id)
    setState({ loading: true, error: null, data: null })
    try {
      const res = await recommendByTasteProfile({
        trackIds,
        alpha,
        k,
        excludeSameArtist,
      })
      setState({
        loading: false,
        error: null,
        data: res,
      })
      toast.success(`Đã tạo đề xuất gu nhạc từ ${trackIds.length} bài hát!`)
    } catch (err) {
      setState({ loading: false, error: err.message, data: null })
      toast.error('Lỗi khi phối gu nhạc.')
    }
  }

  const handleCopyUris = () => {
    const list = state.data?.recommendations || tasteBasket
    if (list.length === 0) return
    const uris = list.map((t) => `spotify:track:${t.track_id}`).join('\n')
    navigator.clipboard.writeText(uris)
    toast.success(`Đã sao chép ${list.length} Spotify Track URIs vào clipboard!`)
  }

  return (
    <section className="page-taste-container">
      <div className="taste-page-header">
        <h2>🧪 Hồ Sơ Gu Nhạc Cá Nhân (Multi-Track Centroid)</h2>
        <p className="text-muted">
          Gom nhiều bài hát yêu thích để AI tính toán tâm điểm vector đa chiều trong không gian 9 đặc trưng âm học kết hợp sở thích thể loại.
        </p>
      </div>

      <div className="taste-management-card">
        <div className="taste-card-top">
          <h3>Danh sách bài hát trong Giỏ gu ({tasteBasket.length}/15 bài)</h3>
          {tasteBasket.length > 0 && (
            <button type="button" className="text-danger small btn-link" onClick={clearBasket}>
              Xóa tất cả
            </button>
          )}
        </div>

        {tasteBasket.length === 0 ? (
          <div className="taste-empty-hint">
            <p className="text-muted">
              Giỏ gu nhạc đang trống. Hãy bấm nút <strong>&quot;+ Giỏ gu&quot;</strong> tại bất kỳ bài hát nào trên trang <strong>Khám Phá AI</strong> để đưa vào giỏ.
            </p>
          </div>
        ) : (
          <div className="taste-chips-grid">
            {tasteBasket.map((t) => (
              <div key={t.track_id} className="taste-item-card">
                <div className="taste-item-info">
                  <span className="taste-item-title">{t.track_name}</span>
                  <span className="taste-item-artist text-muted">{t.artist_name || t.artist}</span>
                </div>
                <button
                  type="button"
                  className="taste-item-del-btn"
                  onClick={() => removeFromBasket(t.track_id)}
                  title="Xóa bài này"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {tasteBasket.length > 0 && (
          <div className="taste-controls-row">
            <div className="param-slider-cell flex-1">
              <div className="slider-label-row">
                <span>Độ sâu âm học vs Thể loại: <strong>{Math.round(alpha * 100)}% Audio / {Math.round((1 - alpha) * 100)}% Genre</strong></span>
                <Tooltip text="Trọng số kết hợp giữa 9 đặc trưng sóng âm và nhãn thể loại nghệ sĩ">
                  <span className="info-icon">ℹ</span>
                </Tooltip>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={alpha}
                onChange={(e) => setAlpha(Number(e.target.value))}
                className="ui-slider"
              />
            </div>

            <div className="param-slider-cell" style={{ maxWidth: '140px' }}>
              <div className="slider-label-row">
                <span>Số bài: <strong>{k} bài</strong></span>
              </div>
              <input
                type="range"
                min="5"
                max="30"
                step="1"
                value={k}
                onChange={(e) => setK(Number(e.target.value))}
                className="ui-slider"
              />
            </div>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={excludeSameArtist}
                onChange={(e) => setExcludeSameArtist(e.target.checked)}
              />
              <span>Loại trừ cùng nghệ sĩ</span>
            </label>

            <div className="taste-action-buttons">
              <Button
                variant="spotify"
                size="md"
                onClick={handleGenerate}
                loading={state.loading}
              >
                🚀 Phối Đề Xuất Gu Nhạc AI
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={handleCopyUris}
              >
                📋 Copy Spotify URIs
              </Button>
            </div>
          </div>
        )}
      </div>

      {state.data && (
        <div className="taste-results-wrapper">
          <div className="taste-results-header">
            <h3>Kết quả đề xuất từ tâm điểm Gu Cá Nhân</h3>
            {state.data.latency_ms != null && (
              <span className="text-muted small">Thời gian tính toán: {state.data.latency_ms}ms</span>
            )}
          </div>

          <TrackList
            loading={state.loading}
            error={state.error}
            items={state.data.recommendations}
            emptyText="Không tìm thấy bài hát đề xuất phù hợp."
          />
        </div>
      )}
    </section>
  )
}
