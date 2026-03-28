import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  GoogleGenAI,
  MusicGenerationMode,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai'
import './App.css'

const MODEL = 'models/lyria-realtime-exp'
const VEO_MODEL = 'veo-2.0-generate-001'
const SAMPLE_RATE = 48000
const CHANNELS = 2
const DEFAULT_BPM = 90
const DEFAULT_DENSITY = 0.6
const DEFAULT_BRIGHTNESS = 0.55
const DEFAULT_PROMPT =
  'Minimal techno with deep bass, sparse percussion, and atmospheric synths'
const VIDEO_POLL_INTERVAL_MS = 10000
const VIDEO_DURATION_SECONDS = 8

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

type VideoGenerationStatus = 'idle' | 'generating' | 'ready' | 'fallback' | 'error'

type MoodPalette = {
  label: string
  accent1: string
  accent2: string
  accent3: string
  glow: string
}

type VisualCircle = {
  id: string
  size: number
  top: number
  left: number
  color: string
  duration: number
  delay: number
  driftX: number
  driftY: number
  scale: number
}

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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const getMoodPalette = (musicPrompt: string): MoodPalette => {
  const prompt = musicPrompt.toLowerCase()

  if (prompt.includes('techno') || prompt.includes('electro') || prompt.includes('club')) {
    return {
      label: 'Neon pulse',
      accent1: '#ff4d9d',
      accent2: '#00e5ff',
      accent3: '#f9f871',
      glow: 'rgba(255, 77, 157, 0.35)',
    }
  }

  if (prompt.includes('ambient') || prompt.includes('atmospheric') || prompt.includes('dream')) {
    return {
      label: 'Aurora bloom',
      accent1: '#67e8f9',
      accent2: '#a78bfa',
      accent3: '#34d399',
      glow: 'rgba(103, 232, 249, 0.3)',
    }
  }

  if (prompt.includes('lofi') || prompt.includes('lo-fi') || prompt.includes('study')) {
    return {
      label: 'Sunset drift',
      accent1: '#fb7185',
      accent2: '#fdba74',
      accent3: '#facc15',
      glow: 'rgba(251, 113, 133, 0.3)',
    }
  }

  return {
    label: 'Ember motion',
    accent1: '#fb7185',
    accent2: '#f97316',
    accent3: '#c084fc',
    glow: 'rgba(249, 115, 22, 0.3)',
  }
}

const getSeedFromPrompt = (prompt: string) => {
  let seed = 0
  for (let index = 0; index < prompt.length; index += 1) {
    seed = (seed * 31 + prompt.charCodeAt(index)) >>> 0
  }
  return seed || 1
}

const createSeededRandom = (seed: number) => {
  let current = seed
  return () => {
    current = (current * 1664525 + 1013904223) >>> 0
    return current / 4294967296
  }
}

const buildVisualCircles = (
  musicPrompt: string,
  palette: MoodPalette,
  sceneIndex: number,
): VisualCircle[] => {
  const random = createSeededRandom(getSeedFromPrompt(`${musicPrompt}:${sceneIndex}`))
  const colors = [palette.accent1, palette.accent2, palette.accent3, '#ffffff']

  return Array.from({ length: 14 }, (_, index) => {
    const size = 28 + Math.round(random() * 150)
    return {
      id: `${musicPrompt}-${sceneIndex}-${index}`,
      size,
      top: Math.round(random() * 78),
      left: Math.round(random() * 78),
      color: colors[index % colors.length],
      duration: 3.8 + random() * 1.6,
      delay: random() * 1.1,
      driftX: Math.round((random() - 0.5) * 68),
      driftY: Math.round((random() - 0.5) * 68),
      scale: 0.75 + random() * 0.7,
    }
  })
}

const buildVisualCircle = (
  musicPrompt: string,
  palette: MoodPalette,
  circleToken: number,
  index: number,
): VisualCircle => buildVisualCircles(musicPrompt, palette, circleToken).at(index % 14)!

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
  const [videoEnabled, setVideoEnabled] = useState(false)
  const [videoStatus, setVideoStatus] = useState<VideoGenerationStatus>('idle')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoMessage, setVideoMessage] = useState('Video visuals are off.')
  const [videoPromptUsed, setVideoPromptUsed] = useState<string | null>(null)

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
  const showDebugRef = useRef(false)

  const isDocumentPiPSupported =
    typeof window !== 'undefined' && 'documentPictureInPicture' in window
  const videoRequestIdRef = useRef(0)
  const visualCircleTokenRef = useRef(0)
  const visualCircleTimersRef = useRef<number[]>([])
  const visualMusicPromptRef = useRef(currentMusicPrompt)
  const visualPaletteRef = useRef(getMoodPalette(currentMusicPrompt))
  const moodPalette = getMoodPalette(currentMusicPrompt)
  const [visualCircles, setVisualCircles] = useState<VisualCircle[]>(() =>
    buildVisualCircles('ambient', getMoodPalette('ambient'), 0),
  )
  const pipVisualCircles = visualCircles.slice(0, 8)
  const visualStyle = {
    '--visual-accent-1': moodPalette.accent1,
    '--visual-accent-2': moodPalette.accent2,
    '--visual-accent-3': moodPalette.accent3,
    '--visual-glow': moodPalette.glow,
  } as CSSProperties

  const closeDocumentPiP = () => {
    pipWindowRef.current?.close()
    pipWindowRef.current = null
  }

  useEffect(() => {
    visualMusicPromptRef.current = currentMusicPrompt
    visualPaletteRef.current = getMoodPalette(currentMusicPrompt)
  }, [currentMusicPrompt])

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

  const getVideoStatusLabel = () => {
    if (!videoEnabled) return 'Off'
    if (videoStatus === 'generating') return 'On - generating'
    if (videoStatus === 'ready') return 'On - Veo ready'
    if (videoStatus === 'fallback') return 'On - live visuals'
    if (videoStatus === 'error') return 'On - issue'
    return 'On'
  }

  const buildVideoPrompt = () =>
    [
      'Abstract music visualizer on a pure black background.',
      'Clear solid circles of many sizes moving like a music video visualizer.',
      'No blur, no gray rings, no haze, no fog.',
      'Bright clean circular pulses that populate and depopulate across the frame.',
      'Vivid neon color, crisp edges, smooth looping motion.',
      `Primary colors are ${moodPalette.accent1}, ${moodPalette.accent2}, and ${moodPalette.accent3}.`,
      `Music mood: ${currentMusicPrompt}.`,
      'No people, no text, no logos, no scenery.',
    ].join(' ')

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
        setCaptureStatus(`Capturing every 3s — last captured at ${timeStr}`)
        console.log('[Screenshot] Captured at ' + timeStr + ', base64 length: ' + dataUrl.length)
        void analyzeAndUpdateRef.current?.(dataUrl)
      }, 3000)

      setCaptureOn(true)
      setCaptureStatus('Capturing every 3s — waiting for first capture...')
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

  const toggleVideoEnabled = () => {
    setVideoEnabled(previousValue => {
      const nextValue = !previousValue
      if (!nextValue) {
        setVideoMessage('Video visuals are off.')
      } else if (videoStatus === 'ready') {
        setVideoMessage('Showing the latest Veo visual.')
      } else if (videoStatus === 'generating') {
        setVideoMessage('Generating a Veo visual...')
      } else {
        setVideoMessage('Showing live color visuals.')
      }
      return nextValue
    })
  }

  const handleVisualPlaybackError = () => {
    setVideoUrl(null)
    setVideoStatus('fallback')
    if (videoEnabled) {
      setVideoMessage('Veo video could not play here, so live visuals are showing instead.')
    }
  }

  useEffect(() => {
    visualCircleTimersRef.current.forEach(timeoutId => window.clearTimeout(timeoutId))
    visualCircleTimersRef.current = []
    visualCircleTokenRef.current = 0

    const initialCircles = buildVisualCircles(
      visualMusicPromptRef.current,
      visualPaletteRef.current,
      0,
    )
    setVisualCircles(initialCircles)

    const scheduleCircleRespawn = (index: number, circle: VisualCircle) => {
      const timeoutId = window.setTimeout(() => {
        visualCircleTokenRef.current += 1
        const nextCircle = buildVisualCircle(
          visualMusicPromptRef.current,
          visualPaletteRef.current,
          visualCircleTokenRef.current,
          index,
        )

        setVisualCircles(previousCircles =>
          previousCircles.map((currentCircle, currentIndex) =>
            currentIndex === index ? nextCircle : currentCircle,
          ),
        )

        scheduleCircleRespawn(index, nextCircle)
      }, (circle.delay + circle.duration) * 1000)

      visualCircleTimersRef.current.push(timeoutId)
    }

    initialCircles.forEach((circle, index) => {
      scheduleCircleRespawn(index, circle)
    })

    return () => {
      visualCircleTimersRef.current.forEach(timeoutId => window.clearTimeout(timeoutId))
      visualCircleTimersRef.current = []
    }
  }, [])

  const generateVideo = async () => {
    const apiKey = getApiKey()

    if (!apiKey) {
      setError('Add VITE_GEMINI_API_KEY to your environment before generating a Veo video.')
      setVideoStatus('error')
      return
    }

    const requestId = videoRequestIdRef.current + 1
    videoRequestIdRef.current = requestId
    const nextVideoPrompt = buildVideoPrompt()

    setError('')
    setVideoEnabled(true)
    setVideoStatus('generating')
    setVideoMessage('Generating a colorful Veo visual on black background...')
    setVideoPromptUsed(nextVideoPrompt)

    try {
      const client = new GoogleGenAI({ apiKey })
      let operation = await client.models.generateVideos({
      model: VEO_MODEL,
      source: { prompt: nextVideoPrompt },
      config: {
        numberOfVideos: 1,
        aspectRatio: '16:9',
        durationSeconds: VIDEO_DURATION_SECONDS,
        negativePrompt:
          'people faces text subtitles logos watermark scenery bright background white background',
      },
    })

      while (!operation.done) {
        await sleep(VIDEO_POLL_INTERVAL_MS)
        if (videoRequestIdRef.current !== requestId || isUnmountingRef.current) {
          return
        }
        operation = await client.operations.getVideosOperation({ operation })
      }

      if (videoRequestIdRef.current !== requestId || isUnmountingRef.current) {
        return
      }

      const nextVideoUrl = operation.response?.generatedVideos?.[0]?.video?.uri?.trim() ?? ''

      if (!nextVideoUrl) {
        setVideoUrl(null)
        setVideoStatus('fallback')
        setVideoMessage('Veo did not return a browser-playable URL, so live visuals are showing.')
        return
      }

      setVideoUrl(nextVideoUrl)
      setVideoStatus('ready')
      setVideoMessage('Showing the latest Veo visual.')
    } catch (videoError) {
      console.error('[Video]', videoError)
      setVideoUrl(null)
      setVideoStatus('fallback')
      setVideoMessage('Veo was unavailable, so live visuals are showing instead.')
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

      .pip-visual-stage {
        position: relative;
        min-height: 150px;
        overflow: hidden;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: #000;
      }

      .pip-visual-video {
        width: 100%;
        height: 100%;
        min-height: 150px;
        object-fit: cover;
        display: block;
      }

      .pip-fallback {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at center, rgba(255, 255, 255, 0.03), transparent 48%),
          #000;
        transition: background 0.9s ease, opacity 0.3s ease;
      }

      .pip-fallback.hidden { opacity: 0; }

      .pip-shape {
        position: absolute;
        border-radius: 999px;
        filter: none;
        opacity: 0;
        mix-blend-mode: screen;
        animation: pip-orbit var(--pip-duration) ease-in-out infinite;
        animation-delay: var(--pip-delay);
        transition: background-color 0.9s ease;
      }

      .pip-visual-overlay {
        position: absolute;
        inset: auto 10px 10px 10px;
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.5);
      }

      .pip-visual-label {
        margin: 0 0 3px;
        font-size: 0.58rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(248, 250, 252, 0.72);
      }

      .pip-visual-value {
        margin: 0;
        font-size: 0.74rem;
        color: #f8fafc;
      }

      @keyframes pip-orbit {
        0%, 100% { transform: translate3d(0, 0, 0) scale(0.35); opacity: 0; }
        16% { opacity: 0.52; }
        34% { opacity: 0.96; }
        60% { transform: translate3d(var(--pip-dx), var(--pip-dy), 0) scale(var(--pip-scale)); opacity: 1; }
        82% { opacity: 0.24; }
        92% { opacity: 0.06; }
      }


      .pip-now-playing {
        padding: 8px 10px;
        border: 1px solid rgba(249, 115, 22, 0.22);
        border-radius: 12px;
        background: rgba(249, 115, 22, 0.07);
      }

      .pip-now-playing-label {
        margin: 0 0 3px;
        font-size: 0.6rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #f7b267;
      }

      .pip-now-playing-value {
        margin: 0;
        font-size: 0.82rem;
        color: #f8fafc;
        line-height: 1.4;
        word-break: break-word;
      }

      .pip-debug-toggle {
        width: 100%;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.09) !important;
        border-radius: 10px;
        padding: 6px 10px;
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: rgba(226, 232, 240, 0.45);
        cursor: pointer;
        text-align: left;
      }

      .pip-debug-toggle:hover {
        background: rgba(255, 255, 255, 0.07);
        color: rgba(226, 232, 240, 0.65);
      }

      .pip-debug-drawer {
        display: none;
      }

      .pip-debug-drawer.open {
        display: grid;
        gap: 5px;
      }

      .pip-debug-row {
        padding: 7px 9px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 10px;
        background: rgba(0, 0, 0, 0.28);
      }

      .pip-debug-label {
        margin: 0 0 2px;
        font-size: 0.58rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(247, 178, 103, 0.65);
      }

      .pip-debug-value {
        margin: 0;
        font-family: ui-monospace, Consolas, monospace;
        font-size: 0.7rem;
        color: rgba(226, 232, 240, 0.65);
        line-height: 1.4;
        word-break: break-word;
      }

      .pip-debug-value-false {
        color: rgba(148, 163, 184, 0.5);
      }

      .pip-debug-value-change {
        color: #86efac;
        font-weight: 700;
      }

      .pip-debug-thumbnail {
        max-height: 70px;
        width: auto;
        max-width: 100%;
        object-fit: contain;
        border-radius: 6px;
        display: block;
        border: 1px solid rgba(255, 255, 255, 0.08);
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

    const debugOpen = showDebugRef.current
    const safeVideoUrl = videoUrl ? escapeHtml(videoUrl) : ''
    const visualHtml = videoEnabled && videoUrl
      ? `<video class="pip-visual-video" src="${safeVideoUrl}" autoplay loop muted playsinline></video>`
      : ''
    const shell = pipWindow.document.createElement('main')
    shell.className = 'pip-shell'
    shell.innerHTML = `
      <div class="pip-title-bar">
        <h1 class="pip-title">Gio controls</h1>
        <span class="pip-status ${status}">${status}</span>
      </div>
      <div class="pip-visual-stage" style="--pip-accent-1:${moodPalette.accent1};--pip-accent-2:${moodPalette.accent2};--pip-accent-3:${moodPalette.accent3};">
        ${visualHtml}
        <div class="pip-fallback${!videoEnabled || !videoUrl || videoStatus !== 'ready' ? '' : ' hidden'}">
          ${pipVisualCircles
            .map(circle => `
              <div
                class="pip-shape"
                style="
                  width:${circle.size * 0.55}px;
                  height:${circle.size * 0.55}px;
                  top:${circle.top}%;
                  left:${circle.left}%;
                  background:${circle.color};
                  --pip-dx:${circle.driftX * 0.55}px;
                  --pip-dy:${circle.driftY * 0.55}px;
                  --pip-scale:${circle.scale.toFixed(2)};
                  --pip-duration:${circle.duration.toFixed(2)}s;
                  --pip-delay:${circle.delay.toFixed(2)}s;
                "
              ></div>
            `)
            .join('')}
        </div>
        <div class="pip-visual-overlay">
          <p class="pip-visual-label">Visual mood</p>
          <p class="pip-visual-value">${escapeHtml(moodPalette.label)}</p>
        </div>
      </div>
      <div class="pip-now-playing">
        <p class="pip-now-playing-label">Now playing</p>
        <p class="pip-now-playing-value">${escapeHtml(currentMusicPrompt)}</p>
      </div>
      <button class="pip-debug-toggle" type="button">Debug ${debugOpen ? '▲' : '▼'}</button>
      <div class="pip-debug-drawer${debugOpen ? ' open' : ''}">
        <div class="pip-debug-row">
          <p class="pip-debug-label">Video</p>
          <p class="pip-debug-value">${escapeHtml(getVideoStatusLabel())}</p>
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Color mood</p>
          <p class="pip-debug-value">${escapeHtml(moodPalette.label)}</p>
        </div>
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

    shell.querySelector<HTMLButtonElement>('.pip-debug-toggle')?.addEventListener('click', () => {
      showDebugRef.current = !showDebugRef.current
      updatePiPContents()
    })

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
    currentMusicPrompt,
    videoEnabled, videoStatus, videoUrl, videoMessage,
  ])

  useEffect(() => {
    const pipWindow = pipWindowRef.current

    if (!pipWindow || pipWindow.closed) {
      return
    }

    const shell = pipWindow.document.body.querySelector('.pip-shell')
    if (!shell) {
      return
    }

    const thumbnailHtml = latestScreenshot
      ? `<img class="pip-debug-thumbnail" src="${latestScreenshot}" alt="Last capture" />`
      : `<p class="pip-debug-value">No capture yet</p>`

    const activityHtml = lastDetectedActivity
      ? `<p class="pip-debug-value">${lastDetectedActivity.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`
      : `<p class="pip-debug-value">Waiting for first analysis...</p>`

    let decisionHtml = `<p class="pip-debug-value">Waiting...</p>`
    if (lastGeminiDecision === 'FALSE') {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-false">No change (FALSE)</p>`
    } else if (lastGeminiDecision) {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-change">Changed to: ${lastGeminiDecision.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`
    }

    const debugRows = shell.querySelectorAll('.pip-debug-row')
    const updateDebugRow = (index: number, html: string) => {
      const row = debugRows[index] as HTMLElement | undefined
      const label = row?.querySelector('.pip-debug-label')?.outerHTML
      if (!row || !label) {
        return
      }
      row.innerHTML = `${label}${html}`
    }

    updateDebugRow(2, thumbnailHtml)
    updateDebugRow(3, activityHtml)
    updateDebugRow(4, decisionHtml)

    const analysisNode = debugRows[5]?.querySelector('.pip-debug-value')
    if (analysisNode) {
      analysisNode.textContent = lastAnalysisTime ?? 'Not yet'
    }
  }, [latestScreenshot, lastDetectedActivity, lastGeminiDecision, lastAnalysisTime])

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

        <div className="cta-row">
          <span className={`status-pill status-${status}`}>{status}</span>
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

      <section className="visual-panel" style={visualStyle}>
        <div className="visual-panel-copy">
          <p className="card-kicker">Visuals</p>
          <h2>Music video layer</h2>
          <p className="visual-panel-text">
            Generate a Veo clip for the current music, or keep the built-in colorful
            shape animation on.
          </p>
          <div className="visual-chip-row">
            <span className="visual-chip">Video {videoEnabled ? 'On' : 'Off'}</span>
            <span className="visual-chip">Color mood {moodPalette.label}</span>
          </div>
          <div className="visual-actions">
            <button
              className="primary-button"
              disabled={videoStatus === 'generating'}
              onClick={() => void generateVideo()}
            >
              {videoStatus === 'generating' ? 'Generating video...' : 'Generate video'}
            </button>
            <button className="secondary-button" onClick={toggleVideoEnabled}>
              {videoEnabled ? 'Video off' : 'Video on'}
            </button>
          </div>
          <p className="visual-status-copy">{videoMessage}</p>
          {videoPromptUsed ? (
            <p className="visual-meta">
              Last prompt: <span>{videoPromptUsed}</span>
            </p>
          ) : null}
        </div>

        <div className={`visual-stage-shell ${videoEnabled ? 'is-on' : 'is-off'}`} style={visualStyle}>
          {videoEnabled && videoUrl ? (
            <video
              key={videoUrl}
              className="visual-stage-video"
              src={videoUrl}
              autoPlay
              loop
              muted
              playsInline
              onError={handleVisualPlaybackError}
            />
          ) : null}
          <div
            className={`visual-fallback-layer ${
              !videoEnabled || !videoUrl || videoStatus !== 'ready' ? 'visible' : ''
            }`}
          >
            {visualCircles.map(circle => (
              <div
                key={circle.id}
                className="visual-shape"
                style={{
                  width: `${circle.size}px`,
                  height: `${circle.size}px`,
                  top: `${circle.top}%`,
                  left: `${circle.left}%`,
                  background: circle.color,
                  ['--circle-dx' as string]: `${circle.driftX}px`,
                  ['--circle-dy' as string]: `${circle.driftY}px`,
                  ['--circle-scale' as string]: circle.scale.toFixed(2),
                  ['--circle-duration' as string]: `${circle.duration.toFixed(2)}s`,
                  ['--circle-delay' as string]: `${circle.delay.toFixed(2)}s`,
                }}
              />
            ))}
          </div>
          <div className="visual-stage-overlay">
            <p className="visual-stage-label">Current mood</p>
            <p className="visual-stage-value">{moodPalette.label}</p>
            <p className="visual-stage-subvalue">{currentMusicPrompt}</p>
          </div>
        </div>
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

      <section className="powered-by-section">
        <p className="eyebrow">Stack</p>
        <h2 className="powered-by-heading">Powered by</h2>
        <div className="powered-by-grid">
          <div className="powered-by-card">
            <p className="powered-by-model">gemini-2.5-flash</p>
            <p className="powered-by-desc">Vision analysis and music direction</p>
            <div className="powered-by-badges">
              <span className="powered-by-badge badge-ai">Vision</span>
              <span className="powered-by-badge badge-ai">Reasoning</span>
            </div>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">lyria-realtime-exp</p>
            <p className="powered-by-desc">Realtime adaptive music generation</p>
            <div className="powered-by-badges">
              <span className="powered-by-badge badge-ai">Music Generation</span>
            </div>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">veo-2.0-generate-001</p>
            <p className="powered-by-desc">Color video generation for the visual layer</p>
            <div className="powered-by-badges">
              <span className="powered-by-badge badge-ai">Video Generation</span>
            </div>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">getDisplayMedia</p>
            <p className="powered-by-desc">Screen capture for activity analysis</p>
            <span className="powered-by-badge badge-browser">Browser API</span>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">Picture-in-Picture API</p>
            <p className="powered-by-desc">Floating player while you work</p>
            <span className="powered-by-badge badge-browser">Browser API</span>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">Web Audio API</p>
            <p className="powered-by-desc">PCM16 audio scheduling and playback</p>
            <span className="powered-by-badge badge-browser">Browser API</span>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">Canvas API</p>
            <p className="powered-by-desc">Frame extraction from video stream</p>
            <span className="powered-by-badge badge-browser">Browser API</span>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">WebSocket API</p>
            <p className="powered-by-desc">Realtime connection to Lyria model</p>
            <span className="powered-by-badge badge-browser">Browser API</span>
          </div>
        </div>
      </section>

      {/* Hidden elements for screen capture — never visible to user */}
      <video ref={videoRef} style={{ display: 'none' }} muted playsInline />
      <canvas ref={canvasRef} width={1280} height={720} style={{ display: 'none' }} />
    </main>
  )
}

export default App
