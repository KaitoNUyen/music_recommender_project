import { useState } from 'react'

export default function Tooltip({ text, children, position = 'top' }) {
  const [visible, setVisible] = useState(false)

  if (!text) return children

  return (
    <span
      className="tooltip-container"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span className={`tooltip-bubble tooltip-${position}`} role="tooltip">
          {text}
        </span>
      )}
    </span>
  )
}
