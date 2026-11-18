import Modal from '../common/Modal.jsx'
import Button from '../common/Button.jsx'

export default function SpotifyEmbedModal({ track, onClose }) {
  if (!track) return null

  const trackId = track.track_id
  const trackName = track.track_name || 'Bài hát'
  const artist = track.artist_name || track.artist || 'Nghệ sĩ'
  const embedUrl = track.spotify_embed_url || `https://open.spotify.com/embed/track/${trackId}?utm_source=generator&theme=0`

  return (
    <Modal
      isOpen={Boolean(track)}
      onClose={onClose}
      title="Trình phát Spotify"
      maxWidth="480px"
      footer={
        <div className="flex-between w-full">
          <a
            href={`https://open.spotify.com/track/${trackId}`}
            target="_blank"
            rel="noreferrer"
            className="spotify-link-out"
          >
            Mở trên ứng dụng Spotify ↗
          </a>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Đóng
          </Button>
        </div>
      }
    >
      <div className="spotify-modal-content">
        <div className="spotify-modal-meta">
          <h4 className="spotify-modal-track">{trackName}</h4>
          <p className="spotify-modal-artist text-muted">{artist}</p>
        </div>

        <iframe
          title={`Spotify: ${trackName}`}
          src={embedUrl}
          width="100%"
          height="152"
          frameBorder="0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
          className="spotify-modal-iframe"
        />
      </div>
    </Modal>
  )
}
