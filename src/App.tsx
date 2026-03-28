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
const DEFAULT_BPM = 90
const DEFAULT_DENSITY = 0.6
const DEFAULT_BRIGHTNESS = 0.55
const DEFAULT_PROMPT =
  'Minimal techno with deep bass, sparse percussion, and atmospheric synths'

const ANALYSIS_SYSTEM_PROMPT = `You are a music director for a focus and productivity app. Your job is to decide whether the background music should change based on what the user is currently doing on their screen.

You will be given a screenshot of the user's screen and the current music descriptor string.

Respond in EXACTLY this format, always two lines, no exceptions:
ACTIVITY: [one sentence describing what the user is doing on screen]
MUSIC: [either the word FALSE, or a new short music descriptor phrase]

Rules for the MUSIC line:
- If the current music fits the activity well enough, write: MUSIC: FALSE
- If there is a dramatic mismatch (e.g. heavy metal while studying, party music while in a meeting), write a new descriptor: MUSIC: lo-fi hip hop
- The descriptor must be short (2-5 words), no punctuation, no explanation
- Never write anything other than FALSE or a descriptor phrase after "MUSIC: "

Do not add any other lines, explanation, or formatting.`

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
  const [bpm, setBpm] = useState(DEFAULT_BPM)
  const [density, setDensity] = useState(DEFAULT_DENSITY)
  const [brightness, setBrightness] = useState(DEFAULT_BRIGHTNESS)
  const [bpmOverridden, setBpmOverridden] = useState(false)
  const [densityOverridden, setDensityOverridden] = useState(false)
  const [brightnessOverridden, setBrightnessOverridden] = useState(false)
  const [vocalsEnabled, setVocalsEnabled] = useState(false)
  const [onlyBassAndDrums, setOnlyBassAndDrums] = useState(false)
  const [status, setStatus] = useState<StreamStatus>('idle')
  const [error, setError] = useState('')
  const [pipMessage, setPipMessage] = useState('')

  // Screenshot capture state
  const [captureOn, setCaptureOn] = useState(false)
  const [latestScreenshot, setLatestScreenshot] = useState<string | null>(null)
  const [captureStatus, setCaptureStatus] = useState('Not capturing')

  // Gemini-controlled music prompt + debug state
  const [currentMusicPrompt, setCurrentMusicPrompt] = useState('ambient')
  const [lastDetectedActivity, setLastDetectedActivity] = useState<string | null>(null)
  const [lastGeminiDecision, setLastGeminiDecision] = useState<string | null>(null)
  const [lastAnalysisTime, setLastAnalysisTime] = useState<string | null>(null)

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

  // Analysis refs
  const isAnalyzing = useRef(false)
  const analyzeAndUpdateRef = useRef<((dataUrl: string) => Promise<void>) | null>(null)

  const isDocumentPiPSupported =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window

  const closeDocumentPiP = () => {
    pipWindowRef.current?.close()
    pipWindowRef.current = null
  }

  const getEffectivePrompt = (basePrompt: string) =>
    vocalsEnabled ? `${basePrompt}, Vocals` : basePrompt

  const getConfigSummary = (): LiveMusicGenerationConfig => {
    const config: LiveMusicGenerationConfig = {
      onlyBassAndDrums,
      musicGenerationMode: vocalsEnabled
        ? MusicGenerationMode.VOCALIZATION
        : MusicGenerationMode.QUALITY,
    }

    if (bpmOverridden) {
      config.bpm = bpm
    }

    if (densityOverridden) {
      config.density = density
    }

    if (brightnessOverridden) {
      config.brightness = brightness
    }

    return config
  }

  const getApiKey = () => import.meta.env.VITE_GEMINI_API_KEY?.trim() ?? ''

  const applyPrompt = async (nextPrompt: string) => {
    if (!sessionRef.current) {
      console.log('[Analysis] applyPrompt called but sessionRef.current is null — stream not active')
      return
    }

    console.log('[Analysis] Lyria update called with:', nextPrompt)
    await sessionRef.current.setWeightedPrompts({
      weightedPrompts: [{ text: getEffectivePrompt(nextPrompt), weight: 1 }],
    })
  }

  // Defined every render so it always closes over fresh state; ref kept updated below.
  const analyzeAndUpdate = async (screenshotDataUrl: string) => {
    console.log('[Analysis] Starting analysis cycle')
    console.log('[Analysis] Screenshot exists:', !!screenshotDataUrl)

    if (isAnalyzing.current) {
      console.log('[Analysis] Skipping — previous analysis still in flight')
      return
    }
    isAnalyzing.current = true

    try {
      const apiKey = getApiKey()
      if (!apiKey) {
        console.log('[Analysis] Skipping — no API key')
        return
      }

      console.log('[Analysis] Sending to Gemini. Current music:', currentMusicPrompt)

      const base64Data = screenshotDataUrl.replace(/^data:image\/jpeg;base64,/, '')
      const client = new GoogleGenAI({ apiKey })
      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        config: { systemInstruction: ANALYSIS_SYSTEM_PROMPT },
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
              { text: `Current music: ${currentMusicPrompt}. What should the music be?` },
            ],
          },
        ],
      })

      const rawResponse = (response.text ?? '').trim()
      console.log('[Analysis] Raw Gemini response:', rawResponse)

      // Parse ACTIVITY: and MUSIC: lines
      const activityMatch = rawResponse.match(/^ACTIVITY:\s*(.+)$/m)
      const musicMatch = rawResponse.match(/^MUSIC:\s*(.+)$/m)

      const activityDescription = activityMatch ? activityMatch[1].trim() : rawResponse
      const musicDecision = musicMatch ? musicMatch[1].trim() : rawResponse

      console.log('[Analysis] Parsed activity:', activityDescription)
      console.log('[Analysis] Parsed music decision:', musicDecision)

      setLastDetectedActivity(activityDescription)
      setLastAnalysisTime(new Date().toLocaleTimeString())

      if (!musicDecision || musicDecision.toUpperCase() === 'FALSE') {
        console.log('[Analysis] Music unchanged (FALSE)')
        setLastGeminiDecision('FALSE')
      } else {
        console.log('[Analysis] Music changing from:', currentMusicPrompt, '→', musicDecision)
        setLastGeminiDecision(musicDecision)
        setCurrentMusicPrompt(musicDecision)
        await applyPrompt(musicDecision)
      }
    } catch (err) {
      console.error('[Analysis] Error:', err)
    } finally {
      isAnalyzing.current = false
    }
  }

  // Keep the ref pointing to the latest version of analyzeAndUpdate each render.
  analyzeAndUpdateRef.current = analyzeAndUpdate

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
        void analyzeAndUpdateRef.current?.(dataUrl)
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

    pipWindow.document.title = 'Gio controls'
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
        padding: 12px;
        box-sizing: border-box;
        background:
          radial-gradient(circle at top, rgba(249, 115, 22, 0.24), transparent 36%),
          linear-gradient(180deg, #08131f 0%, #101d2f 100%);
        color: #f8fafc;
      }

      .pip-shell {
        min-height: calc(100vh - 24px);
        display: grid;
        gap: 10px;
        align-content: start;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 20px;
        padding: 14px;
        background: rgba(7, 12, 20, 0.82);
        backdrop-filter: blur(18px);
      }

      .pip-title-bar {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .pip-title {
        margin: 0;
        font-size: 1.1rem;
        line-height: 1;
        flex: 1;
      }

      .pip-status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 28px;
        border-radius: 999px;
        padding: 0 10px;
        font-size: 0.72rem;
        font-weight: 700;
        text-transform: capitalize;
        background: rgba(148, 163, 184, 0.16);
        color: #cbd5e1;
        white-space: nowrap;
      }

      .pip-status.streaming { background: rgba(34, 197, 94, 0.2); color: #86efac; }
      .pip-status.connecting { background: rgba(251, 191, 36, 0.18); color: #fde68a; }
      .pip-status.error { background: rgba(248, 113, 113, 0.18); color: #fca5a5; }

      .pip-debug-panel {
        display: grid;
        gap: 8px;
      }

      .pip-debug-row {
        padding: 8px 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.04);
      }

      .pip-debug-label {
        margin: 0 0 3px;
        font-size: 0.6rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #f7b267;
      }

      .pip-debug-value {
        margin: 0;
        font-size: 0.78rem;
        color: rgba(226, 232, 240, 0.85);
        line-height: 1.4;
        word-break: break-word;
      }

      .pip-debug-value-false {
        color: rgba(148, 163, 184, 0.7);
      }

      .pip-debug-value-change {
        color: #86efac;
        font-weight: 700;
      }

      .pip-debug-thumbnail {
        max-height: 80px;
        width: auto;
        max-width: 100%;
        object-fit: contain;
        border-radius: 8px;
        display: block;
        border: 1px solid rgba(255, 255, 255, 0.1);
      }

      .pip-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      button {
        border: 0;
        border-radius: 14px;
        padding: 11px 12px;
        font: inherit;
        font-size: 0.82rem;
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
    `

    const isPlayable = status === 'paused' || status === 'stopped' || status === 'idle'
    const playPauseLabel = status === 'streaming' ? 'Pause' : 'Play'
    const vocalsLabel = vocalsEnabled ? 'Vocals on' : 'Vocals off'

    const thumbnailHtml = latestScreenshot
      ? `<img class="pip-debug-thumbnail" src="${latestScreenshot}" alt="Last capture" />`
      : `<p class="pip-debug-value">No capture yet</p>`

    const activityHtml = lastDetectedActivity
      ? `<p class="pip-debug-value">${lastDetectedActivity.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`
      : `<p class="pip-debug-value">Waiting for first analysis...</p>`

    let decisionHtml: string
    if (lastGeminiDecision === null) {
      decisionHtml = `<p class="pip-debug-value">Waiting...</p>`
    } else if (lastGeminiDecision === 'FALSE') {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-false">No change (FALSE)</p>`
    } else {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-change">Changed to: ${lastGeminiDecision.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`
    }

    const shell = pipWindow.document.createElement('main')
    shell.className = 'pip-shell'
    shell.innerHTML = `
      <div class="pip-title-bar">
        <h1 class="pip-title">Gio controls</h1>
        <span class="pip-status ${status}">${status}</span>
      </div>
      <div class="pip-debug-panel">
        <div class="pip-debug-row">
          <p class="pip-debug-label">Last screen capture</p>
          ${thumbnailHtml}
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Gemini sees</p>
          ${activityHtml}
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Gemini decision</p>
          ${decisionHtml}
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Now playing</p>
          <p class="pip-debug-value">${currentMusicPrompt.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Last analysis</p>
          <p class="pip-debug-value">${lastAnalysisTime ?? 'Not yet'}</p>
        </div>
      </div>
      <div class="pip-actions">
        <button class="pip-primary" type="button" ${status === 'connecting' ? 'disabled' : ''}>
          ${playPauseLabel}
        </button>
        <button class="pip-secondary" type="button" ${status === 'connecting' ? 'disabled' : ''}>
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
        width: 340,
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
      stopCapture()
      void stopStream(null)
    }
  }, [])

  useEffect(() => {
    updatePiPContents()
  }, [
    brightness, bpm, density, error, onlyBassAndDrums, status, vocalsEnabled,
    currentMusicPrompt, latestScreenshot, lastDetectedActivity, lastGeminiDecision, lastAnalysisTime,
  ])

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
        <h1>Gio control room</h1>
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

        <p className="helper-copy">
          Use `VITE_GEMINI_API_KEY` in your local environment. When supported, the app
          will try to move into Document Picture-in-Picture if you switch away while
          streaming.
        </p>

        {pipMessage ? <p className="helper-copy">{pipMessage}</p> : null}
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="controls-grid">
        <div className="controls-column">
          <section className="control-card control-card-half">
            <div className="card-heading">
              <p className="card-kicker">Prompt</p>
              <h2>Shape the track</h2>
            </div>

            <label className="field-label" htmlFor="prompt">
              Weighted prompt
            </label>
            <textarea
              id="prompt"
              className="text-input prompt-input prompt-input-compact"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the sound you want Lyria to generate."
              rows={3}
            />
            <button
              className="secondary-button full-width"
              disabled={!sessionRef.current}
              onClick={() => void syncPrompt()}
            >
              Apply prompt
            </button>
          </section>

          <section className="control-card control-card-half">
            <div className="card-heading">
              <p className="card-kicker">Capture</p>
              <h2>Activity Monitor</h2>
            </div>

            <div className="capture-row">
              <button
                className={captureOn ? 'primary-button capture-toggle' : 'secondary-button capture-toggle'}
                onClick={() => void toggleCapture()}
              >
                {captureOn ? 'Turn off Activity Monitor' : 'Activity Monitor'}
              </button>
              <p className="capture-status">{captureStatus}</p>
            </div>
          </section>
        </div>

        <section className="control-card">
          <div className="card-heading">
            <p className="card-kicker">Generation</p>
            <h2>Adjust the groove</h2>
          </div>

          <label className="field-label" htmlFor="bpm">
            BPM
          </label>
          <label className="setting-toggle-row" htmlFor="bpm-override">
            <span className="setting-toggle-copy">
              <span className="setting-toggle-title">Override</span>
              <span className="setting-toggle-description">
                {bpmOverridden ? `${bpm} BPM` : 'Infer'}
              </span>
            </span>
            <input
              id="bpm-override"
              type="checkbox"
              checked={bpmOverridden}
              onChange={(event) => setBpmOverridden(event.target.checked)}
            />
          </label>
          <input
            id="bpm"
            className="range-input"
            type="range"
            min="60"
            max="200"
            value={bpm}
            onChange={(event) => setBpm(Number(event.target.value))}
            disabled={!bpmOverridden}
          />
          <p className="value-readout">
            {bpmOverridden ? `${bpm} BPM override` : 'Model will infer BPM'}
          </p>

          <label className="field-label" htmlFor="density">
            Density
          </label>
          <label className="setting-toggle-row" htmlFor="density-override">
            <span className="setting-toggle-copy">
              <span className="setting-toggle-title">Override</span>
              <span className="setting-toggle-description">
                {densityOverridden ? density.toFixed(2) : 'Infer'}
              </span>
            </span>
            <input
              id="density-override"
              type="checkbox"
              checked={densityOverridden}
              onChange={(event) => setDensityOverridden(event.target.checked)}
            />
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
            disabled={!densityOverridden}
          />
          <p className="value-readout">
            {densityOverridden
              ? `${density.toFixed(2)} density override`
              : 'Model will infer density'}
          </p>

          <label className="field-label" htmlFor="brightness">
            Brightness
          </label>
          <label className="setting-toggle-row" htmlFor="brightness-override">
            <span className="setting-toggle-copy">
              <span className="setting-toggle-title">Override</span>
              <span className="setting-toggle-description">
                {brightnessOverridden ? brightness.toFixed(2) : 'Infer'}
              </span>
            </span>
            <input
              id="brightness-override"
              type="checkbox"
              checked={brightnessOverridden}
              onChange={(event) => setBrightnessOverridden(event.target.checked)}
            />
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
            disabled={!brightnessOverridden}
          />
          <p className="value-readout">
            {brightnessOverridden
              ? `${brightness.toFixed(2)} brightness override`
              : 'Model will infer brightness'}
          </p>

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
