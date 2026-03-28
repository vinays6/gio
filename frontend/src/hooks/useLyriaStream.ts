import { useRef, useState, useCallback, useEffect } from 'react'
import {
  CHANNELS,
  DEFAULT_BPM,
  DEFAULT_BRIGHTNESS,
  DEFAULT_DENSITY,
  DEFAULT_PROMPT,
  SAMPLE_RATE,
  type StreamStatus
} from '../constants'
import { getWebSocketUrl } from '../lib/realtime'

type MusicGenerationMode = 'QUALITY' | 'VOCALIZATION'

type MusicGenerationConfig = {
  bpm?: number
  density?: number
  brightness?: number
  onlyBassAndDrums: boolean
  musicGenerationMode: MusicGenerationMode
}

type AssistantMusicGenerationPatch = {
  prompt?: string
  bpm?: number
  use_inferred_bpm?: boolean
  density?: number
  use_inferred_density?: boolean
  brightness?: number
  use_inferred_brightness?: boolean
  vocals_enabled?: boolean
  only_bass_and_drums?: boolean
}

export function useLyriaStream() {
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

  const socketRef = useRef<WebSocket | null>(null)
  const lastAppliedConfigRef = useRef<MusicGenerationConfig | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextPlaybackTimeRef = useRef(0)
  const masterGainRef = useRef<GainNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const lyriaVolumeRef = useRef(1.0)
  const isUnmountingRef = useRef(false)
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const getConfigSummary = useCallback((): MusicGenerationConfig => {
    const config: MusicGenerationConfig = {
      onlyBassAndDrums,
      musicGenerationMode: vocalsEnabled ? 'VOCALIZATION' : 'QUALITY',
    }
    if (bpmOverridden) config.bpm = bpm
    if (densityOverridden) config.density = density
    if (brightnessOverridden) config.brightness = brightness
    return config
  }, [bpm, bpmOverridden, brightness, brightnessOverridden, density, densityOverridden, onlyBassAndDrums, vocalsEnabled])

  const getEffectivePrompt = useCallback((basePrompt: string) =>
    vocalsEnabled ? `${basePrompt}, Vocals` : basePrompt, [vocalsEnabled])

  const ensureSocketOpen = useCallback(() => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('The music stream is not connected.')
    }
    return socket
  }, [])

  const sendSocketMessage = useCallback((payload: Record<string, unknown>) => {
    const socket = ensureSocketOpen()
    socket.send(JSON.stringify(payload))
  }, [ensureSocketOpen])

  const applyPrompt = useCallback(async (nextPrompt: string) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return
    sendSocketMessage({
      type: 'set_weighted_prompts',
      weightedPrompts: [{ text: getEffectivePrompt(nextPrompt), weight: 1 }],
    })
  }, [getEffectivePrompt, sendSocketMessage])

  const applyConfig = useCallback(async (nextConfig = getConfigSummary()) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return
    sendSocketMessage({
      type: 'set_music_generation_config',
      musicGenerationConfig: nextConfig,
    })
    const previousConfig = lastAppliedConfigRef.current
    const shouldResetContext = previousConfig !== null && previousConfig.bpm !== nextConfig.bpm
    lastAppliedConfigRef.current = nextConfig
    if (shouldResetContext) sendSocketMessage({ type: 'reset_context' })
  }, [getConfigSummary, sendSocketMessage])

  const ensureMasterGain = useCallback((ctx: AudioContext): GainNode => {
    if (masterGainRef.current && masterGainRef.current.context === ctx) {
      return masterGainRef.current
    }
    const gain = ctx.createGain()
    gain.gain.value = lyriaVolumeRef.current
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 64
    analyserRef.current = analyser
    gain.connect(analyser)
    analyser.connect(ctx.destination)
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
      analyserRef.current = null
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
    const currentSocket = socketRef.current
    socketRef.current = null
    lastAppliedConfigRef.current = null
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current)
      connectTimeoutRef.current = null
    }

    if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
      currentSocket.send(JSON.stringify({ type: 'close' }))
    }
    currentSocket?.close()

    nextPlaybackTimeRef.current = 0

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close()
    }
    audioContextRef.current = null
    masterGainRef.current = null
    analyserRef.current = null

    if (!isUnmountingRef.current && nextStatus) setStatus(nextStatus)
  }, [])

  const startStream = useCallback(async () => {
    setError('')
    setStatus('connecting')
    resetPlaybackQueue()

    try {
      await stopStream(null)
      await ensureAudioContext()
      resetPlaybackQueue()

      const socketUrl = getWebSocketUrl('/api/lyria')
      console.info('[Lyria] Connecting to', socketUrl)
      const socket = new WebSocket(socketUrl)
      socketRef.current = socket
      connectTimeoutRef.current = setTimeout(() => {
        if (socketRef.current === socket && socket.readyState === WebSocket.CONNECTING) {
          console.error('[Lyria] Connection timed out before websocket open')
          setError('Timed out connecting to backend music stream.')
          setStatus('error')
          socket.close()
        }
      }, 8000)

      socket.onopen = () => {
        console.info('[Lyria] WebSocket open')
      }

      socket.onmessage = (event) => {
        console.debug('[Lyria] Raw message', event.data)
        const message = JSON.parse(String(event.data)) as {
          type?: string
          data?: string
          mimeType?: string
          message?: string
        }
        console.debug('[Lyria] Message', message.type)

        if (message.type === 'socket_opened') {
          return
        }

        if (message.type === 'ready') {
          if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current)
            connectTimeoutRef.current = null
          }
          void (async () => {
            try {
              if (socketRef.current !== socket) return
              socket.send(JSON.stringify({
                type: 'set_weighted_prompts',
                weightedPrompts: [{ text: getEffectivePrompt(prompt), weight: 1 }],
              }))
              const nextConfig = getConfigSummary()
              socket.send(JSON.stringify({
                type: 'set_music_generation_config',
                musicGenerationConfig: nextConfig,
              }))
              lastAppliedConfigRef.current = nextConfig
              socket.send(JSON.stringify({ type: 'play' }))
              setStatus('streaming')
            } catch (streamError) {
              const nextError = streamError instanceof Error ? streamError.message : 'Unable to initialize the music stream.'
              setError(nextError)
              setStatus('error')
            }
          })()
          return
        }

        if (message.type === 'audio' && message.data) {
          void schedulePcm16Chunk(message.data, message.mimeType)
          return
        }

        if (message.type === 'error') {
          setError(message.message ?? 'The music stream failed unexpectedly.')
          setStatus('error')
        }
      }

      socket.onerror = (event) => {
        console.error('[Lyria] WebSocket error', event)
        setError('Unable to reach the backend music stream.')
        setStatus('error')
      }

      socket.onclose = (event) => {
        console.warn('[Lyria] WebSocket closed', event.code, event.reason)
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current)
          connectTimeoutRef.current = null
        }
        if (!isUnmountingRef.current && socketRef.current === socket) {
          socketRef.current = null
          setStatus(currentStatus => currentStatus === 'error' ? currentStatus : 'stopped')
        }
      }
    } catch (streamError) {
      const nextError = streamError instanceof Error ? streamError.message : 'Unable to connect to the backend music stream.'
      setError(nextError)
      setStatus('error')
      await stopStream(null)
    }
  }, [ensureAudioContext, getConfigSummary, getEffectivePrompt, prompt, resetPlaybackQueue, schedulePcm16Chunk, stopStream])

  const playStream = useCallback(async () => {
    try {
      setError('')
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        await startStream()
        return
      }
      await ensureAudioContext()
      sendSocketMessage({ type: 'play' })
      setStatus('streaming')
    } catch (playError) {
      const nextError = playError instanceof Error ? playError.message : 'Unable to resume playback.'
      setError(nextError)
      setStatus('error')
    }
  }, [ensureAudioContext, sendSocketMessage, startStream])

  const pauseStream = useCallback(async () => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return
    try {
      sendSocketMessage({ type: 'pause' })
      if (audioContextRef.current?.state === 'running') {
        await audioContextRef.current.suspend()
      }
      setStatus('paused')
    } catch (pauseError) {
      const nextError = pauseError instanceof Error ? pauseError.message : 'Unable to pause playback.'
      setError(nextError)
      setStatus('error')
    }
  }, [sendSocketMessage])

  const toggleVocals = useCallback(async () => {
    const nextVocalsEnabled = !vocalsEnabled
    setVocalsEnabled(nextVocalsEnabled)
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return

    try {
      const effectivePrompt = nextVocalsEnabled ? `${prompt}, Vocals` : prompt
      sendSocketMessage({
        type: 'set_weighted_prompts',
        weightedPrompts: [{ text: effectivePrompt, weight: 1 }],
      })
      const nextConfig: MusicGenerationConfig = {
        ...getConfigSummary(),
        musicGenerationMode: nextVocalsEnabled ? 'VOCALIZATION' : 'QUALITY',
      }
      sendSocketMessage({
        type: 'set_music_generation_config',
        musicGenerationConfig: nextConfig,
      })
      lastAppliedConfigRef.current = nextConfig
    } catch (vocalsError) {
      setVocalsEnabled(!nextVocalsEnabled)
      const nextError = vocalsError instanceof Error ? vocalsError.message : 'Unable to update vocals.'
      setError(nextError)
      setStatus('error')
    }
  }, [getConfigSummary, prompt, sendSocketMessage, vocalsEnabled])

  const syncPrompt = useCallback(async () => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return
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
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return
    try {
      setError('')
      await applyConfig()
    } catch (configError) {
      const nextError = configError instanceof Error ? configError.message : 'Unable to update the generation settings.'
      setError(nextError)
      setStatus('error')
    }
  }, [applyConfig])

  const applyAssistantUpdate = useCallback(async (patch: AssistantMusicGenerationPatch) => {
    const nextPrompt = typeof patch.prompt === 'string' ? patch.prompt.trim() || prompt : prompt
    const nextVocalsEnabled = typeof patch.vocals_enabled === 'boolean' ? patch.vocals_enabled : vocalsEnabled
    const nextOnlyBassAndDrums = typeof patch.only_bass_and_drums === 'boolean'
      ? patch.only_bass_and_drums
      : onlyBassAndDrums

    const nextBpm = typeof patch.bpm === 'number' ? patch.bpm : bpm
    const nextDensity = typeof patch.density === 'number' ? patch.density : density
    const nextBrightness = typeof patch.brightness === 'number' ? patch.brightness : brightness

    const nextBpmOverridden = patch.use_inferred_bpm === true ? false : typeof patch.bpm === 'number' ? true : bpmOverridden
    const nextDensityOverridden = patch.use_inferred_density === true ? false : typeof patch.density === 'number' ? true : densityOverridden
    const nextBrightnessOverridden = patch.use_inferred_brightness === true ? false : typeof patch.brightness === 'number' ? true : brightnessOverridden

    setPrompt(nextPrompt)
    setVocalsEnabled(nextVocalsEnabled)
    setOnlyBassAndDrums(nextOnlyBassAndDrums)
    setBpm(nextBpm)
    setDensity(nextDensity)
    setBrightness(nextBrightness)
    setBpmOverridden(nextBpmOverridden)
    setDensityOverridden(nextDensityOverridden)
    setBrightnessOverridden(nextBrightnessOverridden)

    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return

    const effectivePrompt = nextVocalsEnabled ? `${nextPrompt}, Vocals` : nextPrompt
    sendSocketMessage({
      type: 'set_weighted_prompts',
      weightedPrompts: [{ text: effectivePrompt, weight: 1 }],
    })

    const nextConfig: MusicGenerationConfig = {
      onlyBassAndDrums: nextOnlyBassAndDrums,
      musicGenerationMode: nextVocalsEnabled ? 'VOCALIZATION' : 'QUALITY',
    }
    if (nextBpmOverridden) nextConfig.bpm = nextBpm
    if (nextDensityOverridden) nextConfig.density = nextDensity
    if (nextBrightnessOverridden) nextConfig.brightness = nextBrightness

    sendSocketMessage({
      type: 'set_music_generation_config',
      musicGenerationConfig: nextConfig,
    })
    const previousConfig = lastAppliedConfigRef.current
    const shouldResetContext = previousConfig !== null && previousConfig.bpm !== nextConfig.bpm
    lastAppliedConfigRef.current = nextConfig
    if (shouldResetContext) sendSocketMessage({ type: 'reset_context' })
  }, [
    bpm,
    bpmOverridden,
    brightness,
    brightnessOverridden,
    density,
    densityOverridden,
    onlyBassAndDrums,
    prompt,
    sendSocketMessage,
    vocalsEnabled,
  ])

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
    playStream, pauseStream, toggleVocals, syncPrompt, syncConfig, stopStream, applyPrompt, fadeVolume,
    applyAssistantUpdate,
    analyserRef,
  }
}
