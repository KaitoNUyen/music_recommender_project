import { useState, useRef } from 'react'

export default function SearchBar({
  placeholder = 'Tìm tên bài hát hoặc nghệ sĩ (vd: Daft Punk, Sơn Tùng, Taylor Swift)...',
  value: controlledValue,
  onChange,
  onSearch,
  loading = false,
  autoFocus = false,
  className = '',
}) {
  const [internalValue, setInternalValue] = useState('')
  const inputRef = useRef(null)

  const isControlled = controlledValue !== undefined
  const query = isControlled ? controlledValue : internalValue

  const handleChange = (e) => {
    const val = e.target.value
    if (!isControlled) {
      setInternalValue(val)
    }
    onChange?.(val)
  }

  const handleClear = () => {
    if (!isControlled) {
      setInternalValue('')
    }
    onChange?.('')
    onSearch?.('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSearch?.(query)
    }
  }

  return (
    <div className={`search-bar-wrapper ${className}`}>
      <span className="search-bar-icon" aria-hidden="true">
        🔍
      </span>
      <input
        ref={inputRef}
        type="search"
        className="search-bar-input"
        placeholder={placeholder}
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
      />
      {loading && <span className="search-bar-spinner" aria-hidden="true" />}
      {!loading && query && (
        <button
          type="button"
          className="search-bar-clear"
          onClick={handleClear}
          aria-label="Xóa từ khóa tìm kiếm"
        >
          ✕
        </button>
      )}
    </div>
  )
}
