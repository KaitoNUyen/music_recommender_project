export default function SpotifyPlayer({ playlistId }) {
  if (!playlistId) return null

  return (
    <div className="spotify-embed-card">
      <div className="spotify-embed-header">
        <span>🎧 Trình phát Spotify Playlist chính hãng</span>
        <a
          href={`https://open.spotify.com/playlist/${playlistId}`}
          target="_blank"
          rel="noreferrer"
          className="link small"
        >
          Mở trên Spotify ↗
        </a>
      </div>
      <iframe
        title="Spotify Embed Playlist"
        className="spotify-iframe"
        src={`https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator&theme=0`}
        width="100%"
        height="152"
        frameBorder="0"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        loading="lazy"
      />
    </div>
  )
}

