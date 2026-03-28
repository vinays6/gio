import { useEffect, useRef, useState } from 'react'
import {
  GoogleGenAI,
  Modality,
  MusicGenerationMode,
  Session,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai'
import './App.css'

// ─── constants ────────────────────────────────────────────────────────────────

const MODEL = 'models/lyria-realtime-exp'
const GIO_MODEL = 'gemini-3.1-flash-live-preview'
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

const GIO_SYSTEM_PROMPT = `You are Gio, a smart personal assistant built into a music and productivity app. You can see the user's screen and hear their voice.

Your personality: calm, efficient, friendly. You get to the point quickly. You never ramble.

You have two modes:

MODE 1 — General assistant
Answer questions, help with tasks, give information. Keep answers concise unless the user asks for something long-form.

MODE 2 — Content generation (emails, messages, documents, lists)
When the user asks you to write, draft, compose, or create any piece of text (emails, Slack messages, to-do lists, summaries, etc.):
- Generate the complete content
- At the very end of your response, output a special block in EXACTLY this format:

<<<CLIPBOARD_START>>>
[the complete generated content, ready to paste, nothing else]
<<<CLIPBOARD_END>>>

This block will be automatically detected and copied to the user's clipboard. Only include this block when you have generated a complete piece of copyable content. Never include it for conversational responses.

You are aware of what is on the user's screen. Reference it naturally if relevant.`

// ─── types ────────────────────────────────────────────────────────────────────

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
    SpeechRecognition?: new () => any
    webkitSpeechRecognition?: new () => any
  }
}

// ─── component ────────────────────────────────────────────────────────────────

function App() {
  // Lyria / stream state
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

  // Gemini vision pipeline state
  const [currentMusicPrompt, setCurrentMusicPrompt] = useState('ambient')
  const [lastDetectedActivity, setLastDetectedActivity] = useState<string | null>(null)
  const [lastGeminiDecision, setLastGeminiDecision] = useState<string | null>(null)
  const [lastAnalysisTime, setLastAnalysisTime] = useState<string | null>(null)

  // Gio push-to-talk state
  const [isGioActive, setIsGioActive] = useState(false)
  const [gioTranscript, setGioTranscript] = useState('')
  const [clipboardContent, setClipboardContent] = useState<string | null>(null)
  const [gioError, setGioError] = useState<string | null>(null)

  // ─── refs ─────────────────────────────────────────────────────────────────

  // Lyria session
  const sessionRef = useRef<LiveMusicSession | null>(null)
  const lastAppliedConfigRef = useRef<LiveMusicGenerationConfig | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextPlaybackTimeRef = useRef(0)
  const isUnmountingRef = useRef(false)
  const pipWindowRef = useRef<Window | null>(null)

  // Master gain for Lyria volume fade
  const masterGainRef = useRef<GainNode | null>(null)
  const lyriaVolumeRef = useRef(1.0)

  // Screenshot capture
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const captureStreamRef = useRef<MediaStream | null>(null)
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Vision analysis
  const isAnalyzing = useRef(false)
  const analyzeAndUpdateRef = useRef<((dataUrl: string) => Promise<void>) | null>(null)
  const showDebugRef = useRef(false)

  // Gio session
  const gioSessionRef = useRef<Session | null>(null)
  const gioMicStreamRef = useRef<MediaStream | null>(null)
  const gioMicProcessorRef = useRef<{
    source: MediaStreamAudioSourceNode
    processor: ScriptProcessorNode
    context: AudioContext
  } | null>(null)
  const gioAudioContextRef = useRef<AudioContext | null>(null)
  const gioNextPlaybackTimeRef = useRef(0)
  const isGioActiveRef = useRef(false)
  const gioTranscriptRef = useRef('')
  const startGioSessionRef = useRef<(() => Promise<void>) | null>(null)
  const endGioSessionRef = useRef<(() => Promise<void>) | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wakeWordRecognitionRef = useRef<any>(null)
  const wakeWordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ─── helpers ──────────────────────────────────────────────────────────────

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
    if (bpmOverridden) config.bpm = bpm
    if (densityOverridden) config.density = density
    if (brightnessOverridden) config.brightness = brightness
    return config
  }

  const getApiKey = () => import.meta.env.VITE_GEMINI_API_KEY?.trim() ?? ''

  // ─── Lyria audio chain ────────────────────────────────────────────────────

  /** Ensure a GainNode is wired to the given AudioContext (recreated when ctx changes). */
  const ensureMasterGain = (ctx: AudioContext): GainNode => {
    if (masterGainRef.current && masterGainRef.current.context === ctx) {
      return masterGainRef.current
    }
    const gain = ctx.createGain()
    gain.gain.value = lyriaVolumeRef.current
    gain.connect(ctx.destination)
    masterGainRef.current = gain
    return gain
  }

  const ensureAudioContext = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE })
      ensureMasterGain(audioContextRef.current)
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
      masterGainRef.current = null
      resetPlaybackQueue()
    }

    audioContextRef.current = audioContext
    const masterGain = ensureMasterGain(audioContext)

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
    if (frameCount === 0) return

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
    source.connect(masterGain)

    const startAt = Math.max(audioContext.currentTime + 0.05, nextPlaybackTimeRef.current)
    source.start(startAt)
    nextPlaybackTimeRef.current = startAt + audioBuffer.duration
  }

  // ─── Lyria volume fade ────────────────────────────────────────────────────

  const fadeVolume = (targetVolume: number, durationMs: number) => {
    lyriaVolumeRef.current = targetVolume
    const gainNode = masterGainRef.current
    const ctx = audioContextRef.current
    if (!gainNode || !ctx || ctx.state === 'closed') return

    const now = ctx.currentTime
    gainNode.gain.cancelScheduledValues(now)
    gainNode.gain.setValueAtTime(gainNode.gain.value, now)
    gainNode.gain.linearRampToValueAtTime(targetVolume, now + durationMs / 1000)
  }

  // ─── Lyria prompt / config ────────────────────────────────────────────────

  const applyPrompt = async (nextPrompt: string) => {
    if (!sessionRef.current) {
      console.log('[Analysis] applyPrompt: session not active')
      return
    }
    console.log('[Analysis] Lyria prompt update:', nextPrompt)
    await sessionRef.current.setWeightedPrompts({
      weightedPrompts: [{ text: getEffectivePrompt(nextPrompt), weight: 1 }],
    })
  }

  const applyConfig = async (nextConfig = getConfigSummary()) => {
    if (!sessionRef.current) return
    await sessionRef.current.setMusicGenerationConfig({ musicGenerationConfig: nextConfig })
    const previousConfig = lastAppliedConfigRef.current
    const shouldResetContext =
      previousConfig !== null && previousConfig.bpm !== nextConfig.bpm
    lastAppliedConfigRef.current = nextConfig
    if (shouldResetContext) await sessionRef.current.resetContext()
  }

  // ─── Gemini vision analysis ───────────────────────────────────────────────

  // Redefined every render to close over fresh state; ref stays current.
  const analyzeAndUpdate = async (screenshotDataUrl: string) => {
    console.log('[Analysis] Starting cycle')
    if (isAnalyzing.current) {
      console.log('[Analysis] Skipping — in flight')
      return
    }
    isAnalyzing.current = true

    try {
      const apiKey = getApiKey()
      if (!apiKey) { console.log('[Analysis] No API key'); return }

      const base64Data = screenshotDataUrl.replace(/^data:image\/jpeg;base64,/, '')
      const client = new GoogleGenAI({ apiKey })
      const response = await client.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        config: { systemInstruction: ANALYSIS_SYSTEM_PROMPT },
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
            { text: `Current music: ${currentMusicPrompt}. What should the music be?` },
          ],
        }],
      })

      const rawResponse = (response.text ?? '').trim()
      const activityMatch = rawResponse.match(/^ACTIVITY:\s*(.+)$/m)
      const musicMatch = rawResponse.match(/^MUSIC:\s*(.+)$/m)
      const activityDescription = activityMatch ? activityMatch[1].trim() : rawResponse
      const musicDecision = musicMatch ? musicMatch[1].trim() : rawResponse

      setLastDetectedActivity(activityDescription)
      setLastAnalysisTime(new Date().toLocaleTimeString())

      if (!musicDecision || musicDecision.toUpperCase() === 'FALSE') {
        setLastGeminiDecision('FALSE')
      } else {
        console.log('[Analysis] Music →', musicDecision)
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

  analyzeAndUpdateRef.current = analyzeAndUpdate

  // ─── Gio audio output ─────────────────────────────────────────────────────

  const scheduleGioAudioChunk = async (base64Data: string, mimeType?: string) => {
    if (!base64Data) return

    const rateMatch = mimeType?.match(/rate=(\d+)/i)
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000

    if (!gioAudioContextRef.current || gioAudioContextRef.current.state === 'closed') {
      gioAudioContextRef.current = new AudioContext({ sampleRate })
      gioNextPlaybackTimeRef.current = gioAudioContextRef.current.currentTime + 0.1
    }

    const ctx = gioAudioContextRef.current
    if (ctx.state === 'suspended') await ctx.resume()

    const binary = atob(base64Data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
    const frameCount = samples.length
    if (frameCount === 0) return

    const audioBuffer = ctx.createBuffer(1, frameCount, sampleRate)
    const channelData = audioBuffer.getChannelData(0)
    for (let i = 0; i < frameCount; i++) channelData[i] = (samples[i] ?? 0) / 32768

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)

    const startAt = Math.max(ctx.currentTime + 0.1, gioNextPlaybackTimeRef.current)
    source.start(startAt)
    gioNextPlaybackTimeRef.current = startAt + audioBuffer.duration
  }

  // ─── Gio clipboard processing ─────────────────────────────────────────────

  const processGioTranscript = async (rawTranscript: string): Promise<string> => {
    const match = rawTranscript.match(/<<<CLIPBOARD_START>>>([\s\S]*?)<<<CLIPBOARD_END>>>/)
    if (!match) return rawTranscript

    const content = match[1].trim()
    setClipboardContent(content)

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(content)
        console.log('[Gio] Copied to clipboard, length:', content.length)
      } else {
        console.warn('[Gio] Clipboard API not available')
      }
    } catch (err) {
      console.warn('[Gio] Clipboard write failed:', err)
    }

    return rawTranscript
      .replace(/<<<CLIPBOARD_START>>>[\s\S]*?<<<CLIPBOARD_END>>>/, '')
      .trim()
  }

  // ─── Gio session lifecycle ────────────────────────────────────────────────

  const startGioSession = async () => {
    if (isGioActiveRef.current) return

    const apiKey = getApiKey()
    if (!apiKey) { setGioError('No API key configured'); return }

    // Reset per-session state
    gioTranscriptRef.current = ''
    setGioTranscript('')
    setGioError(null)
    gioNextPlaybackTimeRef.current = 0

    isGioActiveRef.current = true
    setIsGioActive(true)

    fadeVolume(0.2, 600)

    try {
      // Microphone
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      gioMicStreamRef.current = micStream

      // Gemini Live connection
      const client = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' })
      const session = await client.live.connect({
        model: GIO_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: GIO_SYSTEM_PROMPT,
        },
        callbacks: {
          onmessage: (msg) => {
            // Accumulate text
            if (msg.text) {
              setGioTranscript(prev => {
                const next = prev + msg.text!
                gioTranscriptRef.current = next
                return next
              })
            }
            // Play audio chunks
            const parts = msg.serverContent?.modelTurn?.parts ?? []
            for (const part of parts) {
              if (part.inlineData?.data) {
                void scheduleGioAudioChunk(part.inlineData.data, part.inlineData.mimeType)
              }
            }
          },
          onerror: (err: unknown) => {
            console.error('[Gio] Session error:', err)
            setGioError('Gio is unavailable')
            fadeVolume(1.0, 800)
            isGioActiveRef.current = false
            setIsGioActive(false)
          },
          onclose: (event?: CloseEvent) => {
            console.log('[Gio] Session closed', event?.code, event?.reason)
            gioSessionRef.current = null
            if (isGioActiveRef.current) {
              fadeVolume(1.0, 800)
              isGioActiveRef.current = false
              setIsGioActive(false)
              setGioError('Connection lost')
            }
          },
        },
      })

      gioSessionRef.current = session

      // Send latest screenshot as visual context
      if (latestScreenshot) {
        const base64Data = latestScreenshot.replace(/^data:image\/jpeg;base64,/, '')
        try {
          session.sendClientContent({
            turns: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
                { text: "This is what the user's screen currently looks like. Use this as context for their question." },
              ],
            }],
            turnComplete: false,
          })
        } catch (e) {
          console.warn('[Gio] Screenshot context send failed:', e)
        }
      }

      // Microphone audio streaming via ScriptProcessor
      const micContext = new AudioContext({ sampleRate: 16000 })
      const actualRate = micContext.sampleRate
      const micSource = micContext.createMediaStreamSource(micStream)
      const processor = micContext.createScriptProcessor(2048, 1, 1)

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!gioSessionRef.current || !isGioActiveRef.current) return
        const inputData = event.inputBuffer.getChannelData(0)
        const pcm16 = new Int16Array(inputData.length)
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]))
          pcm16[i] = s < 0 ? s * 32768 : s * 32767
        }
        const bytes = new Uint8Array(pcm16.buffer)
        let binary = ''
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
        try {
          gioSessionRef.current.sendRealtimeInput({
            audio: { data: btoa(binary), mimeType: `audio/pcm;rate=${actualRate}` },
          })
        } catch {
          // session may have closed between the guard check and this call — ignore
        }
      }

      micSource.connect(processor)
      processor.connect(micContext.destination)
      gioMicProcessorRef.current = { source: micSource, processor, context: micContext }

    } catch (err) {
      console.error('[Gio] Error starting session:', err)
      const isPermission =
        err instanceof Error &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      setGioError(isPermission ? 'Microphone access denied' : 'Gio is unavailable')
      fadeVolume(1.0, 800)
      isGioActiveRef.current = false
      setIsGioActive(false)
      if (gioMicStreamRef.current) {
        gioMicStreamRef.current.getTracks().forEach(t => t.stop())
        gioMicStreamRef.current = null
      }
    }
  }

  const endGioSession = async () => {
    if (!isGioActiveRef.current && !gioSessionRef.current && !gioMicStreamRef.current) return

    isGioActiveRef.current = false
    setIsGioActive(false)

    if (wakeWordTimeoutRef.current) {
      clearTimeout(wakeWordTimeoutRef.current)
      wakeWordTimeoutRef.current = null
    }

    // Stop microphone
    if (gioMicProcessorRef.current) {
      try {
        gioMicProcessorRef.current.processor.onaudioprocess = null
        gioMicProcessorRef.current.source.disconnect()
        gioMicProcessorRef.current.processor.disconnect()
        await gioMicProcessorRef.current.context.close()
      } catch { /* ignore */ }
      gioMicProcessorRef.current = null
    }
    if (gioMicStreamRef.current) {
      gioMicStreamRef.current.getTracks().forEach(t => t.stop())
      gioMicStreamRef.current = null
    }

    // Close Gemini Live session
    if (gioSessionRef.current) {
      try { gioSessionRef.current.close() } catch { /* ignore */ }
      gioSessionRef.current = null
    }

    fadeVolume(1.0, 800)

    // Clipboard detection on final transcript
    const rawTranscript = gioTranscriptRef.current
    if (rawTranscript) {
      const cleanTranscript = await processGioTranscript(rawTranscript)
      if (cleanTranscript !== rawTranscript) {
        gioTranscriptRef.current = cleanTranscript
        setGioTranscript(cleanTranscript)
      }
    }
  }

  // Keep refs current each render
  startGioSessionRef.current = startGioSession
  endGioSessionRef.current = endGioSession

  // ─── Screen capture ───────────────────────────────────────────────────────

  const stopCapture = () => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current)
      captureIntervalRef.current = null
    }
    if (captureStreamRef.current) {
      captureStreamRef.current.getTracks().forEach(t => t.stop())
      captureStreamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
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

      stream.getTracks().forEach(track => { track.onended = () => stopCapture() })

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
        setCaptureStatus(`Capturing every 6s — last captured at ${timeStr}`)
        console.log('[Screenshot] Captured at ' + timeStr + ', length: ' + dataUrl.length)
        void analyzeAndUpdateRef.current?.(dataUrl)
      }, 6000)

      setCaptureOn(true)
      setCaptureStatus('Capturing every 6s — waiting for first capture...')
    } catch {
      setCaptureOn(false)
      setCaptureStatus('Screen share was denied or cancelled')
    }
  }

  const toggleCapture = async () => {
    if (captureOn) stopCapture()
    else await startCapture()
  }

  // ─── Lyria stream management ──────────────────────────────────────────────

  const stopStream = async (nextStatus: Exclude<StreamStatus, 'connecting'> | null = 'idle') => {
    const currentSession = sessionRef.current
    sessionRef.current = null
    lastAppliedConfigRef.current = null

    if (currentSession?.close) await currentSession.close()

    nextPlaybackTimeRef.current = 0

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close()
    }
    audioContextRef.current = null
    masterGainRef.current = null

    closeDocumentPiP()

    if (!isUnmountingRef.current && nextStatus) setStatus(nextStatus)
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

      const client = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' })

      const session = await client.live.music.connect({
        model: MODEL,
        callbacks: {
          onmessage: (message: LiveMusicServerMessage) => {
            const audioChunks = message.serverContent?.audioChunks ?? []
            for (const chunk of audioChunks) {
              if (chunk.data) void schedulePcm16Chunk(chunk.data, chunk.mimeType)
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
              setStatus(currentStatus =>
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
      if (!sessionRef.current) { await startStream(); return }
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
    if (!sessionRef.current) return
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
    if (!sessionRef.current) return

    try {
      await sessionRef.current.setWeightedPrompts({
        weightedPrompts: [{ text: nextVocalsEnabled ? `${prompt}, Vocals` : prompt, weight: 1 }],
      })
      const nextConfig: LiveMusicGenerationConfig = {
        ...getConfigSummary(),
        musicGenerationMode: nextVocalsEnabled
          ? MusicGenerationMode.VOCALIZATION
          : MusicGenerationMode.QUALITY,
      }
      await sessionRef.current.setMusicGenerationConfig({ musicGenerationConfig: nextConfig })
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
    if (!sessionRef.current) return
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
    if (!sessionRef.current) return
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

  // ─── PiP ──────────────────────────────────────────────────────────────────

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
      :root { color-scheme: dark; font-family: "Segoe UI", sans-serif; }
      body {
        margin: 0; min-height: 100vh; padding: 12px; box-sizing: border-box;
        background: radial-gradient(circle at top, rgba(249,115,22,0.24), transparent 36%),
                    linear-gradient(180deg, #08131f 0%, #101d2f 100%);
        color: #f8fafc;
      }
      .pip-shell {
        min-height: calc(100vh - 24px); display: grid; gap: 10px; align-content: start;
        border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; padding: 14px;
        background: rgba(7,12,20,0.82); backdrop-filter: blur(18px);
      }
      .pip-title-bar { display: flex; align-items: center; gap: 10px; }
      .pip-title { margin: 0; font-size: 1.1rem; line-height: 1; flex: 1; }
      .pip-status {
        display: inline-flex; align-items: center; justify-content: center;
        height: 28px; border-radius: 999px; padding: 0 10px;
        font-size: 0.72rem; font-weight: 700; text-transform: capitalize;
        background: rgba(148,163,184,0.16); color: #cbd5e1; white-space: nowrap;
      }
      .pip-status.streaming { background: rgba(34,197,94,0.2); color: #86efac; }
      .pip-status.connecting { background: rgba(251,191,36,0.18); color: #fde68a; }
      .pip-status.error { background: rgba(248,113,113,0.18); color: #fca5a5; }
      .pip-now-playing {
        padding: 8px 10px; border: 1px solid rgba(249,115,22,0.22);
        border-radius: 12px; background: rgba(249,115,22,0.07);
      }
      .pip-now-playing-label {
        margin: 0 0 3px; font-size: 0.6rem; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase; color: #f7b267;
      }
      .pip-now-playing-value {
        margin: 0; font-size: 0.82rem; color: #f8fafc; line-height: 1.4; word-break: break-word;
      }
      /* Gio */
      .pip-gio-section { display: grid; gap: 7px; }
      .pip-gio-indicator {
        display: flex; align-items: center; gap: 8px;
        font-size: 0.78rem; font-weight: 700; color: #c4b5fd;
      }
      .pip-gio-pulse {
        width: 9px; height: 9px; border-radius: 50%; background: #a78bfa; flex-shrink: 0;
        animation: pipGioPulse 1.2s ease-in-out infinite;
      }
      @keyframes pipGioPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(1.5); }
      }
      .pip-gio-transcript {
        max-height: 120px; overflow-y: auto; padding: 8px 10px;
        border: 1px solid rgba(167,139,250,0.2); border-radius: 10px;
        background: rgba(139,92,246,0.07); font-size: 0.77rem;
        line-height: 1.5; color: rgba(226,232,240,0.88); word-break: break-word;
      }
      .pip-gio-clipboard {
        padding: 9px 11px; border: 1px solid rgba(52,211,153,0.25);
        border-radius: 10px; background: rgba(52,211,153,0.06); display: grid; gap: 6px;
      }
      .pip-gio-clipboard-header { display: flex; align-items: center; justify-content: space-between; }
      .pip-gio-clipboard-label {
        font-size: 0.65rem; font-weight: 700; letter-spacing: 0.07em;
        text-transform: uppercase; color: #6ee7b7;
      }
      .pip-gio-clipboard-dismiss {
        background: none; border: none !important; color: rgba(226,232,240,0.4);
        font-size: 0.8rem; padding: 0 4px; cursor: pointer; border-radius: 4px;
      }
      .pip-gio-clipboard-preview {
        font-family: ui-monospace, Consolas, monospace; font-size: 0.68rem;
        color: rgba(226,232,240,0.62); margin: 0; line-height: 1.5;
        white-space: pre-wrap; word-break: break-word;
      }
      .pip-gio-clipboard-copy {
        background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.22) !important;
        color: #6ee7b7; font-size: 0.72rem; padding: 6px 10px;
        border-radius: 8px; cursor: pointer; font-weight: 700;
      }
      .pip-gio-error { margin: 0; font-size: 0.74rem; color: #fca5a5; }
      .pip-gio-btn {
        width: 100%; padding: 11px 12px; border-radius: 14px;
        border: 1.5px solid rgba(139,92,246,0.35) !important;
        background: rgba(139,92,246,0.13); color: #c4b5fd;
        font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer; user-select: none;
      }
      .pip-gio-btn.active {
        background: rgba(139,92,246,0.28);
        border-color: rgba(167,139,250,0.6) !important;
        color: #ede9fe; animation: pipGioBtn 1.5s ease-in-out infinite;
      }
      @keyframes pipGioBtn {
        0%, 100% { box-shadow: 0 0 0 0 rgba(139,92,246,0.25); }
        50% { box-shadow: 0 0 0 5px rgba(139,92,246,0); }
      }
      /* Debug drawer */
      .pip-debug-toggle {
        width: 100%; background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.09) !important;
        border-radius: 10px; padding: 6px 10px; font-size: 0.68rem; font-weight: 700;
        letter-spacing: 0.07em; text-transform: uppercase;
        color: rgba(226,232,240,0.45); cursor: pointer; text-align: left;
      }
      .pip-debug-toggle:hover { background: rgba(255,255,255,0.07); color: rgba(226,232,240,0.65); }
      .pip-debug-drawer { display: none; }
      .pip-debug-drawer.open { display: grid; gap: 5px; }
      .pip-debug-row {
        padding: 7px 9px; border: 1px solid rgba(255,255,255,0.06);
        border-radius: 10px; background: rgba(0,0,0,0.28);
      }
      .pip-debug-label {
        margin: 0 0 2px; font-size: 0.58rem; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase; color: rgba(247,178,103,0.65);
      }
      .pip-debug-value {
        margin: 0; font-family: ui-monospace, Consolas, monospace;
        font-size: 0.7rem; color: rgba(226,232,240,0.65); line-height: 1.4; word-break: break-word;
      }
      .pip-debug-value-false { color: rgba(148,163,184,0.5); }
      .pip-debug-value-change { color: #86efac; font-weight: 700; }
      .pip-debug-thumbnail {
        max-height: 70px; width: auto; max-width: 100%; object-fit: contain;
        border-radius: 6px; display: block; border: 1px solid rgba(255,255,255,0.08);
      }
      /* Actions */
      .pip-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      button {
        border: 0; border-radius: 14px; padding: 11px 12px;
        font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer;
      }
      .pip-primary { background: linear-gradient(135deg,#f97316 0%,#fb7185 100%); color: #fff7ed; }
      .pip-secondary {
        background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #e2e8f0;
      }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
    `

    const esc = (s: string) => s.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const isPlayable = status === 'paused' || status === 'stopped' || status === 'idle'
    const playPauseLabel = status === 'streaming' ? 'Pause' : 'Play'
    const vocalsLabel = vocalsEnabled ? 'Vocals on' : 'Vocals off'

    // Debug rows
    const thumbnailHtml = latestScreenshot
      ? `<img class="pip-debug-thumbnail" src="${latestScreenshot}" alt="Last capture" />`
      : `<p class="pip-debug-value">No capture yet</p>`
    const activityHtml = lastDetectedActivity
      ? `<p class="pip-debug-value">${esc(lastDetectedActivity)}</p>`
      : `<p class="pip-debug-value">Waiting for first analysis...</p>`
    let decisionHtml: string
    if (lastGeminiDecision === null) {
      decisionHtml = `<p class="pip-debug-value">Waiting...</p>`
    } else if (lastGeminiDecision === 'FALSE') {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-false">No change (FALSE)</p>`
    } else {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-change">Changed to: ${esc(lastGeminiDecision)}</p>`
    }

    // Gio section HTML
    const gioIndicatorHtml = isGioActive
      ? `<div class="pip-gio-indicator"><div class="pip-gio-pulse"></div><span>Gio is listening...</span></div>`
      : gioTranscript
        ? `<div class="pip-gio-indicator"><span>✓ Gio responded</span></div>`
        : ''

    const gioTranscriptHtml = gioTranscript
      ? `<div class="pip-gio-transcript">${esc(gioTranscript)}</div>`
      : ''

    let gioClipboardHtml = ''
    if (clipboardContent) {
      const lines = clipboardContent.split('\n')
      const preview = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n...' : '')
      gioClipboardHtml = `
        <div class="pip-gio-clipboard">
          <div class="pip-gio-clipboard-header">
            <span class="pip-gio-clipboard-label">✓ Copied to clipboard</span>
            <button class="pip-gio-clipboard-dismiss" type="button">×</button>
          </div>
          <p class="pip-gio-clipboard-preview">${esc(preview)}</p>
          <button class="pip-gio-clipboard-copy" type="button">Copy again</button>
        </div>`
    }
    const gioErrorHtml = gioError
      ? `<p class="pip-gio-error">${esc(gioError)}</p>`
      : ''
    const debugOpen = showDebugRef.current

    const shell = pipWindow.document.createElement('main')
    shell.className = 'pip-shell'
    shell.innerHTML = `
      <div class="pip-title-bar">
        <h1 class="pip-title">Gio controls</h1>
        <span class="pip-status ${status}">${status}</span>
      </div>
      <div class="pip-now-playing">
        <p class="pip-now-playing-label">Now playing</p>
        <p class="pip-now-playing-value">${esc(currentMusicPrompt)}</p>
      </div>
      <div class="pip-gio-section">
        ${gioIndicatorHtml}
        ${gioTranscriptHtml}
        ${gioClipboardHtml}
        ${gioErrorHtml}
        <button class="pip-gio-btn${isGioActive ? ' active' : ''}" type="button">
          ${isGioActive ? '🎙 Listening...' : 'Hold to talk to Gio'}
        </button>
      </div>
      <button class="pip-debug-toggle" type="button">Debug ${debugOpen ? '▲' : '▼'}</button>
      <div class="pip-debug-drawer${debugOpen ? ' open' : ''}">
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

    // Event listeners
    shell.querySelector<HTMLButtonElement>('.pip-debug-toggle')?.addEventListener('click', () => {
      showDebugRef.current = !showDebugRef.current
      updatePiPContents()
    })

    const gioBtn = shell.querySelector<HTMLButtonElement>('.pip-gio-btn')
    if (gioBtn) {
      gioBtn.addEventListener('mousedown', () => void startGioSessionRef.current?.())
      gioBtn.addEventListener('mouseup', () => void endGioSessionRef.current?.())
      gioBtn.addEventListener('touchstart', (e) => { e.preventDefault(); void startGioSessionRef.current?.() })
      gioBtn.addEventListener('touchend', (e) => { e.preventDefault(); void endGioSessionRef.current?.() })
    }

    shell.querySelector<HTMLButtonElement>('.pip-gio-clipboard-copy')?.addEventListener('click', () => {
      if (clipboardContent) {
        navigator.clipboard.writeText(clipboardContent).catch(err =>
          console.warn('[Gio] Re-copy failed:', err),
        )
      }
    })

    shell.querySelector<HTMLButtonElement>('.pip-gio-clipboard-dismiss')?.addEventListener('click', () => {
      setClipboardContent(null)
    })

    shell.querySelector<HTMLButtonElement>('.pip-primary')?.addEventListener('click', () => {
      if (status === 'streaming') { void pauseStream(); return }
      if (isPlayable) void playStream()
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
        height: 580,
        preferInitialWindowPlacement: true,
      })
      pipWindowRef.current = pipWindow
      setPipMessage('')
      pipWindow.addEventListener('pagehide', () => { pipWindowRef.current = null })
      updatePiPContents()
    } catch (pipError) {
      const message =
        pipError instanceof Error
          ? pipError.message
          : 'The browser blocked the Picture-in-Picture window.'
      setPipMessage(message)
    }
  }

  // ─── effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true
      closeDocumentPiP()
      stopCapture()
      void stopStream(null)
      // Gio cleanup
      if (gioSessionRef.current) {
        try { gioSessionRef.current.close() } catch { /* ignore */ }
      }
      if (gioMicStreamRef.current) {
        gioMicStreamRef.current.getTracks().forEach(t => t.stop())
      }
      if (gioMicProcessorRef.current) {
        try {
          gioMicProcessorRef.current.processor.onaudioprocess = null
          gioMicProcessorRef.current.source.disconnect()
          gioMicProcessorRef.current.processor.disconnect()
          void gioMicProcessorRef.current.context.close()
        } catch { /* ignore */ }
      }
      if (gioAudioContextRef.current && gioAudioContextRef.current.state !== 'closed') {
        void gioAudioContextRef.current.close()
      }
      if (wakeWordRecognitionRef.current) {
        try { wakeWordRecognitionRef.current.stop() } catch { /* ignore */ }
      }
      if (wakeWordTimeoutRef.current) clearTimeout(wakeWordTimeoutRef.current)
    }
  }, [])

  // Sync PiP whenever state changes
  useEffect(() => {
    updatePiPContents()
  }, [
    brightness, bpm, density, error, onlyBassAndDrums, status, vocalsEnabled,
    currentMusicPrompt, latestScreenshot, lastDetectedActivity, lastGeminiDecision, lastAnalysisTime,
    isGioActive, gioTranscript, clipboardContent, gioError,
  ])

  // Auto-open PiP when tab hides during streaming
  useEffect(() => {
    if (!isDocumentPiPSupported) return

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden' || status !== 'streaming') return
      void openDocumentPiP()
    }
    const handlePageHide = () => {
      if (status !== 'streaming') return
      void openDocumentPiP()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [isDocumentPiPSupported, status])

  // Wake word listener — "Hey Gio"
  useEffect(() => {
    const SpeechRecognitionAPI =
      window.SpeechRecognition ?? window.webkitSpeechRecognition

    if (!SpeechRecognitionAPI) {
      console.warn('[Gio] Web Speech API not available — wake word disabled')
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition: any = new SpeechRecognitionAPI()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript.toLowerCase()
        if (text.includes('hey gio') && !isGioActiveRef.current) {
          console.log('[Gio] Wake word detected')
          void startGioSessionRef.current?.()
          wakeWordTimeoutRef.current = setTimeout(() => {
            void endGioSessionRef.current?.()
          }, 15000)
        }
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error !== 'no-speech') {
        console.warn('[Gio] Speech recognition error:', event.error)
      }
    }

    // Keep listening by restarting on end; back off 1 s on network errors to avoid spam
    let wakeRestartTimer: ReturnType<typeof setTimeout> | null = null
    recognition.onend = () => {
      if (!isUnmountingRef.current) {
        wakeRestartTimer = setTimeout(() => {
          try { recognition.start() } catch { /* ignore race condition */ }
        }, 1000)
      }
    }

    try {
      recognition.start()
      wakeWordRecognitionRef.current = recognition
    } catch (err) {
      console.warn('[Gio] Could not start speech recognition:', err)
    }

    return () => {
      if (wakeRestartTimer) clearTimeout(wakeRestartTimer)
      recognition.onend = null
      try { recognition.stop() } catch { /* ignore */ }
    }
  }, [])

  // ─── JSX ──────────────────────────────────────────────────────────────────

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

        {/* Gio push-to-talk */}
        <div className="gio-row">
          <button
            className={`gio-button${isGioActive ? ' gio-button-active' : ''}`}
            onMouseDown={() => void startGioSession()}
            onMouseUp={() => void endGioSession()}
            onTouchStart={(e) => { e.preventDefault(); void startGioSession() }}
            onTouchEnd={(e) => { e.preventDefault(); void endGioSession() }}
          >
            {isGioActive ? '🎙 Listening...' : 'Hold to talk to Gio'}
          </button>
          {gioError ? <p className="gio-error">{gioError}</p> : null}
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
            <label className="field-label" htmlFor="prompt">Weighted prompt</label>
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

          <label className="field-label" htmlFor="bpm">BPM</label>
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

          <label className="field-label" htmlFor="density">Density</label>
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
            {densityOverridden ? `${density.toFixed(2)} density override` : 'Model will infer density'}
          </p>

          <label className="field-label" htmlFor="brightness">Brightness</label>
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
            {brightnessOverridden ? `${brightness.toFixed(2)} brightness override` : 'Model will infer brightness'}
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

          <button
            className="secondary-button full-width"
            disabled={!sessionRef.current}
            onClick={() => void syncConfig()}
          >
            Apply settings
          </button>
        </section>
      </section>

      <section className="powered-by-section">
        <p className="eyebrow">Stack</p>
        <h2 className="powered-by-heading">Powered by</h2>
        <div className="powered-by-grid">
          <div className="powered-by-card">
            <p className="powered-by-model">gemini-3.1-pro-preview</p>
            <p className="powered-by-desc">Vision analysis and music direction</p>
            <div className="powered-by-badges">
              <span className="powered-by-badge badge-ai">Vision</span>
              <span className="powered-by-badge badge-ai">Reasoning</span>
            </div>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">gemini-3.1-flash-live-preview</p>
            <p className="powered-by-desc">Push-to-talk voice assistant (Gio)</p>
            <div className="powered-by-badges">
              <span className="powered-by-badge badge-ai">Live Audio</span>
              <span className="powered-by-badge badge-ai">Voice</span>
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
            <p className="powered-by-model">getDisplayMedia</p>
            <p className="powered-by-desc">Screen capture for activity analysis</p>
            <span className="powered-by-badge badge-browser">Browser API</span>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">getUserMedia</p>
            <p className="powered-by-desc">Microphone capture for Gio</p>
            <span className="powered-by-badge badge-browser">Browser API</span>
          </div>
          <div className="powered-by-card">
            <p className="powered-by-model">Web Speech API</p>
            <p className="powered-by-desc">"Hey Gio" wake word detection</p>
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

      {/* Hidden elements for screen capture */}
      <video ref={videoRef} style={{ display: 'none' }} muted playsInline />
      <canvas ref={canvasRef} width={1280} height={720} style={{ display: 'none' }} />
    </main>
  )
}

export default App
