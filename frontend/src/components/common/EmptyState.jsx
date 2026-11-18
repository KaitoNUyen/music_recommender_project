export default function EmptyState({
  icon = '🎵',
  title = 'Không có bài hát nào',
  description = 'Thử tìm kiếm với từ khóa khác hoặc làm mới lại đề xuất.',
  action = null,
  className = '',
}) {
  return (
    <div className={`empty-state-card ${className}`}>
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-desc">{description}</p>
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
