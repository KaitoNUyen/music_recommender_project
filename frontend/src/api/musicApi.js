

import { api } from './client.js'

export const STRATEGY_LABELS = {
  hybrid: 'Hybrid (Sóng âm + Thể loại nghệ sĩ)',
  audio: 'Audio Cosine (Thuần 9 đặc trưng âm học)',
  mmr: 'MMR (Tối ưu độ phong phú & Đa dạng hóa)',
}

export const STRATEGY_DESCRIPTIONS = {
  hybrid: 'Kết hợp không gian vector 9 đặc trưng âm học với ma trận thể loại TF-IDF của nghệ sĩ. Trọng số α điều chỉnh tỷ lệ ưu tiên.',
  audio: 'Đo khoảng cách Cosine thuần túy trên 9 đặc trưng âm học chuẩn hóa (Danceability, Energy, Valence, Tempo, v.v.).',
  mmr: 'Maximal Marginal Relevance: Cân bằng giữa độ liên quan với bài gốc và tính đa dạng danh mục, triệt tiêu bài hát quá giống nhau.',
}

export const MOODS = [
  { id: 'happy', label: 'Vui vẻ', en: 'Happy Vibes', icon: '☀️', color: '#eab308', desc: 'Valence cao, giai điệu tích cực, tươi sáng' },
  { id: 'energetic', label: 'Sôi động', en: 'High Energy', icon: '⚡', color: '#f97316', desc: 'Energy & Tempo cao, nhịp điệu dồn dập' },
  { id: 'chill', label: 'Thư giãn', en: 'Chill & Relax', icon: '🌙', color: '#8b5cf6', desc: 'Acousticness cao, tiết tấu nhẹ nhàng' },
  { id: 'calm', label: 'Êm dịu', en: 'Peaceful Mind', icon: '🌿', color: '#10b981', desc: 'Năng lượng thấp, giai điệu mộc mạc dịu êm' },
  { id: 'sad', label: 'Trầm lắng', en: 'Deep & Blue', icon: '🌧️', color: '#3b82f6', desc: 'Valence thấp, sâu lắng, da diết' },
  { id: 'focus', label: 'Tập trung', en: 'Deep Study', icon: '🎧', color: '#06b6d4', desc: 'Instrumentalness cao, ít giọng hát/rap' },
]

/**
 * Health check endpoint - returns backend status, model mode, and track catalog count.
 */
export async function getHealth() {
  try {
    return await api.get('/api/v1/health')
  } catch {
    return await api.get('/health')
  }
}

/**
 * Search tracks by keyword (track name or artist name) with 9 audio features.
 */
export async function searchTracks(query, limit = 15) {
  const cleanQ = String(query || '').trim()
  if (!cleanQ) return { status: 'success', query: '', total: 0, results: [], latency_ms: 0 }
  return await api.get('/api/v1/search', { q: cleanQ, limit })
}

/**
 * Retrieve metadata and 9 acoustic features for a specific track.
 */
export async function getTrack(trackId) {
  const id = encodeURIComponent(String(trackId).trim())
  return await api.get(`/api/v1/tracks/${id}`)
}

/**
 * Single seed track recommendation using Content-based, Hybrid, or MMR strategy.
 */
export async function recommendByTrack({
  trackId,
  k = 10,
  strategy = 'hybrid',
  alpha = 0.7,
  mmrLambda = 0.7,
  excludeSameArtist = true,
}) {
  const id = encodeURIComponent(String(trackId).trim())
  return await api.get(`/api/v1/recommend/track/${id}`, {
    k,
    strategy,
    alpha,
    mmr_lambda: mmrLambda,
    exclude_same_artist: excludeSameArtist,
  })
}

/**
 * Multi-seed Taste Profile recommendation: Blends multiple tracks into a combined centroid vector.
 */
export async function recommendByTasteProfile({
  trackIds = [],
  alpha = 0.7,
  k = 10,
  excludeSameArtist = true,
}) {
  return await api.post('/api/v1/recommend/profile', {
    track_ids: trackIds,
    alpha,
    k,
    exclude_same_artist: excludeSameArtist,
  })
}

/**
 * Cold-start Popularity Baseline recommendations.
 */
export async function recommendPopular(k = 10) {
  return await api.get('/api/v1/recommend/popular', { k })
}

/**
 * Recommend tracks matching a target acoustic mood profile.
 */
export async function recommendByMood(moodName, k = 10) {
  const mood = encodeURIComponent(String(moodName).trim().toLowerCase())
  return await api.get(`/api/v1/recommend/mood/${mood}`, { k })
}

/**
 * Quick similar tracks helper for card modals.
 */
export async function getSimilarTracks(trackId, strategy = 'hybrid', limit = 6) {
  const cleanId = String(trackId).trim()
  const res = await recommendByTrack({ trackId: cleanId, k: limit, strategy })
  return res.recommendations || []
}
