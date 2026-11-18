import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getHistory } from '../api/index.js'
import TrackList from '../components/TrackList.jsx'

export default function History({ initialUserId }) {
  const params = useParams()
  const seedUser = params.userId ?? initialUserId ?? ''
  const [userId, setUserId] = useState(seedUser)
  const [limit, setLimit] = useState(50)
  const [state, setState] = useState({ loading: false, loadingMore: false, error: null, data: null })

  async function load(id, customLimit = limit) {
    if (!id.trim()) return
    setState({ loading: true, loadingMore: false, error: null, data: null })
    try {
      const data = await getHistory(id, customLimit, 0)
      setState({ loading: false, loadingMore: false, error: null, data })
    } catch (e) {
      setState({ loading: false, loadingMore: false, error: e.message, data: null })
    }
  }

  async function handleLoadMore() {
    if (!state.data || state.loadingMore) return
    const nextOffset = state.data.items.length
    const pageSize = Number(limit) || 50
    setState((prev) => ({ ...prev, loadingMore: true, error: null }))
    try {
      const more = await getHistory(state.data.user_id, pageSize, nextOffset)
      setState((prev) => ({
        loading: false,
        loadingMore: false,
        error: null,
        data: {
          ...more,
          items: [...prev.data.items, ...more.items],
        },
      }))
    } catch (e) {
      setState((prev) => ({ ...prev, loadingMore: false, error: e.message }))
    }
  }

  // Được mở từ Home hoặc URL /history/:userId -> tải luôn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (seedUser) {
      setUserId(seedUser)
      load(seedUser)
    }
  }, [seedUser])

  const data = state.data
  const hasMore = data && data.items.length < data.total_tracks

  return (
    <section>
      <h2>Lịch sử nghe nhạc</h2>
      <form className="controls" onSubmit={(e) => { e.preventDefault(); load(userId) }}>
        <label>
          User ID
          <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="vd. user_000001" required />
        </label>
        <label>
          Số bài
          <input type="number" min="1" max="500" required value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
        <button disabled={state.loading}>Xem lịch sử</button>
      </form>

      {data && (
        <p className="muted">
          User <strong>{data.user_id}</strong> đã nghe {data.total_tracks.toLocaleString()} bài — hiển thị{' '}
          {data.items.length} bài nghe nhiều nhất.
        </p>
      )}
      <TrackList {...state} items={data?.items} emptyText="User này chưa có lịch sử nghe." />

      {hasMore && (
        <div className="load-more-wrap">
          <button
            type="button"
            className="btn-load-more"
            disabled={state.loadingMore}
            onClick={handleLoadMore}
          >
            {state.loadingMore ? 'Đang tải thêm...' : `Tải thêm ${limit} bài (còn ${(data.total_tracks - data.items.length).toLocaleString()} bài)`}
          </button>
        </div>
      )}
    </section>
  )
}
