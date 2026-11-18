import { useEffect, useState, useCallback } from 'react'
import {
  STRATEGY_LABELS,
  STRATEGY_DESCRIPTIONS,
  recommendPopular,
  recommendByTrack,
  recommendByMood,
  recommendByTasteProfile,
  searchTracks,
} from '../api/index.js'
import TrackList from '../components/TrackList.jsx'
import MoodSelector from '../components/music/MoodSelector.jsx'
import TasteProfileDrawer from '../components/music/TasteProfileDrawer.jsx'
import SearchBar from '../components/common/SearchBar.jsx'
import Button from '../components/common/Button.jsx'
import Badge from '../components/common/Badge.jsx'
import Tooltip from '../components/common/Tooltip.jsx'
import { useToast } from '../hooks/useToast.js'

export default function Home() {
  const toast = useToast()

  // Recommendation Mode: 'popular' | 'seed' | 'mood' | 'taste'
  const [mode, setMode] = useState('popular')
  const [activeMood, setActiveMood] = useState(null)
  const [seedTrack, setSeedTrack] = useState(null)

  // Recommender parameters for EmbeatRecommender
  const [k, setK] = useState(12)
  const [strategy, setStrategy] = useState('hybrid') // 'hybrid' | 'audio' | 'mmr'
  const [alpha, setAlpha] = useState(0.7) // Audio weight vs Genre weight
  const [mmrLambda, setMmrLambda] = useState(0.7) // Relevance vs Diversity
  const [excludeSameArtist, setExcludeSameArtist] = useState(true)

  // Data fetching state
  const [state, setState] = useState({ loading: false, error: null, data: null })

  // Quick Seed Search state
  const [seedSearchQuery, setSeedSearchQuery] = useState('')
  const [seedSearchResults, setSeedSearchResults] = useState(null)
  const [searchingSeed, setSearchingSeed] = useState(false)

  // Load Popularity Baseline
  const loadPopular = useCallback(async (limit = k) => {
    setState({ loading: true, error: null, data: null })
    try {
      const res = await recommendPopular(limit)
      setState({
        loading: false,
        error: null,
        data: {
          title: 'Top Thịnh Hành (Popularity Baseline)',
          modeLabel: 'Cold-Start Baseline',
          items: res.recommendations || [],
          latency: res.latency_ms,
        },
      })
    } catch (err) {
      setState({ loading: false, error: err.message, data: null })
    }
  }, [k])

  // Load Seed Track Recommendation
  const loadSeedRecommendation = useCallback(async (targetTrack, customStrategy = strategy, customAlpha = alpha, customLambda = mmrLambda, customExclude = excludeSameArtist, customK = k) => {
    if (!targetTrack?.track_id) return
    setState({ loading: true, error: null, data: null })
    try {
      const res = await recommendByTrack({
        trackId: targetTrack.track_id,
        k: customK,
        strategy: customStrategy,
        alpha: customAlpha,
        mmrLambda: customLambda,
        excludeSameArtist: customExclude,
      })
      setState({
        loading: false,
        error: null,
        data: {
          title: `Gợi ý theo bài: "${targetTrack.track_name}"`,
          modeLabel: STRATEGY_LABELS[customStrategy] || customStrategy,
          seed: targetTrack,
          items: res.recommendations || [],
          latency: res.latency_ms,
        },
      })
      toast.success(`Đã phân tích âm học theo bài: "${targetTrack.track_name}"`)
    } catch (err) {
      setState({ loading: false, error: err.message, data: null })
      toast.error('Lỗi khi nạp gợi ý theo bài hát.')
    }
  }, [strategy, alpha, mmrLambda, excludeSameArtist, k, toast])

  // Initial mount: load popular tracks
  useEffect(() => {
    loadPopular(12)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Handle Mood click
  const handleSelectMood = async (moodId) => {
    setActiveMood(moodId)
    if (!moodId) {
      setMode('popular')
      loadPopular()
      return
    }

    setMode('mood')
    setState({ loading: true, error: null, data: null })
    try {
      const res = await recommendByMood(moodId, k)
      setState({
        loading: false,
        error: null,
        data: {
          title: `Gợi ý theo Tâm trạng: ${moodId.toUpperCase()}`,
          modeLabel: `Acoustic Mood (${moodId})`,
          items: res.recommendations || [],
          latency: res.latency_ms,
        },
      })
      toast.success(`Đã chọn tâm trạng: ${moodId}`)
    } catch (err) {
      setState({ loading: false, error: err.message, data: null })
      toast.error('Lỗi khi gợi ý theo tâm trạng.')
    }
  }

  // Handle Seed selection from card or search
  const handleSelectSeedTrack = (track) => {
    setSeedTrack(track)
    setMode('seed')
    setActiveMood(null)
    setSeedSearchResults(null)
    setSeedSearchQuery('')
    loadSeedRecommendation(track)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Handle Re-running seed recommendation when parameters change
  const handleApplySeedParams = (e) => {
    e?.preventDefault()
    if (seedTrack) {
      loadSeedRecommendation(seedTrack)
    }
  }

  // Handle Taste Profile Blend
  const handleGenerateTasteProfile = async ({ trackIds, alpha: profileAlpha }) => {
    setMode('taste')
    setActiveMood(null)
    setState({ loading: true, error: null, data: null })
    try {
      const res = await recommendByTasteProfile({
        trackIds,
        alpha: profileAlpha,
        k,
        excludeSameArtist,
      })
      setState({
        loading: false,
        error: null,
        data: {
          title: `Phối gu cá nhân (${trackIds.length} bài hát)`,
          modeLabel: 'Multi-Track Centroid Vector',
          items: res.recommendations || [],
          latency: res.latency_ms,
        },
      })
      toast.success(`Đã phối thành công gu nhạc từ ${trackIds.length} bài hát!`)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      setState({ loading: false, error: err.message, data: null })
      toast.error('Lỗi khi phối gu nhạc.')
    }
  }

  // Quick Seed Search submit
  const handleSeedSearch = async (queryText) => {
    const q = (queryText ?? seedSearchQuery).trim()
    if (!q) {
      setSeedSearchResults(null)
      return
    }
    setSearchingSeed(true)
    try {
      const res = await searchTracks(q, 6)
      setSeedSearchResults(res.results || [])
    } catch {
      setSeedSearchResults([])
    } finally {
      setSearchingSeed(false)
    }
  }

  return (
    <section className="page-home-container">
      {/* Hero Header */}
      <div className="home-hero">
        <h2 className="hero-title">EmBeat AI — Hệ Gợi Ý Âm Nhạc</h2>
        <p className="hero-subtitle text-muted">
          Huấn luyện trên 29,985 bài hát Spotify với 9 đặc trưng sóng âm học, thuật toán Content-Based, Hybrid TF-IDF & Maximal Marginal Relevance (MMR).
        </p>

        {/* Mode Navigation Tabs */}
        <div className="discovery-tabs-row" role="tablist">
          <button
            type="button"
            className={`discovery-tab-btn ${mode === 'popular' ? 'active' : ''}`}
            onClick={() => {
              setMode('popular')
              setActiveMood(null)
              loadPopular()
            }}
          >
            🔥 Top Thịnh Hành
          </button>
          <button
            type="button"
            className={`discovery-tab-btn ${mode === 'seed' ? 'active' : ''}`}
            onClick={() => {
              setMode('seed')
              setActiveMood(null)
              if (seedTrack) loadSeedRecommendation(seedTrack)
            }}
          >
            🎯 Gợi Ý Từ Bài Hát Hạt Giống
          </button>
          <button
            type="button"
            className={`discovery-tab-btn ${mode === 'mood' ? 'active' : ''}`}
            onClick={() => {
              setMode('mood')
              if (!activeMood) handleSelectMood('happy')
            }}
          >
            ✨ Theo Tâm Trạng
          </button>
        </div>
      </div>

      {/* Mood Selector (when in mood mode or discoverable) */}
      <MoodSelector
        selectedMood={activeMood}
        onSelectMood={handleSelectMood}
        loading={state.loading}
      />

      {/* Seed Mode Control Panel */}
      {mode === 'seed' && (
        <div className="seed-controller-card">
          <div className="seed-controller-header">
            <div>
              <span className="small text-muted">Bài hát hạt giống (Seed Track):</span>
              <h3 className="seed-track-title">
                {seedTrack ? (
                  <>
                    {seedTrack.track_name} — <span className="text-muted">{seedTrack.artist_name || seedTrack.artist}</span>
                  </>
                ) : (
                  <span className="text-muted">Chưa chọn bài hát. Vui lòng tìm kiếm bài hát bên dưới để bắt đầu:</span>
                )}
              </h3>
            </div>
            {seedTrack && (
              <Badge variant="spotify" size="md">
                ID: {seedTrack.track_id}
              </Badge>
            )}
          </div>

          {/* Quick Search for Seed Track */}
          <div className="seed-search-box">
            <SearchBar
              value={seedSearchQuery}
              onChange={(val) => setSeedSearchQuery(val)}
              onSearch={handleSeedSearch}
              loading={searchingSeed}
              placeholder="Tìm bài hát làm hạt giống (vd: In Da Club, Radiohead, Shape of You)..."
            />
            {seedSearchResults && (
              <div className="seed-results-dropdown">
                {seedSearchResults.length === 0 ? (
                  <p className="p-3 text-muted small">Không tìm thấy bài hát nào.</p>
                ) : (
                  <ul className="seed-dropdown-list">
                    {seedSearchResults.map((t) => (
                      <li
                        key={t.track_id}
                        className="seed-dropdown-item"
                        onClick={() => handleSelectSeedTrack(t)}
                      >
                        <span className="seed-dd-title">{t.track_name}</span>
                        <span className="seed-dd-artist text-muted">{t.artist_name || t.artist}</span>
                        <span className="seed-dd-pick-btn">Chọn bài này ➔</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Strategy & Parameter Tuner */}
          {seedTrack && (
            <form className="seed-params-form" onSubmit={handleApplySeedParams}>
              <div className="strategy-picker-row">
                <span className="input-label">Chiến lược AI (Strategy):</span>
                <div className="strategy-buttons-group">
                  {Object.entries(STRATEGY_LABELS).map(([stratKey, stratLabel]) => (
                    <button
                      key={stratKey}
                      type="button"
                      className={`strategy-btn ${strategy === stratKey ? 'active' : ''}`}
                      onClick={() => {
                        setStrategy(stratKey)
                        loadSeedRecommendation(seedTrack, stratKey)
                      }}
                      title={STRATEGY_DESCRIPTIONS[stratKey]}
                    >
                      {stratLabel}
                    </button>
                  ))}
                </div>
              </div>

              <p className="strategy-desc-hint small text-muted">
                💡 {STRATEGY_DESCRIPTIONS[strategy]}
              </p>

              <div className="params-sliders-grid">
                {/* Alpha Slider for Hybrid / MMR */}
                {strategy !== 'audio' && (
                  <div className="param-slider-cell">
                    <div className="slider-label-row">
                      <span>Trọng số âm học (α): <strong>{Math.round(alpha * 100)}% Audio / {Math.round((1 - alpha) * 100)}% Genre</strong></span>
                      <Tooltip text="Tỷ lệ cân bằng giữa 9 đặc trưng sóng âm và thể loại nghệ sĩ">
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
                )}

                {/* Lambda Slider for MMR */}
                {strategy === 'mmr' && (
                  <div className="param-slider-cell">
                    <div className="slider-label-row">
                      <span>Đa dạng hóa MMR (λ): <strong>{Math.round(mmrLambda * 100)}% Phù hợp / {Math.round((1 - mmrLambda) * 100)}% Đa dạng</strong></span>
                      <Tooltip text="λ cao = bám sát bài gốc; λ thấp = tăng cường các bài hát phong cách mới lạ">
                        <span className="info-icon">ℹ</span>
                      </Tooltip>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={mmrLambda}
                      onChange={(e) => setMmrLambda(Number(e.target.value))}
                      className="ui-slider"
                    />
                  </div>
                )}

                {/* K Slider */}
                <div className="param-slider-cell">
                  <div className="slider-label-row">
                    <span>Số bài hát (k): <strong>{k} bài</strong></span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="50"
                    step="1"
                    value={k}
                    onChange={(e) => setK(Number(e.target.value))}
                    className="ui-slider"
                  />
                </div>

                {/* Exclude same artist toggle */}
                <div className="param-toggle-cell">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={excludeSameArtist}
                      onChange={(e) => setExcludeSameArtist(e.target.checked)}
                    />
                    <span>Loại trừ bài cùng nghệ sĩ</span>
                  </label>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={handleApplySeedParams}
                    loading={state.loading}
                  >
                    Áp dụng tham số
                  </Button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Result Meta Bar */}
      {state.data && (
        <div className="result-meta-card">
          <div className="result-meta-top">
            <p className="meta-model-info">
              {state.data.title}
              {' · '}
              <strong className="pill-badge">{state.data.modeLabel}</strong>
              {state.data.latency != null && (
                <span className="muted-note"> (Độ trễ AI: {state.data.latency}ms)</span>
              )}
            </p>
          </div>
        </div>
      )}

      {/* Recommended Track List */}
      <TrackList
        loading={state.loading}
        error={state.error}
        items={state.data?.items}
        emptyText="Không tìm thấy bài hát đề xuất phù hợp."
        onFindSimilar={handleSelectSeedTrack}
      />

      {/* Floating Taste Profile Drawer */}
      <TasteProfileDrawer
        onGenerateProfile={handleGenerateTasteProfile}
        loading={state.loading}
      />
    </section>
  )
}
