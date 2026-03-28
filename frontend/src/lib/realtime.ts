function getConfiguredBackendOrigin() {
  const envOrigin = import.meta.env.VITE_BACKEND_ORIGIN?.trim()
  if (envOrigin) return envOrigin.replace(/\/$/, '')

  if (window.location.port === '5173') {
    const devHost = window.location.hostname || '127.0.0.1'
    return `http://${devHost}:5000`
  }

  return `${window.location.protocol}//${window.location.host}`
}

function getConfiguredRealtimeOrigin() {
  const envOrigin = import.meta.env.VITE_REALTIME_ORIGIN?.trim()
  if (envOrigin) return envOrigin.replace(/\/$/, '')

  if (window.location.port === '5173') {
    const devHost = window.location.hostname || '127.0.0.1'
    return `http://${devHost}:5001`
  }

  return getConfiguredBackendOrigin()
}

export function getApiBaseUrl() {
  return getConfiguredBackendOrigin()
}

export function getWebSocketUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const origin = path === '/api/lyria' || path === '/api/live'
    ? getConfiguredRealtimeOrigin()
    : getConfiguredBackendOrigin()
  const wsOrigin = origin.startsWith('https://')
    ? origin.replace(/^https:\/\//, 'wss://')
    : origin.replace(/^http:\/\//, 'ws://')

  return `${wsOrigin}${normalizedPath}`
}

export function splitDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/)
  if (!match) return null

  return {
    mimeType: match[1],
    data: match[2],
  }
}
