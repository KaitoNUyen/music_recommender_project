

export const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const DEFAULT_TIMEOUT_MS = 15000

export class ApiError extends Error {
  constructor(message, status = 0, detail = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * Format query parameters cleanly, skipping undefined/null/empty strings.
 */
function buildQueryString(params = {}) {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value))
    }
  }
  const qs = searchParams.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Core request dispatcher with timeout and standardized error handling.
 */
export async function request(path, options = {}) {
  const {
    method = 'GET',
    params,
    body,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: userSignal,
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Listen to external signal if provided
  if (userSignal) {
    userSignal.addEventListener('abort', () => controller.abort())
  }

  const queryString = params ? buildQueryString(params) : ''
  const fullUrl = path.startsWith('http://') || path.startsWith('https://')
    ? `${path}${queryString}`
    : `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}${queryString}`

  const requestHeaders = {
    Accept: 'application/json',
    ...headers,
  }

  const requestConfig = {
    method,
    headers: requestHeaders,
    signal: controller.signal,
  }

  if (body !== undefined && body !== null) {
    requestHeaders['Content-Type'] = 'application/json'
    requestConfig.body = typeof body === 'string' ? body : JSON.stringify(body)
  }

  let response
  try {
    response = await fetch(fullUrl, requestConfig)
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      throw new ApiError(`Yêu cầu bị quá thời gian chờ (${Math.round(timeoutMs / 1000)}s): ${path}`, 408)
    }
    throw new ApiError(
      `Không thể kết nối tới Backend (${BASE_URL}). Vui lòng đảm bảo server backend đang chạy.`,
      0,
      err.message,
    )
  } finally {
    clearTimeout(timer)
  }

  let parsedBody = null
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      parsedBody = await response.json()
    } catch {
      parsedBody = null
    }
  } else {
    try {
      parsedBody = await response.text()
    } catch {
      parsedBody = null
    }
  }

  if (!response.ok) {
    const detail = parsedBody?.detail
    let message = `Lỗi máy chủ (${response.status})`

    if (typeof detail === 'string') {
      message = detail
    } else if (Array.isArray(detail) && detail.length > 0) {
      // FastAPI 422 Unprocessable Entity array
      const firstErr = detail[0]
      const loc = firstErr.loc ? firstErr.loc.slice(1).join('.') : 'trường'
      message = `Lỗi dữ liệu (${loc}): ${firstErr.msg || 'Không hợp lệ'}`
    } else if (response.status === 404) {
      message = `Không tìm thấy tài nguyên: ${path}`
    } else if (response.status === 500) {
      message = 'Máy chủ backend gặp lỗi xử lý nội bộ (500).'
    }

    throw new ApiError(message, response.status, parsedBody)
  }

  return parsedBody
}

export const api = {
  get: (path, params, options) => request(path, { ...options, method: 'GET', params }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
}
