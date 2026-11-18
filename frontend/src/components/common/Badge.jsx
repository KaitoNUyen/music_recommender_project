export default function Badge({
  children,
  variant = 'default', // 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'spotify'
  size = 'md',
  className = '',
  title = '',
  dot = false,
}) {
  return (
    <span
      className={`ui-badge ui-badge-${variant} ui-badge-${size} ${className}`}
      title={title}
    >
      {dot && <span className="ui-badge-dot" />}
      {children}
    </span>
  )
}
