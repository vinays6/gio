import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  GoogleGenAI,
  MusicGenerationMode,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai'
import './App.css'

const MODEL = 'models/lyria-realtime-exp'
const SAMPLE_RATE = 48000
const CHANNELS = 2
const DEFAULT_PROMPT =
  'Minimal techno with deep bass, sparse percussion, and atmospheric synths'

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
  const [temperature, setTemperature] = useState(1)
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'streaming' | 'stopped' | 'error'
  >('idle')
  const [error, setError] = useState('')
  const [pipMessage, setPipMessage] = useState('')

  const sessionRef = useRef<LiveMusicSession | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextPlaybackTimeRef = useRef(0)
  const isUnmountingRef = useRef(false)
  const pipWindowRef = useRef<Window | null>(null)

  const isDocumentPiPSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window

  const closeDocumentPiP = () => {
    pipWindowRef.current?.close()
    pipWindowRef.current = null
  }

  const updatePiPContents = () => {
    const pipWindow = pipWindowRef.current

    if (!pipWindow || pipWindow.closed) {
      pipWindowRef.current = null
      return
    }

    pipWindow.document.title = 'Lyria control room'
    pipWindow.document.body.innerHTML = ''

    const style = pipWindow.document.createElement('style')
    style.textContent = `
      :root {
        color-scheme: dark;
        font-family: Inter, "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 18px;
        box-sizing: border-box;
        background:
          radial-gradient(circle at top left, rgba(249, 115, 22, 0.34), transparent 32%),
          linear-gradient(180deg, #08131f 0%, #101d2f 100%);
        color: #f8fafc;
      }

      .pip-shell {
        display: grid;
        gap: 14px;
        min-height: calc(100vh - 36px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 24px;
        padding: 18px;
        background: rgba(7, 12, 20, 0.78);
        backdrop-filter: blur(18px);
      }

      .pip-eyebrow,
      .pip-meta {
        margin: 0;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .pip-eyebrow {
        color: #f7b267;
        font-size: 0.72rem;
        font-weight: 700;
      }

      .pip-title {
        margin: 0;
        font-size: 1.8rem;
        line-height: 0.95;
      }

      .pip-status {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        min-height: 38px;
        width: fit-content;
        border-radius: 999px;
        padding: 0 14px;
        background: rgba(34, 197, 94, 0.2);
        color: #86efac;
        font-weight: 700;
        text-transform: capitalize;
      }

      .pip-status.connecting {
        background: rgba(251, 191, 36, 0.18);
        color: #fde68a;
      }

      .pip-status.idle,
      .pip-status.stopped {
        background: rgba(148, 163, 184, 0.16);
        color: #cbd5e1;
      }

      .pip-status.error {
        background: rgba(248, 113, 113, 0.18);
        color: #fca5a5;
      }

      .pip-grid {
        display: grid;
        gap: 10px;
      }

      .pip-meta {
        color: rgba(226, 232, 240, 0.7);
        font-size: 0.68rem;
      }

      .pip-prompt {
        margin: 0;
        color: rgba(226, 232, 240, 0.92);
        line-height: 1.5;
      }

      .pip-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: auto;
      }

      button {
        border: 0;
        border-radius: 16px;
        padding: 12px 14px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      .pip-stop {
        background: linear-gradient(135deg, #f97316 0%, #fb7185 100%);
        color: #fff7ed;
      }

      .pip-return {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #e2e8f0;
      }
    `

    const shell = pipWindow.document.createElement('main')
    shell.className = 'pip-shell'
    shell.innerHTML = `
      <p class="pip-eyebrow">Document Picture-in-Picture</p>
      <h1 class="pip-title">Lyria control room</h1>
      <span class="pip-status ${status}">${status}</span>
      <div class="pip-grid">
        <p class="pip-meta">Prompt</p>
        <p class="pip-prompt">${prompt.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>
      </div>
      <div class="pip-grid">
        <p class="pip-meta">BPM</p>
        <p class="pip-prompt">${bpm}</p>
      </div>
      <div class="pip-grid">
        <p class="pip-meta">Temperature</p>
        <p class="pip-prompt">${temperature.toFixed(1)}</p>
      </div>
      ${
        error
          ? `<div class="pip-grid"><p class="pip-meta">Error</p><p class="pip-prompt">${error.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p></div>`
          : ''
      }
      <div class="pip-actions">
        <button class="pip-stop" type="button">Stop stream</button>
        <button class="pip-return" type="button">Return</button>
      </div>
    `

    pipWindow.document.head.innerHTML = ''
    pipWindow.document.head.appendChild(style)
    pipWindow.document.body.appendChild(shell)

    shell.querySelector<HTMLButtonElement>('.pip-stop')?.addEventListener('click', () => {
      void stopStream()
    })

    shell.querySelector<HTMLButtonElement>('.pip-return')?.addEventListener('click', () => {
      window.focus()
      closeDocumentPiP()
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
        width: 420,
        height: 520,
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
      void stopStream()
    }
  }, [])

  useEffect(() => {
    updatePiPContents()
  }, [bpm, error, prompt, status, temperature])

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
    nextPlaybackTimeRef.current = audioContext
      ? audioContext.currentTime + 0.05
      : 0
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

    const audioBuffer = audioContext.createBuffer(
      CHANNELS,
      frameCount,
      chunkSampleRate,
    )
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
      weightedPrompts: [{ text: nextPrompt, weight: 1 }],
    })
  }

  const applyConfig = async (nextBpm: number, nextTemperature: number) => {
    if (!sessionRef.current) {
      return
    }
    console.log(`Setting new config... ${nextBpm}, ${nextTemperature}`)

    await sessionRef.current.setMusicGenerationConfig({
      musicGenerationConfig: {
        bpm: nextBpm,
        temperature: nextTemperature,
        musicGenerationMode: MusicGenerationMode.VOCALIZATION,
      },
    })

    await sessionRef.current.resetContext();
  }

  const stopStream = async (nextStatus: 'idle' | null = 'idle') => {
    const currentSession = sessionRef.current
    sessionRef.current = null

    if (currentSession?.close) {
      await currentSession.close()
    }

    resetPlaybackQueue()

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close()
    }

    audioContextRef.current = null

    closeDocumentPiP()

    setStatus('idle')
    if (!isUnmountingRef.current && nextStatus) {
      setStatus(nextStatus)
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
            const message =
              sessionError instanceof Error
                ? sessionError.message
                : 'The music stream failed unexpectedly.'
            setError(message)
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
      await applyConfig(bpm, temperature)
      await session.play()

      setStatus('streaming')
    } catch (streamError) {
      const message =
        streamError instanceof Error
          ? streamError.message
          : 'Unable to connect to the Lyria realtime model.'
      setError(message)
      setStatus('error')
      await stopStream(null)
    }
  }

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!sessionRef.current) {
      return
    }

    try {
      await applyPrompt(prompt)
    } catch (promptError) {
      const message =
        promptError instanceof Error
          ? promptError.message
          : 'Unable to update the prompt.'
      setError(message)
      setStatus('error')
    }
  }

  const handleConfigSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!sessionRef.current) {
      return
    }

    try {
      await applyConfig(bpm, temperature)
    } catch (configError) {
      const message =
        configError instanceof Error
          ? configError.message
          : 'Unable to update the generation settings.'
      setError(message)
      setStatus('error')
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Realtime music streaming</p>
        <h1>Lyria control room</h1>
        <p className="hero-copy">
          Connect this React app to Google&apos;s Lyria realtime model, stream PCM16
          audio in the browser, and steer the track while it plays.
        </p>

        <div className="status-row">
          <span className={`status-pill status-${status}`}>{status}</span>
          <span className="status-meta">Model: {MODEL}</span>
          <span className="status-meta">Format: PCM16 / {SAMPLE_RATE} Hz</span>
        </div>

        <div className="cta-row">
          <button
            className="primary-button"
            disabled={status === 'connecting' || status === 'streaming'}
            onClick={() => void startStream()}
          >
            {status === 'connecting' ? 'Connecting...' : 'Start stream'}
          </button>
          <button
            className="secondary-button"
            disabled={!sessionRef.current}
            onClick={() => void stopStream()}
          >
            Stop stream
          </button>
          <button
            className="secondary-button"
            disabled={!sessionRef.current || !isDocumentPiPSupported}
            onClick={() => void openDocumentPiP()}
          >
            Pop out player
          </button>
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
        <form className="control-card" onSubmit={handlePromptSubmit}>
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
            rows={6}
          />
          <button className="secondary-button full-width" type="submit" disabled={!sessionRef.current}>
            Update prompt
          </button>
        </form>

        <form className="control-card" onSubmit={handleConfigSubmit}>
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
            max="180"
            value={bpm}
            onChange={(event) => setBpm(Number(event.target.value))}
          />
          <p className="value-readout">{bpm} BPM</p>

          <label className="field-label" htmlFor="temperature">
            Temperature
          </label>
          <input
            id="temperature"
            className="range-input"
            type="range"
            min="0.1"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(event) => setTemperature(Number(event.target.value))}
          />
          <p className="value-readout">{temperature.toFixed(1)} intensity</p>

          <button className="secondary-button full-width" disabled={!sessionRef.current}>
            Update settings
          </button>
        </form>
      </section>
    </main>
  )
}

export default App
