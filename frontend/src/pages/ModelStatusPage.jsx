import { useEffect, useState } from 'react'
import { getHealth } from '../api/index.js'
import Badge from '../components/common/Badge.jsx'

export default function ModelStatusPage() {
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getHealth()
      .then((data) => {
        setHealth(data)
        setLoading(false)
      })
      .catch(() => {
        setHealth({ status: 'offline' })
        setLoading(false)
      })
  }, [])

  const isOnline = health?.status === 'ok'

  return (
    <section className="page-model-container">
      <div className="model-page-header">
        <h2>🧠 Kiến Trúc Mô Hình ML & Trạng Thái Hệ Thống</h2>
        <p className="text-muted">
          Thông số kỹ thuật thời gian thực của mô hình cốt lõi <code>EmbeatRecommender</code> phục vụ qua FastAPI Backend.
        </p>
      </div>

      {/* Live System Health Card */}
      <div className="model-stat-grid">
        <div className="stat-card">
          <span className="stat-label">Trạng thái Backend</span>
          <div className="stat-val-row">
            <Badge variant={isOnline ? 'success' : 'danger'} size="md" dot>
              {isOnline ? 'Online (Đang hoạt động)' : 'Offline (Chưa kết nối)'}
            </Badge>
          </div>
          <span className="stat-desc text-muted small">Cổng kết nối mặc định: http://127.0.0.1:8000</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Mô hình AI cốt lõi</span>
          <div className="stat-val-row">
            <strong className="stat-number">EmbeatRecommender</strong>
          </div>
          <span className="stat-desc text-muted small">Content-Based & Hybrid Recommender System</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Số bài hát đã vector hóa</span>
          <div className="stat-val-row">
            <strong className="stat-number">
              {loading ? '...' : health?.total_tracks ? health.total_tracks.toLocaleString() : '29,985'}
            </strong>
          </div>
          <span className="stat-desc text-muted small">Catalog bài hát Spotify (balanced EDA)</span>
        </div>

        <div className="stat-card">
          <span className="stat-label">Chế độ nạp (Mode)</span>
          <div className="stat-val-row">
            <strong className="stat-number">{health?.mode || 'artifact_joblib'}</strong>
          </div>
          <span className="stat-desc text-muted small">File: {health?.artifact_path || 'artifacts/embeat_recommender.joblib'}</span>
        </div>
      </div>

      {/* Architectural Principles */}
      <div className="model-details-card">
        <h3>1. Ba Chiến Lược Đề Xuất (Recommendation Strategies)</h3>
        <div className="strategies-comparison-grid">
          <div className="strategy-card">
            <h4>🌿 1. Hybrid (Khuyên dùng)</h4>
            <p className="small text-muted">
              Kết hợp đa phương thức giữa không gian 9 đặc trưng sóng âm và ma trận thể loại nghệ sĩ TF-IDF.
            </p>
            <div className="formula-box">
              <code>S_hybrid = α · S_audio + (1 - α) · S_genre</code>
            </div>
            <p className="small">
              Mặc định α = 0.70 (70% sóng âm + 30% thể loại). Loại trừ bài hát cùng nghệ sĩ để tạo cảm giác khám phá mới mẻ.
            </p>
          </div>

          <div className="strategy-card">
            <h4>🎧 2. Audio Cosine</h4>
            <p className="small text-muted">
              Đo khoảng cách góc Cosine thuần túy trên vector 9 chiều của bài hát sau khi chuẩn hóa qua StandardScaler.
            </p>
            <div className="formula-box">
              <code>CosineSim(u, v) = (u · v) / (||u|| · ||v||)</code>
            </div>
            <p className="small">
              Tối ưu cho việc tìm các bài hát có cấu trúc sóng âm, nhịp độ và sắc thái tương đồng tuyệt đối.
            </p>
          </div>

          <div className="strategy-card">
            <h4>🎯 3. MMR Diversity (Maximal Marginal Relevance)</h4>
            <p className="small text-muted">
              Giải thuật triệt tiêu hiện tượng trùng lặp thể loại, cân bằng giữa độ liên quan và độ phong phú danh mục.
            </p>
            <div className="formula-box">
              <code>MMR = argmax [λ · Rel(d, q) - (1 - λ) · max Sim(d, d_j)]</code>
            </div>
            <p className="small">
              Tham số λ điều chỉnh mức độ đánh đổi giữa việc bám sát bài gốc hay mở rộng sang các dòng nhạc lân cận.
            </p>
          </div>
        </div>
      </div>

      {/* 9 Audio Features Description */}
      <div className="model-details-card">
        <h3>2. Bộ 9 Đặc Trưng Âm Học (Spotify Audio Features)</h3>
        <p className="text-muted small">
          Được trích xuất từ sóng âm Spotify và dùng để xây dựng vector đặc trưng cũng như vẽ biểu đồ Radar DNA âm nhạc:
        </p>
        <div className="features-table-wrapper">
          <table className="track-table">
            <thead>
              <tr>
                <th>Chỉ số</th>
                <th>Tên tiếng Anh</th>
                <th>Miền giá trị</th>
                <th>Ý nghĩa nghiệp vụ âm nhạc</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Bắt nhịp</strong></td>
                <td>Danceability</td>
                <td><code>0.0 – 1.0</code></td>
                <td>Độ nảy, nhịp điệu phù hợp để khiêu vũ hoặc nhảy theo nhạc.</td>
              </tr>
              <tr>
                <td><strong>Năng lượng</strong></td>
                <td>Energy</td>
                <td><code>0.0 – 1.0</code></td>
                <td>Cường độ, độ sôi động, dồn dập (Rock/EDM có Energy rất cao).</td>
              </tr>
              <tr>
                <td><strong>Sắc thái cảm xúc</strong></td>
                <td>Valence</td>
                <td><code>0.0 – 1.0</code></td>
                <td>Sắc thái tích cực (Vui tươi, rộn rã) vs tiêu cực (U buồn, trầm lắng).</td>
              </tr>
              <tr>
                <td><strong>Nhịp độ</strong></td>
                <td>Tempo</td>
                <td><code>30 – 250 BPM</code></td>
                <td>Tốc độ nhịp đập trung bình trên mỗi phút của bản thu.</td>
              </tr>
              <tr>
                <td><strong>Mộc mạc</strong></td>
                <td>Acousticness</td>
                <td><code>0.0 – 1.0</code></td>
                <td>Mức độ sử dụng nhạc cụ acoustic tự nhiên (guitar gỗ, piano, violin).</td>
              </tr>
              <tr>
                <td><strong>Không lời</strong></td>
                <td>Instrumentalness</td>
                <td><code>0.0 – 1.0</code></td>
                <td>Tỷ lệ không chứa giọng hát/rap (càng gần 1.0 bản thu càng thuần nhạc cụ).</td>
              </tr>
              <tr>
                <td><strong>Sân khấu live</strong></td>
                <td>Liveness</td>
                <td><code>0.0 – 1.0</code></td>
                <td>Đặc trưng biểu diễn trực tiếp trước khán giả / tiếng reo hò.</td>
              </tr>
              <tr>
                <td><strong>Lời nói / Rap</strong></td>
                <td>Speechiness</td>
                <td><code>0.0 – 1.0</code></td>
                <td>Mật độ ngôn từ nói, rap, kịch nói trong bài hát.</td>
              </tr>
              <tr>
                <td><strong>Âm lượng</strong></td>
                <td>Loudness</td>
                <td><code>-60 – 5 dB</code></td>
                <td>Độ lớn trung bình toàn bộ bản nhạc đo bằng decibel.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
