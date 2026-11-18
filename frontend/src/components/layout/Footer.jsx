export default function Footer() {
  return (
    <footer className="app-footer">
      <div className="footer-inner">
        <div className="footer-col">
          <p className="footer-brand">🎵 EmBeat AI Recommender Engine</p>
          <p className="footer-desc text-muted small">
            Hệ thống gợi ý âm nhạc quy mô lớn huấn luyện trên bộ dữ liệu Spotify & Last.fm kết hợp 9 đặc trưng âm học, Content-Based, Multi-Modal Two-Tower & Item-based CF.
          </p>
        </div>
        <div className="footer-col text-right">
          <div className="footer-tags">
            <span className="footer-tag">React 19</span>
            <span className="footer-tag">Vite</span>
            <span className="footer-tag">FastAPI</span>
            <span className="footer-tag">Spotify MPD</span>
          </div>
          <p className="footer-copy text-muted small">
            © 2026 Production Architecture. Chuẩn enterprise cho sản phẩm thực tế.
          </p>
        </div>
      </div>
    </footer>
  )
}
