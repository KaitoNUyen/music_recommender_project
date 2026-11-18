import { useEffect, useState } from 'react'
import { MODEL_LABELS, getEvaluation } from '../api/index.js'

const METRICS = [
  ['precision@10', 'Precision@10', 'Trong 10 bài gợi ý, tỷ lệ bài user thực sự nghe ở tập test.'],
  ['recall@10', 'Recall@10', 'Tỷ lệ bài user nghe ở tập test được tìm thấy trong top 10. Thấp vì mỗi user có ~764 bài test mà chỉ gợi ý 10.'],
  ['ndcg@10', 'NDCG@10', 'Như Precision nhưng thưởng nhiều hơn khi bài đúng nằm ở vị trí cao trong danh sách.'],
  ['hit_rate@10', 'HitRate@10', 'Tỷ lệ user có ít nhất 1 bài đúng trong top 10.'],
]
const COLORS = { popular: '#64748b', cf: '#1db954', mf: '#a855f7' }

export default function Evaluation() {
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    getEvaluation()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((e) => setState({ loading: false, error: e.message, data: null }))
  }, [])

  if (state.loading) return <p role="status">Đang tải kết quả đánh giá...</p>
  if (state.error) return <p role="alert" className="error">{state.error}</p>

  const { models = [], protocol = {}, dataset_statistics: ds = {}, metadata = {}, score_definitions: scoreDefs = {} } = state.data || {}
  const best = (key) => {
    const vals = models.map((m) => m.metrics?.[key]).filter((v) => typeof v === 'number')
    return vals.length ? Math.max(...vals) : 1
  }

  return (
    <section>
      <h2>Đánh giá mô hình</h2>
      <p className="muted small">
        Số liệu từ <code>ml/evaluation.json</code> ({metadata.author || 'Evaluation Engine'}, {metadata.generated_at ? metadata.generated_at.slice(0, 10) : '2026'}) ·
        Giao thức: {protocol.name || 'Temporal Split'}, top-{protocol.top_k || 10}, {ds.evaluated_test_users ?? 792} user test, loại bài đã nghe khỏi gợi ý.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mô hình</th>
              {METRICS.map(([k, label]) => <th key={k}>{label}</th>)}
              <th>Train (s)</th>
              <th>Latency (ms)</th>
              <th>Cấu hình</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td><span className="dot" style={{ background: COLORS[m.id] || '#64748b' }} />{m.name}</td>
                {METRICS.map(([k]) => {
                  const val = m.metrics?.[k]
                  return (
                    <td key={k} className={val === best(k) ? 'best num' : 'num'}>
                      {typeof val === 'number' ? val.toFixed(4) : '-'}
                    </td>
                  )
                })}
                <td className="num">{m.benchmarks?.train_duration_sec ?? '-'}</td>
                <td className="num">{m.benchmarks?.latency_per_request_ms ?? '-'}</td>
                <td className="small">
                  {m.hyperparameters && Object.keys(m.hyperparameters).length > 0
                    ? Object.entries(m.hyperparameters).map(([k, v]) => `${k}=${v}`).join(', ')
                    : 'Mặc định'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Ô in đậm = tốt nhất theo từng metric.</p>

      <h3>Biểu đồ so sánh</h3>
      <div className="charts">
        {METRICS.map(([k, label]) => (
          <figure key={k} className="chart" aria-label={`Biểu đồ ${label}`}>
            <figcaption>{label}</figcaption>
            {models.map((m) => (
              <div key={m.id} className="bar-row">
                <span className="bar-label">{MODEL_LABELS[m.id] ?? m.name}</span>
                <div className="bar-track">
                  <div className="bar" style={{ width: `${(m.metrics[k] / best(k)) * 100}%`, background: COLORS[m.id] }} />
                </div>
                <span className="num">{m.metrics[k].toFixed(4)}</span>
              </div>
            ))}
          </figure>
        ))}
      </div>

      <h3>Ý nghĩa các metric</h3>
      <dl className="explain">
        {METRICS.map(([k, label, text]) => <div key={k}><dt>{label}</dt><dd>{text}</dd></div>)}
      </dl>

      <h3>Ý nghĩa score trên trang gợi ý</h3>
      <dl className="explain">
        {models.map((m) => scoreDefs?.[m.id] && (
          <div key={m.id}><dt>{scoreDefs[m.id].model_name}</dt><dd><code>{scoreDefs[m.id].formula}</code> — {scoreDefs[m.id].description}</dd></div>
        ))}
      </dl>
      <p className="muted small">Score chỉ dùng để xếp hạng trong cùng một mô hình, không so sánh trực tiếp giữa các mô hình.</p>
    </section>
  )
}
