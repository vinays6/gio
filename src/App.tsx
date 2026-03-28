import { useEffect, useRef, useState } from 'react'
import {
  GoogleGenAI,
  MusicGenerationMode,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai'
import './App.css'

const MODEL = 'models/lyria-realtime-exp'
const SAMPLE_RATE = 48000
const CHANNELS = 2
const DEFAULT_PROMPT =
  'Minimal techno with deep bass, sparse percussion, and atmospheric synths'

type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'paused'
  | 'stopped'
  | 'error'

type DocumentPictureInPictureController = {
  window: Window | null
  requestWindow: (options?: {
    width?: number
    height?: number
    disallowReturnToOpener?: boolean
    preferInitialWindowPlacement?: boolean
  }) => Promise<Window>
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureController
  }
}

function App() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [bpm, setBpm] = useState(90)
  const [density, setDensity] = useState(0.6)
  const [brightness, setBrightness] = useState(0.55)
  const [vocalsEnabled, setVocalsEnabled] = useState(false)
  const [onlyBassAndDrums, setOnlyBassAndDrums] = useState(false)
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState('')
  const [pipMessage, setPipMessage] = useState('')

  // Screenshot capture state
  const [captureOn, setCaptureOn] = useState(false)
  const [latestScreenshot, setLatestScreenshot] = useState<string | null>(null)
  const [captureStatus, setCaptureStatus] = useState('Not capturing')
  const [showScreenshotInPip, setShowScreenshotInPip] = useState(false)

  const sessionRef = useRef<LiveMusicSession | null>(null)
  const lastAppliedConfigRef = useRef<LiveMusicGenerationConfig | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextPlaybackTimeRef = useRef(0)
  const isUnmountingRef = useRef(false)
  const pipWindowRef = useRef<Window | null>(null)

  // Screenshot capture refs
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const captureStreamRef = useRef<MediaStream | null>(null)
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isDocumentPiPSupported =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window

  const closeDocumentPiP = () => {
    pipWindowRef.current?.close()
    pipWindowRef.current = null
  }

  const getEffectivePrompt = (basePrompt: string) =>
    vocalsEnabled ? `${basePrompt}, Vocals` : basePrompt

  const getConfigSummary = (): LiveMusicGenerationConfig => ({
    bpm,
    density,
    brightness,
    onlyBassAndDrums,
    musicGenerationMode: vocalsEnabled
      ? MusicGenerationMode.VOCALIZATION
      : MusicGenerationMode.QUALITY,
  })

  const stopCapture = () => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current)
      captureIntervalRef.current = null
    }
    if (captureStreamRef.current) {
      captureStreamRef.current.getTracks().forEach(t => t.stop())
      captureStreamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setLatestScreenshot(null)
    setCaptureStatus('Not capturing')
    setCaptureOn(false)
    setShowScreenshotInPip(false)
  }

  const startCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
      captureStreamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      stream.getTracks().forEach(track => {
        track.onended = () => {
          stopCapture()
        }
      })

      captureIntervalRef.current = setInterval(() => {
        const video = videoRef.current
        const canvas = canvasRef.current
        if (!video || !canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(video, 0, 0, 1280, 720)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
        setLatestScreenshot(dataUrl)
        const timeStr = new Date().toLocaleTimeString()
        setCaptureStatus(`Capturing every 10s — last captured at ${timeStr}`)
        console.log('[Screenshot] Captured at ' + timeStr + ', base64 length: ' + dataUrl.length)
      }, 10000)

      setCaptureOn(true)
      setCaptureStatus('Capturing every 10s — waiting for first capture...')
    } catch {
      setCaptureOn(false)
      setCaptureStatus('Screen share was denied or cancelled')
    }
  }

  const toggleCapture = async () => {
    if (captureOn) {
      stopCapture()
    } else {
      await startCapture()
    }
  }

  const stopStream = async (nextStatus: Exclude<StreamStatus, 'connecting'> | null = 'idle') => {
    const currentSession = sessionRef.current
    sessionRef.current = null
    lastAppliedConfigRef.current = null

    if (currentSession?.close) {
      await currentSession.close()
    }

    const audioContext = audioContextRef.current

    nextPlaybackTimeRef.current = 0

    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close()
    }

    audioContextRef.current = null

    closeDocumentPiP()

    if (!isUnmountingRef.current && nextStatus) {
      setStatus(nextStatus)
    }
  }

  const updatePiPContents = () => {
    const pipWindow = pipWindowRef.current

    if (!pipWindow || pipWindow.closed) {
      pipWindowRef.current = null
      return
    }

    pipWindow.document.title = 'Lyria popup'
    pipWindow.document.body.innerHTML = ''

    const style = pipWindow.document.createElement('style')
    style.textContent = `
      :root {
        color-scheme: dark;
        font-family: "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 16px;
        box-sizing: border-box;
        background:
          radial-gradient(circle at top, rgba(249, 115, 22, 0.24), transparent 36%),
          linear-gradient(180deg, #08131f 0%, #101d2f 100%);
        color: #f8fafc;
      }

      .pip-shell {
        min-height: calc(100vh - 32px);
        display: grid;
        gap: 16px;
        align-content: start;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        padding: 18px;
        background: rgba(7, 12, 20, 0.82);
        backdrop-filter: blur(18px);
      }

      .pip-title {
        margin: 0;
        font-size: 1.5rem;
        line-height: 1;
      }

      .pip-status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 36px;
        width: fit-content;
        border-radius: 999px;
        padding: 0 12px;
        font-size: 0.8rem;
        font-weight: 700;
        text-transform: capitalize;
        background: rgba(148, 163, 184, 0.16);
        color: #cbd5e1;
      }

      .pip-status.streaming {
        background: rgba(34, 197, 94, 0.2);
        color: #86efac;
      }

      .pip-status.connecting {
        background: rgba(251, 191, 36, 0.18);
        color: #fde68a;
      }

      .pip-status.error {
        background: rgba(248, 113, 113, 0.18);
        color: #fca5a5;
      }

      .pip-actions {
        display: grid;
        gap: 12px;
        margin-top: auto;
      }

      button {
        border: 0;
        border-radius: 16px;
        padding: 14px 16px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      .pip-primary {
        background: linear-gradient(135deg, #f97316 0%, #fb7185 100%);
        color: #fff7ed;
      }

      .pip-secondary {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #e2e8f0;
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .pip-last-activity {
        width: 100%;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #e2e8f0;
      }

      .pip-last-activity:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .pip-screenshot-panel {
        display: grid;
        gap: 8px;
      }

      .pip-screenshot-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .pip-screenshot-dismiss {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #e2e8f0;
        border-radius: 8px;
        padding: 4px 10px;
        font-size: 0.75rem;
        cursor: pointer;
      }

      .pip-screenshot-img {
        width: 100%;
        border-radius: 12px;
        object-fit: contain;
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: block;
      }
    `

    const isPlayable = status === 'paused' || status === 'stopped' || status === 'idle'
    const playPauseLabel = status === 'streaming' ? 'Pause' : 'Play'
    const vocalsLabel = vocalsEnabled ? 'Vocals on' : 'Vocals off'

    const shell = pipWindow.document.createElement('main')
    shell.className = 'pip-shell'
    shell.innerHTML = `
      <h1 class="pip-title">Lyria controls</h1>
      <span class="pip-status ${status}">${status}</span>
      ${
        showScreenshotInPip && latestScreenshot
          ? `<div class="pip-screenshot-panel">
               <div class="pip-screenshot-header">
                 <p class="pip-meta">Last captured activity</p>
                 <button class="pip-screenshot-dismiss" type="button">✕ Close</button>
               </div>
               <img class="pip-screenshot-img" src="${latestScreenshot}" alt="Last captured activity" />
             </div>`
          : ''
      }
      <button class="pip-last-activity" type="button"${latestScreenshot ? '' : ' disabled'}>Last activity</button>
      <div class="pip-actions">
        <button class="pip-primary" type="button" ${status === 'connecting' ? 'disabled' : ''}>
          ${playPauseLabel}
        </button>
        <button class="pip-secondary" type="button" ${
          status === 'connecting' ? 'disabled' : ''
        }>
          ${vocalsLabel}
        </button>
      </div>
    `

    pipWindow.document.head.innerHTML = ''
    pipWindow.document.head.appendChild(style)
    pipWindow.document.body.appendChild(shell)

    shell.querySelector<HTMLButtonElement>('.pip-primary')?.addEventListener('click', () => {
      if (status === 'streaming') {
        void pauseStream()
        return
      }

      if (isPlayable) {
        void playStream()
      }
    })

    shell.querySelector<HTMLButtonElement>('.pip-secondary')?.addEventListener('click', () => {
      void toggleVocals()
    })

    shell.querySelector<HTMLButtonElement>('.pip-last-activity')?.addEventListener('click', () => {
      if (latestScreenshot) {
        setShowScreenshotInPip(true)
      }
    })

    shell.querySelector<HTMLButtonElement>('.pip-screenshot-dismiss')?.addEventListener('click', () => {
      setShowScreenshotInPip(false)
    })
  }

  const openDocumentPiP = async () => {
    if (!isDocumentPiPSupported) {
      setPipMessage('Document Picture-in-Picture is not supported in this browser.')
      return
    }

    if (pipWindowRef.current && !pipWindowRef.current.closed) {
      pipWindowRef.current.focus()
      return
    }

    try {
      const pipWindow = await window.documentPictureInPicture!.requestWindow({
        width: 320,
        height: 220,
        preferInitialWindowPlacement: true,
      })

      pipWindowRef.current = pipWindow
      setPipMessage('')

      pipWindow.addEventListener('pagehide', () => {
        pipWindowRef.current = null
      })

      updatePiPContents()
    } catch (pipError) {
      const message =
        pipError instanceof Error
          ? pipError.message
          : 'The browser blocked the Picture-in-Picture window.'
      setPipMessage(message)
    }
  }

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true
      closeDocumentPiP()
      stopCapture()
      void stopStream(null)
    }
  }, [])

  useEffect(() => {
    updatePiPContents()
  }, [brightness, bpm, density, error, onlyBassAndDrums, status, vocalsEnabled, latestScreenshot, showScreenshotInPip])

  useEffect(() => {
    if (!isDocumentPiPSupported) {
      return
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden' || status !== 'streaming') {
        return
      }

      void openDocumentPiP()
    }

    const handlePageHide = () => {
      if (status !== 'streaming') {
        return
      }

      void openDocumentPiP()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [isDocumentPiPSupported, status])

  const getApiKey = () => import.meta.env.VITE_GEMINI_API_KEY?.trim() ?? ''

  const ensureAudioContext = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE })
    }

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    return audioContextRef.current
  }

  const resetPlaybackQueue = () => {
    const audioContext = audioContextRef.current
    nextPlaybackTimeRef.current = audioContext ? audioContext.currentTime + 0.05 : 0
  }

  const getSampleRateFromMimeType = (mimeType?: string) => {
    const sampleRateMatch = mimeType?.match(/rate=(\d+)/i)
    return sampleRateMatch ? Number(sampleRateMatch[1]) : SAMPLE_RATE
  }

  const schedulePcm16Chunk = async (base64Data: string, mimeType?: string) => {
    const chunkSampleRate = getSampleRateFromMimeType(mimeType)
    const audioContext =
      audioContextRef.current && audioContextRef.current.sampleRate === chunkSampleRate
        ? await ensureAudioContext()
        : new AudioContext({ sampleRate: chunkSampleRate })

    if (
      audioContextRef.current &&
      audioContextRef.current !== audioContext &&
      audioContextRef.current.state !== 'closed'
    ) {
      await audioContextRef.current.close()
      resetPlaybackQueue()
    }

    audioContextRef.current = audioContext
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    const binary = atob(base64Data)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 2),
    )
    const frameCount = Math.floor(samples.length / CHANNELS)

    if (frameCount === 0) {
      return
    }

    const audioBuffer = audioContext.createBuffer(CHANNELS, frameCount, chunkSampleRate)
    const leftChannel = audioBuffer.getChannelData(0)
    const rightChannel = audioBuffer.getChannelData(1)

    for (let frame = 0; frame < frameCount; frame += 1) {
      const leftSample = samples[frame * CHANNELS] ?? 0
      const rightSample = samples[frame * CHANNELS + 1] ?? leftSample
      leftChannel[frame] = leftSample / 32768
      rightChannel[frame] = rightSample / 32768
    }

    const source = audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(audioContext.destination)

    const startAt = Math.max(audioContext.currentTime + 0.05, nextPlaybackTimeRef.current)
    source.start(startAt)
    nextPlaybackTimeRef.current = startAt + audioBuffer.duration
  }

  const applyPrompt = async (nextPrompt: string) => {
    if (!sessionRef.current) {
      return
    }

    await sessionRef.current.setWeightedPrompts({
      weightedPrompts: [{ text: getEffectivePrompt(nextPrompt), weight: 1 }],
    })
  }

  const applyConfig = async (nextConfig = getConfigSummary()) => {
    if (!sessionRef.current) {
      return
    }

    await sessionRef.current.setMusicGenerationConfig({
      musicGenerationConfig: nextConfig,
    })

    const previousConfig = lastAppliedConfigRef.current
    const shouldResetContext =
      previousConfig !== null && previousConfig.bpm !== nextConfig.bpm

    lastAppliedConfigRef.current = nextConfig

    if (shouldResetContext) {
      await sessionRef.current.resetContext()
    }
  }

  const startStream = async () => {
    const apiKey = getApiKey()

    if (!apiKey) {
      setError('Add VITE_GEMINI_API_KEY to your environment before starting the stream.')
      setStatus('error')
      return
    }

    setError('')
    setStatus('connecting')
    resetPlaybackQueue()

    try {
      await stopStream(null)
      await ensureAudioContext()
      resetPlaybackQueue()

      const client = new GoogleGenAI({
        apiKey,
        apiVersion: 'v1alpha',
      })

      const session = await client.live.music.connect({
        model: MODEL,
        callbacks: {
          onmessage: (message: LiveMusicServerMessage) => {
            const audioChunks = message.serverContent?.audioChunks ?? []

            for (const chunk of audioChunks) {
              if (chunk.data) {
                void schedulePcm16Chunk(chunk.data, chunk.mimeType)
              }
            }
          },
          onerror: (sessionError: unknown) => {
            const nextError =
              sessionError instanceof Error
                ? sessionError.message
                : 'The music stream failed unexpectedly.'
            setError(nextError)
            setStatus('error')
          },
          onclose: () => {
            if (!isUnmountingRef.current) {
              setStatus((currentStatus) =>
                currentStatus === 'error' ? currentStatus : 'stopped',
              )
            }
          },
        },
      })

      sessionRef.current = session

      await applyPrompt(prompt)
      await applyConfig()
      session.play()

      setStatus('streaming')
    } catch (streamError) {
      const nextError =
        streamError instanceof Error
          ? streamError.message
          : 'Unable to connect to the Lyria realtime model.'
      setError(nextError)
      setStatus('error')
      await stopStream(null)
    }
  }

  const playStream = async () => {
    try {
      setError('')

      if (!sessionRef.current) {
        await startStream()
        return
      }

      await ensureAudioContext()
      sessionRef.current.play()
      setStatus('streaming')
    } catch (playError) {
      const nextError =
        playError instanceof Error ? playError.message : 'Unable to resume playback.'
      setError(nextError)
      setStatus('error')
    }
  }

  const pauseStream = async () => {
    if (!sessionRef.current) {
      return
    }

    try {
      sessionRef.current.pause()

      if (audioContextRef.current?.state === 'running') {
        await audioContextRef.current.suspend()
      }

      setStatus('paused')
    } catch (pauseError) {
      const nextError =
        pauseError instanceof Error ? pauseError.message : 'Unable to pause playback.'
      setError(nextError)
      setStatus('error')
    }
  }

  const toggleVocals = async () => {
    const nextVocalsEnabled = !vocalsEnabled
    setVocalsEnabled(nextVocalsEnabled)

    if (!sessionRef.current) {
      return
    }

    try {
      await sessionRef.current.setWeightedPrompts({
        weightedPrompts: [
          {
            text: nextVocalsEnabled ? `${prompt}, Vocals` : prompt,
            weight: 1,
          },
        ],
      })

      const nextConfig: LiveMusicGenerationConfig = {
        ...getConfigSummary(),
        musicGenerationMode: nextVocalsEnabled
          ? MusicGenerationMode.VOCALIZATION
          : MusicGenerationMode.QUALITY,
      }

      await sessionRef.current.setMusicGenerationConfig({
        musicGenerationConfig: nextConfig,
      })

      lastAppliedConfigRef.current = nextConfig
    } catch (vocalsError) {
      setVocalsEnabled(!nextVocalsEnabled)
      const nextError =
        vocalsError instanceof Error ? vocalsError.message : 'Unable to update vocals.'
      setError(nextError)
      setStatus('error')
    }
  }

  const syncPrompt = async () => {
    if (!sessionRef.current) {
      return
    }

    try {
      setError('')
      await applyPrompt(prompt)
    } catch (promptError) {
      const nextError =
        promptError instanceof Error ? promptError.message : 'Unable to update the prompt.'
      setError(nextError)
      setStatus('error')
    }
  }

  const syncConfig = async () => {
    if (!sessionRef.current) {
      return
    }

    try {
      setError('')
      await applyConfig()
    } catch (configError) {
      const nextError =
        configError instanceof Error
          ? configError.message
          : 'Unable to update the generation settings.'
      setError(nextError)
      setStatus('error')
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Realtime music streaming</p>
        <h1>Lyria control room</h1>
        <p className="hero-copy">
          Play or pause the stream, toggle vocals, and tune the groove live while the
          track keeps moving.
        </p>

        <div className="status-row">
          <span className={`status-pill status-${status}`}>{status}</span>
          <span className="status-meta">Model: {MODEL}</span>
          <span className="status-meta">Format: PCM16 / {SAMPLE_RATE} Hz</span>
        </div>

        <div className="cta-row">
          <button
            className="primary-button"
            disabled={status === 'connecting'}
            onClick={() => void (status === 'streaming' ? pauseStream() : playStream())}
          >
            {status === 'streaming' ? 'Pause' : 'Play'}
          </button>
          <button
            className="secondary-button"
            disabled={!isDocumentPiPSupported}
            onClick={() => void openDocumentPiP()}
          >
            Pop out player
          </button>
        </div>

        <div className="capture-row">
          <button
            className={captureOn ? 'primary-button capture-toggle' : 'secondary-button capture-toggle'}
            onClick={() => void toggleCapture()}
          >
            {captureOn ? 'Turn me off' : 'Turn me on'}
          </button>
          <p className="capture-status">{captureStatus}</p>
        </div>

        <p className="helper-copy">
          Use `VITE_GEMINI_API_KEY` in your local environment. When supported, the app
          will try to move into Document Picture-in-Picture if you switch away while
          streaming.
        </p>

        {pipMessage ? <p className="helper-copy">{pipMessage}</p> : null}
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="controls-grid">
        <section className="control-card">
          <div className="card-heading">
            <p className="card-kicker">Prompt</p>
            <h2>Shape the track</h2>
          </div>

          <label className="field-label" htmlFor="prompt">
            Weighted prompt
          </label>
          <textarea
            id="prompt"
            className="text-input prompt-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the sound you want Lyria to generate."
            rows={5}
          />
          <button
            className="secondary-button full-width"
            disabled={!sessionRef.current}
            onClick={() => void syncPrompt()}
          >
            Apply prompt
          </button>
        </section>

        <section className="control-card">
          <div className="card-heading">
            <p className="card-kicker">Generation</p>
            <h2>Adjust the groove</h2>
          </div>

          <label className="field-label" htmlFor="bpm">
            BPM
          </label>
          <input
            id="bpm"
            className="range-input"
            type="range"
            min="60"
            max="200"
            value={bpm}
            onChange={(event) => setBpm(Number(event.target.value))}
          />
          <p className="value-readout">{bpm} BPM</p>

          <label className="field-label" htmlFor="density">
            Density
          </label>
          <input
            id="density"
            className="range-input"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={density}
            onChange={(event) => setDensity(Number(event.target.value))}
          />
          <p className="value-readout">{density.toFixed(2)} density</p>

          <label className="field-label" htmlFor="brightness">
            Brightness
          </label>
          <input
            id="brightness"
            className="range-input"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={brightness}
            onChange={(event) => setBrightness(Number(event.target.value))}
          />
          <p className="value-readout">{brightness.toFixed(2)} brightness</p>

          <label className="toggle-row" htmlFor="vocals-enabled">
            <span className="field-label toggle-label">Vocals</span>
            <input
              id="vocals-enabled"
              type="checkbox"
              checked={vocalsEnabled}
              disabled={status === 'connecting'}
              onChange={() => void toggleVocals()}
            />
          </label>

          <label className="toggle-row" htmlFor="only-bass-and-drums">
            <span className="field-label toggle-label">Only bass and drums</span>
            <input
              id="only-bass-and-drums"
              type="checkbox"
              checked={onlyBassAndDrums}
              onChange={(event) => setOnlyBassAndDrums(event.target.checked)}
            />
          </label>

          <button className="secondary-button full-width" disabled={!sessionRef.current} onClick={() => void syncConfig()}>
            Apply settings
          </button>
        </section>
      </section>

      {/* Hidden elements for screen capture — never visible to user */}
      <video ref={videoRef} style={{ display: 'none' }} muted playsInline />
      <canvas ref={canvasRef} width={1280} height={720} style={{ display: 'none' }} />
    </main>
  )
}

export default App
