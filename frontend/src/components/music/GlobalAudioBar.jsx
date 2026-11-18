import { useState } from 'react'
import { useAudioPlayer } from '../../hooks/useAudioPlayer.js'
import SpotifyEmbedModal from './SpotifyEmbedModal.jsx'

function formatSeconds(secs) {
  if (Number.isNaN(secs) || secs < 0) return '0:00'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

export default function GlobalAudioBar() {
  const {
    currentTrack,
    queue,
    currentIndex,
    queueTitle,
    isPlaying,
    isLoadingMedia,
    currentTime,
    duration,
    volume,
    isMuted,
    crossfadeEnabled,
    crossfadeSeconds,
    autoAiMixEnabled,
    isCrossfading,
    crossfadeProgress,
    crossfadeTargetTrack,
    transitionNote,
    setCrossfadeEnabled,
    setCrossfadeSeconds,
    setAutoAiMixEnabled,
    dismissTransitionNote,
    playQueue,
    nextTrack,
    prevTrack,
    pause,
    resume,
    seek,
    changeVolume,
    toggleMute,
    embedModalTrack,
    openSpotifyEmbed,
    closeSpotifyEmbed,
  } = useAudioPlayer()

  const [showCrossfadePanel, setShowCrossfadePanel] = useState(false)
  const [showQueuePanel, setShowQueuePanel] = useState(false)

  if (!currentTrack) {
    return (
      <SpotifyEmbedModal
        track={embedModalTrack}
        onClose={closeSpotifyEmbed}
      />
    )
  }

  const trackName = currentTrack.track_name || 'Đang phát'
  const artistName = currentTrack.artist_name || currentTrack.artist || 'Nghệ sĩ'
  const coverUrl = currentTrack.album_cover_url
  const hasQueue = queue.length > 1
  const canPrev = hasQueue && (currentIndex > 0 || currentTime > 4)
  const canNext = hasQueue && currentIndex + 1 < queue.length
  const nextUpTrack = canNext ? queue[currentIndex + 1] : null
  const currentBpm = currentTrack.audio_features?.tempo ?? currentTrack.tempo
  const recCf = currentTrack.mix_plan?.recommended_crossfade_sec

  const handleScrub = (e) => {
    seek(Number(e.target.value))
  }

  const handleVolumeChange = (e) => {
    changeVolume(Number(e.target.value))
  }

  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0

  return (
    <>
      <div className={`global-player-bar ${isCrossfading ? 'is-crossfading' : ''}`} role="region" aria-label="Trình phát nhạc AI DJ">
        {/* Micro-Note Banner above/on Audio Bar alerting user of track switch or live crossfade */}
        {transitionNote && (
          <div
            className={`player-transition-note ${transitionNote.type === 'crossfading' ? 'note-crossfading' : 'note-switched'} ${transitionNote.settled ? 'note-settled' : ''}`}
            role="status"
            aria-live="polite"
          >
            {transitionNote.type === 'crossfading' ? (
              <div className="transition-note-content">
                <span className="transition-note-dot pulse" />
                <span className="transition-note-text">
                  <strong>Đang Mixing Crossfade ({transitionNote.crossfadeSec}s):</strong>{' '}
                  Sắp sang bài mới <em>&ldquo;{transitionNote.toTrackName}&rdquo;</em>
                  {transitionNote.matchScore != null && (
                    <span className="note-match-tag"> · Khớp {(transitionNote.matchScore * 100).toFixed(0)}%</span>
                  )}
                </span>
                <span className="transition-cf-meter" aria-hidden="true">
                  <span
                    className="transition-cf-meter-fill"
                    style={{ width: `${Math.round(crossfadeProgress * 100)}%` }}
                  />
                </span>
              </div>
            ) : (
              <div className="transition-note-content">
                <span className="transition-note-dot switched" />
                <span className="transition-note-text">
                  <strong>Đã sang bài mới{transitionNote.totalTracks > 1 ? ` (#${transitionNote.trackIndex + 1}/${transitionNote.totalTracks})` : ''}:</strong>{' '}
                  <em>&ldquo;{transitionNote.toTrackName}&rdquo;</em>
                  {transitionNote.fromTrackName && !transitionNote.settled && (
                    <span className="note-from-sub"> ← chuyển từ &ldquo;{transitionNote.fromTrackName}&rdquo;</span>
                  )}
                  {transitionNote.matchScore != null && (
                    <span className="note-match-tag"> · {transitionNote.mixStyle} ({(transitionNote.matchScore * 100).toFixed(0)}%)</span>
                  )}
                </span>
                <button
                  type="button"
                  className="transition-note-close"
                  onClick={dismissTransitionNote}
                  title="Đóng thông báo"
                  aria-label="Đóng thông báo chuyển bài"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        {/* Track Info */}
        <div className="player-track-info">
          <div
            className="player-track-art"
            style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : { backgroundColor: '#1e293b' }}
          >
            {!coverUrl && (isCrossfading ? '🎛️' : '🎵')}
          </div>
          <div className="player-track-meta">
            <div className="player-title-badge-row">
              <span className="player-track-title" title={trackName}>{trackName}</span>
              {(currentTrack.audio_kind === 'full' || duration >= 45) ? (
                <span className="player-full-pill" title="Đang phát trọn vẹn bài hát (Full Audio)">
                  Full
                </span>
              ) : (
                <span
                  className="player-preview-pill"
                  title="Đang phát bản nghe thử 30s (Cài RAPIDAPI_KEY trong .env để lấy bản Full)"
                >
                  30s
                </span>
              )}
              {currentTrack.audio_cached && (
                <span className="player-local-pill" title="Đang phát từ bản audio đã tải cục bộ (Local Cache)">
                  Local
                </span>
              )}
            </div>
            <span className="player-track-artist text-muted" title={artistName}>
              {artistName}
              {currentBpm ? ` · ${Math.round(currentBpm)} BPM` : ''}
              {isCrossfading && crossfadeTargetTrack ? ` → ${crossfadeTargetTrack.track_name}` : ''}
            </span>
          </div>
        </div>

        {/* Center Transport Controls & Scrubber */}
        <div className="player-center-controls">
          <div className="player-buttons">
            <button
              type="button"
              className="player-step-btn"
              onClick={prevTrack}
              disabled={!canPrev}
              title="Bài trước"
              aria-label="Bài trước"
            >
              ⏮
            </button>

            <button
              type="button"
              className="player-play-btn"
              onClick={isPlaying ? pause : resume}
              disabled={isLoadingMedia}
              aria-label={isPlaying ? 'Tạm dừng' : 'Phát tiếp'}
            >
              {isLoadingMedia ? '⏳' : isPlaying ? '⏸' : '▶'}
            </button>

            <button
              type="button"
              className="player-step-btn"
              onClick={() => nextTrack(true)}
              disabled={!canNext}
              title={nextUpTrack ? `Chuyển mượt sang: ${nextUpTrack.track_name}` : 'Bài tiếp theo'}
              aria-label="Bài tiếp theo"
            >
              ⏭
            </button>

            {nextUpTrack && (
              <span className="player-next-hint" title={`Tiếp theo: ${nextUpTrack.track_name} — ${nextUpTrack.artist_name || nextUpTrack.artist}`}>
                Tiếp: {nextUpTrack.track_name}
              </span>
            )}
          </div>

          <div className="player-progress-row">
            <span className="player-time">{formatSeconds(currentTime)}</span>
            <div className="player-scrubber-track">
              <input
                type="range"
                min="0"
                max={duration || 30}
                step="0.1"
                value={currentTime}
                onChange={handleScrub}
                className="player-range-input"
                aria-label="Thanh tua âm thanh"
                style={{
                  background: `linear-gradient(to right, #1db954 ${progressPercent}%, #334155 ${progressPercent}%)`,
                }}
              />
            </div>
            <span className="player-time">{formatSeconds(duration)}</span>
          </div>
        </div>

        {/* Right Controls: Spotify Crossfade + Queue + Volume + Outbound */}
        <div className="player-right-actions">
          <div className="player-popover-anchor">
            <button
              type="button"
              className={`player-cf-pill ${crossfadeEnabled && crossfadeSeconds > 0 ? 'cf-active' : ''} ${isCrossfading ? 'cf-live' : ''}`}
              onClick={() => {
                setShowCrossfadePanel((v) => !v)
                setShowQueuePanel(false)
              }}
              title="Cài đặt Spotify Crossfade & AI DJ Mixing"
            >
              🎛️ {crossfadeEnabled && crossfadeSeconds > 0 ? `Mix ${crossfadeSeconds}s` : 'Crossfade: Tắt'}
            </button>

            {showCrossfadePanel && (
              <div className="player-floating-popover cf-popover" role="dialog" aria-label="Cài đặt Crossfade">
                <div className="popover-head">
                  <strong>🎛️ Spotify Crossfade &amp; AI Mix</strong>
                  <button
                    type="button"
                    className="popover-close"
                    onClick={() => setShowCrossfadePanel(false)}
                  >
                    ×
                  </button>
                </div>

                <label className="popover-toggle-row">
                  <span>Bật Crossfade chuyển bài</span>
                  <input
                    type="checkbox"
                    checked={crossfadeEnabled}
                    onChange={(e) => setCrossfadeEnabled(e.target.checked)}
                  />
                </label>

                <div className="popover-slider-block">
                  <div className="popover-slider-label">
                    <span>Thời gian Crossfade:</span>
                    <strong className="cf-sec-val">
                      {crossfadeEnabled ? `${crossfadeSeconds} giây` : 'Đã tắt'}
                    </strong>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="12"
                    step="1"
                    disabled={!crossfadeEnabled}
                    value={crossfadeEnabled ? crossfadeSeconds : 0}
                    onChange={(e) => {
                      const val = Number(e.target.value)
                      setCrossfadeSeconds(val)
                      if (val > 0 && !crossfadeEnabled) setCrossfadeEnabled(true)
                    }}
                    className="cf-range-slider"
                    style={{
                      background: `linear-gradient(to right, #1db954 ${((crossfadeEnabled ? crossfadeSeconds : 0) / 12) * 100}%, #334155 ${((crossfadeEnabled ? crossfadeSeconds : 0) / 12) * 100}%)`,
                    }}
                  />
                  <div className="cf-ticks">
                    <span>0s</span>
                    <span>3s</span>
                    <span>6s</span>
                    <span>9s</span>
                    <span>12s</span>
                  </div>
                </div>

                <label className="popover-toggle-row">
                  <span>AI DJ Sync (Cân âm lượng &amp; BPM)</span>
                  <input
                    type="checkbox"
                    checked={autoAiMixEnabled}
                    onChange={(e) => setAutoAiMixEnabled(e.target.checked)}
                  />
                </label>

                {currentTrack.mix_plan && (
                  <div className="popover-ai-hint">
                    <div className="small text-muted">{currentTrack.mix_plan.dj_note}</div>
                    {recCf != null && (
                      <button
                        type="button"
                        className="popover-apply-ai-btn"
                        onClick={() => {
                          setCrossfadeEnabled(true)
                          setCrossfadeSeconds(Math.round(recCf))
                        }}
                      >
                        Dùng mức AI gợi ý ({Math.round(recCf)}s)
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {hasQueue && (
            <div className="player-popover-anchor">
              <button
                type="button"
                className={`player-queue-pill ${showQueuePanel ? 'active' : ''}`}
                onClick={() => {
                  setShowQueuePanel((v) => !v)
                  setShowCrossfadePanel(false)
                }}
                title="Xem danh sách phát DJ Mix"
              >
                📃 {currentIndex + 1}/{queue.length}
              </button>

              {showQueuePanel && (
                <div className="player-floating-popover queue-popover" role="dialog" aria-label="Hàng đợi DJ Mix">
                  <div className="popover-head">
                    <strong>🎧 {queueTitle || 'Hàng đợi DJ Mix'} ({queue.length} bài)</strong>
                    <button
                      type="button"
                      className="popover-close"
                      onClick={() => setShowQueuePanel(false)}
                    >
                      ×
                    </button>
                  </div>
                  <ol className="popover-queue-list">
                    {queue.map((qTrack, qIdx) => {
                      const active = qIdx === currentIndex
                      return (
                        <li
                          key={`${qTrack.track_id}_${qIdx}`}
                          className={`popover-queue-item ${active ? 'active' : ''}`}
                          onClick={() => playQueue(queue, qIdx, { title: queueTitle })}
                        >
                          <span className="pq-idx">#{qIdx + 1}</span>
                          <div className="pq-meta">
                            <span className="pq-title">{qTrack.track_name}</span>
                            <span className="pq-sub text-muted">
                              {qTrack.artist_name || qTrack.artist}
                              {qTrack.audio_features?.tempo ? ` · ${Math.round(qTrack.audio_features.tempo)} BPM` : ''}
                              {qTrack.audio_kind === 'full' ? ' · Full' : qTrack.audio_kind === 'preview' ? ' · 30s' : ''}
                              {qTrack.audio_cached ? ' · Local' : ''}
                            </span>
                          </div>
                          {active && <span className="pq-now">Đang phát</span>}
                        </li>
                      )
                    })}
                  </ol>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className="player-mute-btn"
            onClick={toggleMute}
            aria-label={isMuted ? 'Bật tiếng' : 'Tắt tiếng'}
          >
            {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
          </button>

          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            className="player-volume-slider"
            aria-label="Âm lượng"
          />

          <button
            type="button"
            className="btn-spotify-pill"
            onClick={() => openSpotifyEmbed(currentTrack)}
            title="Mở trình phát Spotify chính thức"
          >
            Spotify
          </button>
        </div>
      </div>

      <SpotifyEmbedModal
        track={embedModalTrack}
        onClose={closeSpotifyEmbed}
      />
    </>
  )
}
