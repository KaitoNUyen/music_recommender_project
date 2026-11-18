
import { api } from './client.js'

export async function getEvaluation() {
  try {
    return await api.get('/api/evaluation')
  } catch (backendError) {
    // Resilient fallback to static evaluation artifact
    try {
      const res = await fetch('/evaluation.json')
      if (res.ok) {
        return await res.json()
      }
    } catch {
      // ignore
    }
    throw backendError
  }
}
