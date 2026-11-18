export function Skeleton({
  width = '100%',
  height = '1rem',
  borderRadius = '6px',
  className = '',
}) {
  return (
    <div
      className={`skeleton-pulse ${className}`}
      style={{ width, height, borderRadius }}
      aria-hidden="true"
    />
  )
}

export function TrackCardSkeleton({ count = 3 }) {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-card">
          <Skeleton width="56px" height="56px" borderRadius="8px" />
          <div className="skeleton-content">
            <Skeleton width="65%" height="1.1rem" />
            <Skeleton width="40%" height="0.85rem" />
          </div>
          <Skeleton width="80px" height="24px" borderRadius="12px" />
        </div>
      ))}
    </div>
  )
}

export function TableRowSkeleton({ rows = 5 }) {
  return (
    <div className="skeleton-table">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-table-row">
          <Skeleton width="28px" height="20px" />
          <Skeleton width="40px" height="40px" borderRadius="6px" />
          <Skeleton width="45%" height="16px" />
          <Skeleton width="20%" height="16px" />
          <Skeleton width="60px" height="24px" borderRadius="12px" />
        </div>
      ))}
    </div>
  )
}
