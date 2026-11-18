export default function Button({
  children,
  variant = 'primary', // 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'spotify'
  size = 'md', // 'sm' | 'md' | 'lg'
  loading = false,
  disabled = false,
  icon = null,
  className = '',
  type = 'button',
  onClick,
  ...rest
}) {
  const baseClass = 'btn'
  const variantClass = `btn-${variant}`
  const sizeClass = size !== 'md' ? `btn-${size}` : ''
  const loadingClass = loading ? 'btn-loading' : ''

  return (
    <button
      type={type}
      className={[baseClass, variantClass, sizeClass, loadingClass, className].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      onClick={onClick}
      {...rest}
    >
      {loading ? (
        <span className="spinner-sm" aria-hidden="true" />
      ) : icon ? (
        <span className="btn-icon" aria-hidden="true">{icon}</span>
      ) : null}
      <span className="btn-text">{children}</span>
    </button>
  )
}
