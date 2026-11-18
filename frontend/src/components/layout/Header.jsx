import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { getHealth } from '../../api/index.js'
import { clearMediaCache } from '../../api/mediaApi.js'
import { usePlaylist } from '../../hooks/usePlaylist.js'
import { useToast } from '../../hooks/useToast.js'

export default function Header() {
  const [health, setHealth] = useState(null)
  const [latency, setLatency] = useState(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { tasteBasket, clearBasket } = usePlaylist()
  const toast = useToast()

  useEffect(() => {
    const start = performance.now()
    getHealth()
      .then((data) => {
        setHealth(data)
        setLatency(Math.round(performance.now() - start))
      })
      .catch(() => {
        setHealth({ status: 'offline' })
      })
  }, [])

  const handleClearCache = () => {
    try {
      clearMediaCache()
      localStorage.clear()
      clearBasket?.()
      toast.success('Đã xóa sạch bộ nhớ đệm (Cache & LocalStorage)!')
    } catch {
      toast.info('Đã làm sạch bộ nhớ tạm.')
    }
  }

  const currentPath = location.pathname
  const isTabActive = (path) => {
    if (path === '/' && currentPath === '/') return true
    if (path !== '/' && currentPath.startsWith(path)) return true
    return false
  }

  const navItem = (path, label, badgeCount = 0) => (
    <button
      type="button"
      className={`nav-tab ${isTabActive(path) ? 'active' : ''}`}
      aria-current={isTabActive(path) ? 'page' : undefined}
      onClick={() => navigate(path)}
    >
      <span>{label}</span>
      {badgeCount > 0 && <span className="nav-badge">{badgeCount}</span>}
    </button>
  )

  const isHealthy = health?.status === 'ok'

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="brand" onClick={() => navigate('/')} role="button" tabIndex={0}>
          <div className="brand-logo-icon">🎵</div>
          <div className="brand-text">
            <span className="brand-title">EmBeat AI</span>
            <span className="brand-subtitle">Music Recommender</span>
          </div>
        </div>

        <nav className="header-nav" aria-label="Điều hướng chính">
          {navItem('/', 'Khám Phá AI')}
          {navItem('/playlist-studio', 'Playlist Studio')}
          {navItem('/taste-profile', 'Gu Cá Nhân', tasteBasket.length)}
          {navItem('/model', 'Kiến Trúc AI')}
        </nav>

        <div className="header-status-area">
          <button
            type="button"
            className="btn-clear-cache"
            onClick={handleClearCache}
            title="Xóa toàn bộ bộ nhớ đệm (Media Cache & LocalStorage)"
          >
            🧹 Xóa Cache
          </button>

          <div
            className={`server-health-pill ${isHealthy ? 'status-online' : 'status-offline'}`}
            title={health?.artifact_path ? `Artifact: ${health.artifact_path} (${health.total_tracks} bài hát)` : ''}
          >
            <span className="status-dot" />
            <span className="status-text">
              {isHealthy ? `Backend OK (${health?.total_tracks ? health.total_tracks.toLocaleString() : '29.985'} bài · ${latency}ms)` : 'Backend Offline'}
            </span>
          </div>
        </div>
      </div>
    </header>
  )
}
