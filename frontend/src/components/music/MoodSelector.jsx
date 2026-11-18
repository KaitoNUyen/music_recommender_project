import { MOODS } from '../../api/musicApi.js'

export default function MoodSelector({ selectedMood, onSelectMood, loading = false }) {
  return (
    <div className="mood-selector-container">
      <div className="mood-header">
        <span className="mood-title">✨ Khám phá theo Cảm xúc (Acoustic Moods)</span>
        {selectedMood && (
          <button
            type="button"
            className="mood-clear-btn"
            onClick={() => onSelectMood(null)}
          >
            Bỏ chọn
          </button>
        )}
      </div>

      <div className="mood-pill-grid">
        {MOODS.map((m) => {
          const isSelected = selectedMood === m.id
          return (
            <button
              key={m.id}
              type="button"
              className={`mood-pill ${isSelected ? 'selected' : ''}`}
              style={{
                '--mood-color': m.color,
                borderColor: isSelected ? m.color : 'transparent',
              }}
              onClick={() => onSelectMood(isSelected ? null : m.id)}
              disabled={loading}
              title={m.desc}
            >
              <span className="mood-icon">{m.icon}</span>
              <span className="mood-label">{m.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
