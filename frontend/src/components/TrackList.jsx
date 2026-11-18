import { useState } from 'react'
import TrackCard from './music/TrackCard.jsx'
import TrackTableRow from './music/TrackTableRow.jsx'
import { TrackCardSkeleton, TableRowSkeleton } from './common/Skeleton.jsx'
import EmptyState from './common/EmptyState.jsx'

export default function TrackList({
  loading,
  error,
  items,
  emptyText = 'Không tìm thấy bài hát nào.',
  showViewToggle = true,
  onFindSimilar,
}) {
  const [viewMode, setViewMode] = useState('grid') // 'grid' | 'table'

  if (loading) {
    return viewMode === 'grid' ? (
      <TrackCardSkeleton count={6} />
    ) : (
      <TableRowSkeleton rows={8} />
    )
  }

  if (error) {
    return (
      <div className="error-banner" role="alert">
        <span className="error-icon">⚠️</span>
        <div className="error-body">
          <strong>Lỗi nạp bài hát:</strong>
          <p>{error}</p>
        </div>
      </div>
    )
  }

  if (!items) return null

  if (items.length === 0) {
    return (
      <EmptyState
        title="Danh sách trống"
        description={emptyText}
      />
    )
  }

  return (
    <div className="track-list-container">
      {/* View Switcher Header */}
      {showViewToggle && items.length > 0 && (
        <div className="track-list-toolbar">
          <span className="track-count-badge text-muted small">
            Đang hiển thị <strong>{items.length}</strong> bài hát
          </span>
          <div className="view-mode-toggle" role="group" aria-label="Chế độ hiển thị">
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              aria-label="Dạng lưới thẻ"
              title="Dạng thẻ (Grid View)"
            >
              ⊞ Thẻ
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              aria-label="Dạng danh sách gọn"
              title="Dạng bảng (Table View)"
            >
              ☰ Bảng
            </button>
          </div>
        </div>
      )}

      {viewMode === 'grid' ? (
        <ol className="track-list">
          {items.map((t, i) => (
            <TrackCard
              key={t.track_id || i}
              rank={t.rank != null ? t.rank : i + 1}
              track={t}
              onFindSimilar={onFindSimilar}
            />
          ))}
        </ol>
      ) : (
        <div className="track-table-wrapper">
          <table className="track-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>#</th>
                <th>Tên bài hát / Nghệ sĩ</th>
                <th>Thể loại</th>
                <th style={{ width: '120px' }}>Điểm số</th>
                <th style={{ width: '110px', textAlign: 'right' }}>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t, i) => (
                <TrackTableRow
                  key={t.track_id || i}
                  rank={t.rank != null ? t.rank : i + 1}
                  track={t}
                  onFindSimilar={onFindSimilar}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
