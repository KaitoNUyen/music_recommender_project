# EmBeat AI Music Recommender — Enterprise Production Frontend

Giao diện ứng dụng gợi ý và biên tập âm nhạc AI chuẩn **Production Enterprise** (Senior Frontend Architecture) kết nối trực tiếp với mô hình Machine Learning **`EmbeatRecommender`** (29.985 bài hát Spotify).

---

## 1. Tính Năng & Kiến Trúc Chức Năng

### 1.1. Khám Phá AI (`/`)
- **Top Thịnh Hành (Popularity Baseline)**: Đề xuất mặc định cho người dùng mới (Cold-start).
- **Gợi ý theo bài hạt giống (Seed Track)**:
  - Chọn 3 chiến lược cốt lõi:
    1. **Hybrid**: Kết hợp 9 vector sóng âm và thể loại nghệ sĩ TF-IDF với thanh trượt $\alpha \in [0.0, 1.0]$.
    2. **Audio Cosine**: Đo khoảng cách Cosine thuần túy trên 9 đặc trưng âm học chuẩn hóa.
    3. **MMR Diversity**: Tối ưu tính phong phú danh mục với thanh trượt $\lambda \in [0.0, 1.0]$.
  - Toggle **"Loại trừ bài cùng nghệ sĩ"** (`exclude_same_artist`).
  - Thanh tìm kiếm nhanh để chọn bài hạt giống tức thì.
- **Theo 6 Tâm trạng âm học (Acoustic Moods)**: `happy`, `sad`, `energetic`, `chill`, `calm`, `focus`.

### 1.2. Playlist Studio — Biên Tập & Tối Ưu Playlist Spotify (`/playlist-studio`)
- **Nhập liệu linh hoạt**: Dán link Playlist Spotify (`https://open.spotify.com/playlist/...`), mã Spotify ID, paste danh sách Spotify URIs hoặc tải lên file CSV (Exportify).
- **Trình phát Spotify chính hãng**: Nhúng iframe phát nhạc Spotify trực tiếp trong Studio.
- **Chỉnh sửa & Tối ưu hóa bằng AI**:
  - **Làm mượt dốc năng lượng (DJ Arc Flow)**: Sắp xếp lại thứ tự bài hát để các bước chuyển Energy / BPM / Valence mượt mà, triệt tiêu hiện tượng nhảy nhịp gắt. Hiển thị % giảm chi phí chuyển bài (`cost_reduction_percent`).
  - **Chèn bài cầu nối (AI Infill Bridge)**: Tìm bài hát trung gian từ 29.985 bài của `EmbeatRecommender` lấp vào đoạn nhảy nhịp.
  - **Nối dài Playlist (Extend Playlist)**: Tự động đề xuất thêm bài hát mới dựa trên gu chung của toàn bộ playlist thông qua Multi-Track Centroid.
  - **Xuất dữ liệu**: Xuất file CSV chuẩn 19 cột Exportify (import thẳng vào Spotify) hoặc sao chép Spotify Track URIs để dán (Ctrl+V) vào Spotify Desktop.

### 1.3. Gu Cá Nhân (`/taste-profile`)
- Quản lý giỏ các bài hát yêu thích.
- Tinh chỉnh trọng số $\alpha$, số bài $k$ và gọi `POST /api/v1/recommend/profile` để tính tâm điểm đa vector (Multi-Track Centroid).

### 1.4. Kiến Trúc AI & Trạng Thái Hệ Thống (`/model`)
- Giám sát thời gian thực từ API `GET /api/v1/health`: trạng thái Online, số lượng 29.985 bài hát, mode `artifact_joblib`.
- Giải thích cơ chế toán học của 3 chiến lược Hybrid, Audio Cosine, MMR và 9 chỉ số âm học.

---

## 2. Tiêu Chuẩn Kỹ Thuật (Quality Check)

```bash
# Kiểm tra lint (Oxlint)
npm run lint
# Output: Found 0 warnings and 0 errors.

# Đóng gói Production (Vite 8 & React 19)
npm run build
# Output: built in 129ms
```
