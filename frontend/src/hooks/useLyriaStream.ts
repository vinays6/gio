import { useRef, useState, useCallback, useEffect } from 'react'
import {
  GoogleGenAI,
  MusicGenerationMode,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai'
import {
  MODEL,
  SAMPLE_RATE,
  CHANNELS,
  DEFAULT_BPM,
  DEFAULT_DENSITY,
  DEFAULT_BRIGHTNESS,
  DEFAULT_PROMPT,
  type StreamStatus
} from '../constants'

export function useLyriaStream(getApiKey: () => string) {
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

  const sessionRef = useRef<LiveMusicSession | null>(null)
  const lastAppliedConfigRef = useRef<LiveMusicGenerationConfig | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextPlaybackTimeRef = useRef(0)
  const masterGainRef = useRef<GainNode | null>(null)
  const lyriaVolumeRef = useRef(1.0)
  const isUnmountingRef = useRef(false)

  const getConfigSummary = useCallback((): LiveMusicGenerationConfig => {
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
  }, [bpm, bpmOverridden, brightness, brightnessOverridden, density, densityOverridden, onlyBassAndDrums, vocalsEnabled])

  const getEffectivePrompt = useCallback((basePrompt: string) =>
    vocalsEnabled ? `${basePrompt}, Vocals` : basePrompt, [vocalsEnabled])

  const applyPrompt = useCallback(async (nextPrompt: string) => {
    if (!sessionRef.current) return
    console.log('[Analysis] Lyria prompt update:', nextPrompt)
    await sessionRef.current.setWeightedPrompts({
      weightedPrompts: [{ text: getEffectivePrompt(nextPrompt), weight: 1 }],
    })
  }, [getEffectivePrompt])

  const applyConfig = useCallback(async (nextConfig = getConfigSummary()) => {
    if (!sessionRef.current) return
    await sessionRef.current.setMusicGenerationConfig({ musicGenerationConfig: nextConfig })
    const previousConfig = lastAppliedConfigRef.current
    const shouldResetContext = previousConfig !== null && previousConfig.bpm !== nextConfig.bpm
    lastAppliedConfigRef.current = nextConfig
    if (shouldResetContext) await sessionRef.current.resetContext()
  }, [getConfigSummary])

  const ensureMasterGain = useCallback((ctx: AudioContext): GainNode => {
    if (masterGainRef.current && masterGainRef.current.context === ctx) {
      return masterGainRef.current
    }
    const gain = ctx.createGain()
    gain.gain.value = lyriaVolumeRef.current
    gain.connect(ctx.destination)
    masterGainRef.current = gain
    return gain
  }, [])

  const ensureAudioContext = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE })
      ensureMasterGain(audioContextRef.current)
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }
    return audioContextRef.current
  }, [ensureMasterGain])

  const fadeVolume = useCallback((targetVolume: number, durationMs: number) => {
    lyriaVolumeRef.current = targetVolume
    const gainNode = masterGainRef.current
    const ctx = audioContextRef.current
    if (!gainNode || !ctx || ctx.state === 'closed') return

    const now = ctx.currentTime
    gainNode.gain.cancelScheduledValues(now)
    gainNode.gain.setValueAtTime(gainNode.gain.value, now)
    gainNode.gain.linearRampToValueAtTime(targetVolume, now + durationMs / 1000)
  }, [])

  const resetPlaybackQueue = useCallback(() => {
    const audioContext = audioContextRef.current
    nextPlaybackTimeRef.current = audioContext ? audioContext.currentTime + 0.05 : 0
  }, [])

  const getSampleRateFromMimeType = (mimeType?: string) => {
    const sampleRateMatch = mimeType?.match(/rate=(\d+)/i)
    return sampleRateMatch ? Number(sampleRateMatch[1]) : SAMPLE_RATE
  }

  const schedulePcm16Chunk = useCallback(async (base64Data: string, mimeType?: string) => {
    const chunkSampleRate = getSampleRateFromMimeType(mimeType)
    const audioContext = audioContextRef.current && audioContextRef.current.sampleRate === chunkSampleRate
      ? await ensureAudioContext()
      : new AudioContext({ sampleRate: chunkSampleRate })

    if (audioContextRef.current && audioContextRef.current !== audioContext && audioContextRef.current.state !== 'closed') {
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
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)

    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
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
  }, [ensureAudioContext, ensureMasterGain, resetPlaybackQueue])

  const stopStream = useCallback(async (nextStatus: Exclude<StreamStatus, 'connecting'> | null = 'idle') => {
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

    if (!isUnmountingRef.current && nextStatus) setStatus(nextStatus)
  }, [])

  const startStream = useCallback(async () => {
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
            const nextError = sessionError instanceof Error ? sessionError.message : 'The music stream failed unexpectedly.'
            setError(nextError)
            setStatus('error')
          },
          onclose: () => {
            if (!isUnmountingRef.current) {
              setStatus(currentStatus => currentStatus === 'error' ? currentStatus : 'stopped')
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
      const nextError = streamError instanceof Error ? streamError.message : 'Unable to connect to the Lyria realtime model.'
      setError(nextError)
      setStatus('error')
      await stopStream(null)
    }
  }, [applyConfig, applyPrompt, ensureAudioContext, getApiKey, prompt, resetPlaybackQueue, schedulePcm16Chunk, stopStream])

  const playStream = useCallback(async () => {
    try {
      setError('')
      if (!sessionRef.current) { await startStream(); return }
      await ensureAudioContext()
      sessionRef.current.play()
      setStatus('streaming')
    } catch (playError) {
      const nextError = playError instanceof Error ? playError.message : 'Unable to resume playback.'
      setError(nextError)
      setStatus('error')
    }
  }, [ensureAudioContext, startStream])

  const pauseStream = useCallback(async () => {
    if (!sessionRef.current) return
    try {
      sessionRef.current.pause()
      if (audioContextRef.current?.state === 'running') {
        await audioContextRef.current.suspend()
      }
      setStatus('paused')
    } catch (pauseError) {
      const nextError = pauseError instanceof Error ? pauseError.message : 'Unable to pause playback.'
      setError(nextError)
      setStatus('error')
    }
  }, [])

  const toggleVocals = useCallback(async () => {
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
      const nextError = vocalsError instanceof Error ? vocalsError.message : 'Unable to update vocals.'
      setError(nextError)
      setStatus('error')
    }
  }, [getConfigSummary, prompt, vocalsEnabled])

  const syncPrompt = useCallback(async () => {
    if (!sessionRef.current) return
    try {
      setError('')
      await applyPrompt(prompt)
    } catch (promptError) {
      const nextError = promptError instanceof Error ? promptError.message : 'Unable to update the prompt.'
      setError(nextError)
      setStatus('error')
    }
  }, [applyPrompt, prompt])

  const syncConfig = useCallback(async () => {
    if (!sessionRef.current) return
    try {
      setError('')
      await applyConfig()
    } catch (configError) {
      const nextError = configError instanceof Error ? configError.message : 'Unable to update the generation settings.'
      setError(nextError)
      setStatus('error')
    }
  }, [applyConfig])

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true
      void stopStream(null)
    }
  }, [stopStream])

  return {
    prompt, setPrompt,
    bpm, setBpm,
    density, setDensity,
    brightness, setBrightness,
    bpmOverridden, setBpmOverridden,
    densityOverridden, setDensityOverridden,
    brightnessOverridden, setBrightnessOverridden,
    vocalsEnabled, setVocalsEnabled,
    onlyBassAndDrums, setOnlyBassAndDrums,
    status, error,
    playStream, pauseStream, toggleVocals, syncPrompt, syncConfig, stopStream, applyPrompt, fadeVolume
  }
}
