/* eslint-disable @typescript-eslint/no-explicit-any, no-empty */
import { useState, useRef, useCallback, useEffect } from 'react'
import { getWebSocketUrl } from '../lib/realtime'

export function useGioSession({
  fadeVolume,
  onPreferencesUpdated,
  onMusicGenerationUpdated,
}: {
  fadeVolume: (targetVolume: number, durationMs: number) => void
  onPreferencesUpdated?: (preferences: string) => void
  onMusicGenerationUpdated?: (patch: Record<string, unknown>) => void
}) {
  const [isGioActive, setIsGioActive] = useState(false)
  const [gioTranscript, setGioTranscript] = useState('')
  const [clipboardContent, setClipboardContent] = useState<string | null>(null)
  const [gioError, setGioError] = useState<string | null>(null)

  const gioSocketRef = useRef<WebSocket | null>(null)
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
  const pendingClipboardWriteRef = useRef<string | null>(null)
  const wakeWordRecognitionRef = useRef<any>(null)
  const wakeWordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUnmountingRef = useRef(false)
  const sentAudioChunkCountRef = useRef(0)

  const appendTranscript = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const next = gioTranscriptRef.current
      ? `${gioTranscriptRef.current} ${trimmed}`
      : trimmed
    gioTranscriptRef.current = next
    setGioTranscript(next)
  }, [])

  const writeToClipboard = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      pendingClipboardWriteRef.current = null
      return
    } catch {}
    try {
      const ta = document.createElement('textarea')
      ta.value = content
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      pendingClipboardWriteRef.current = null
    } catch {}
  }

  const sendSocketMessage = useCallback((payload: Record<string, unknown>) => {
    const socket = gioSocketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }, [])

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

  const endGioSession = useCallback(async () => {
    if (pendingClipboardWriteRef.current) {
      await writeToClipboard(pendingClipboardWriteRef.current)
    }

    if (!isGioActiveRef.current && !gioSocketRef.current && !gioMicStreamRef.current) return

    isGioActiveRef.current = false
    setIsGioActive(false)

    if (wakeWordTimeoutRef.current) {
      clearTimeout(wakeWordTimeoutRef.current)
      wakeWordTimeoutRef.current = null
    }

    if (gioMicProcessorRef.current) {
      try {
        gioMicProcessorRef.current.processor.onaudioprocess = null
        gioMicProcessorRef.current.source.disconnect()
        gioMicProcessorRef.current.processor.disconnect()
        await gioMicProcessorRef.current.context.close()
      } catch {}
      gioMicProcessorRef.current = null
    }

    if (gioMicStreamRef.current) {
      gioMicStreamRef.current.getTracks().forEach((track) => track.stop())
      gioMicStreamRef.current = null
    }

    if (gioSocketRef.current) {
      try {
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current)
          connectTimeoutRef.current = null
        }
        if (gioSocketRef.current.readyState === WebSocket.OPEN) {
          gioSocketRef.current.send(JSON.stringify({ type: 'close' }))
        }
        gioSocketRef.current.close()
      } catch {}
      gioSocketRef.current = null
    }

    fadeVolume(1.0, 800)
  }, [fadeVolume])

  const startGioSession = useCallback(async () => {
    if (isGioActiveRef.current) return

    if (pendingClipboardWriteRef.current) {
      void writeToClipboard(pendingClipboardWriteRef.current)
    }

    gioTranscriptRef.current = ''
    pendingClipboardWriteRef.current = null
    sentAudioChunkCountRef.current = 0
    setGioTranscript('')
    setGioError(null)
    setClipboardContent(null)
    gioNextPlaybackTimeRef.current = 0

    isGioActiveRef.current = true
    setIsGioActive(true)
    fadeVolume(0.2, 600)

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      gioMicStreamRef.current = micStream

      const socketUrl = getWebSocketUrl('/api/live')
      console.info('[Gio] Connecting to', socketUrl)
      const socket = new WebSocket(socketUrl)
      gioSocketRef.current = socket
      connectTimeoutRef.current = setTimeout(() => {
        if (gioSocketRef.current === socket && socket.readyState === WebSocket.CONNECTING) {
          console.error('[Gio] Connection timed out before websocket open')
          setGioError('Timed out connecting to Gio')
          fadeVolume(1.0, 800)
          isGioActiveRef.current = false
          setIsGioActive(false)
          socket.close()
        }
      }, 8000)

      socket.onopen = () => {
        console.info('[Gio] WebSocket open')
      }

      socket.onmessage = (event) => {
        console.debug('[Gio] Raw message', event.data)
        const message = JSON.parse(String(event.data)) as {
          type?: string
          id?: string
          name?: string
          ok?: boolean
          preferences?: string
          patch?: Record<string, unknown>
          args?: { content?: string }
          data?: string
          mimeType?: string
          text?: string
          message?: string
        }

        if (message.type === 'ready') {
          if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current)
            connectTimeoutRef.current = null
          }
          const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
          if (browserTimeZone) {
            sendSocketMessage({
              type: 'client_context',
              timeZone: browserTimeZone,
            })
          }
          return
        }

        if (message.type === 'input_transcript' && message.text) {
          console.info('[Gio] Heard:', message.text)
          return
        }

        if (message.type === 'output_transcript' && message.text) {
          console.info('[Gio] Said:', message.text)
          appendTranscript(message.text)
          return
        }

        if (message.type === 'audio' && message.data) {
          void scheduleGioAudioChunk(message.data, message.mimeType)
          return
        }

        if (message.type === 'transcript' && message.text) {
          appendTranscript(message.text)
          return
        }

        if (message.type === 'tool_result_debug') {
          const debugMessage = message.message ?? 'Tool completed'
          if (message.name) {
            if (message.ok === false) {
              console.error(`[Gio][Tool:${message.name}]`, debugMessage)
            } else {
              console.info(`[Gio][Tool:${message.name}]`, debugMessage)
            }
          }
          return
        }

        if (message.type === 'preferences_updated' && message.preferences) {
          console.info('[Gio] Preferences updated:', message.preferences)
          onPreferencesUpdated?.(message.preferences)
          return
        }

        if (message.type === 'music_generation_updated' && message.patch) {
          console.info('[Gio] Music generation updated:', message.patch)
          onMusicGenerationUpdated?.(message.patch)
          return
        }

        if (message.type === 'tool_call' && message.name === 'saveToClipboard') {
          const content = message.args?.content ?? ''
          if (content) {
            setClipboardContent(content)
            pendingClipboardWriteRef.current = content
            void writeToClipboard(content)
          }

          sendSocketMessage({
            type: 'tool_result',
            id: message.id,
            response: { output: { success: true } },
          })
          return
        }

        if (message.type === 'error') {
          setGioError(message.message ?? 'Gio is unavailable')
          fadeVolume(1.0, 800)
          isGioActiveRef.current = false
          setIsGioActive(false)
        }
      }

      socket.onerror = (event) => {
        console.error('[Gio] WebSocket error', event)
        setGioError('Gio is unavailable')
      }

      socket.onclose = (event) => {
        console.warn('[Gio] WebSocket closed', event.code, event.reason)
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current)
          connectTimeoutRef.current = null
        }
        gioSocketRef.current = null
        if (isGioActiveRef.current) {
          fadeVolume(1.0, 800)
          isGioActiveRef.current = false
          setIsGioActive(false)
        }
        if (pendingClipboardWriteRef.current) {
          void writeToClipboard(pendingClipboardWriteRef.current)
        }
      }

      const micContext = new AudioContext({ sampleRate: 16000 })
      if (micContext.state === 'suspended') {
        await micContext.resume()
      }
      const actualRate = micContext.sampleRate
      const micSource = micContext.createMediaStreamSource(micStream)
      const processor = micContext.createScriptProcessor(2048, 1, 1)

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const activeSocket = gioSocketRef.current
        if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN || !isGioActiveRef.current) return

        const inputData = event.inputBuffer.getChannelData(0)
        const pcm16 = new Int16Array(inputData.length)
        for (let i = 0; i < inputData.length; i++) {
          const sample = Math.max(-1, Math.min(1, inputData[i]))
          pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767
        }
        const bytes = new Uint8Array(pcm16.buffer)
        let binary = ''
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
        activeSocket.send(JSON.stringify({
          type: 'audio',
          data: btoa(binary),
          mimeType: `audio/pcm;rate=${actualRate}`,
        }))
        sentAudioChunkCountRef.current += 1
        if (sentAudioChunkCountRef.current <= 3) {
          console.info('[Gio] Sent mic audio chunk', sentAudioChunkCountRef.current, `rate=${actualRate}`, `samples=${inputData.length}`)
        }
      }

      micSource.connect(processor)
      processor.connect(micContext.destination)
      gioMicProcessorRef.current = { source: micSource, processor, context: micContext }
    } catch (err) {
      const isPermission = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      setGioError(isPermission ? 'Microphone access denied' : 'Gio is unavailable')
      fadeVolume(1.0, 800)
      isGioActiveRef.current = false
      setIsGioActive(false)
      if (gioMicStreamRef.current) {
        gioMicStreamRef.current.getTracks().forEach((track) => track.stop())
        gioMicStreamRef.current = null
      }
    }
  }, [appendTranscript, fadeVolume, onMusicGenerationUpdated, onPreferencesUpdated, sendSocketMessage])

  const startGioSessionRef = useRef(startGioSession)
  const endGioSessionRef = useRef(endGioSession)
  useEffect(() => {
    startGioSessionRef.current = startGioSession
    endGioSessionRef.current = endGioSession
  }, [startGioSession, endGioSession])

  useEffect(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SpeechRecognitionAPI) return

    const recognition: any = new SpeechRecognitionAPI()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript.toLowerCase()
        if (text.includes('hey gio') && !isGioActiveRef.current) {
          void startGioSessionRef.current()
          wakeWordTimeoutRef.current = setTimeout(() => {
            void endGioSessionRef.current()
          }, 15000)
        }
      }
    }

    recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech') {
        console.warn('[Gio] Speech recognition error:', event.error)
      }
    }

    let wakeRestartTimer: ReturnType<typeof setTimeout> | null = null
    recognition.onend = () => {
      if (!isUnmountingRef.current) {
        wakeRestartTimer = setTimeout(() => {
          try { recognition.start() } catch {}
        }, 1000)
      }
    }

    try {
      recognition.start()
      wakeWordRecognitionRef.current = recognition
    } catch {}

    return () => {
      if (wakeRestartTimer) clearTimeout(wakeRestartTimer)
      recognition.onend = null
      try { recognition.stop() } catch {}
    }
  }, [])

  useEffect(() => {
    const onFocus = () => {
      if (pendingClipboardWriteRef.current) {
        void writeToClipboard(pendingClipboardWriteRef.current)
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true
      void endGioSession()
    }
  }, [endGioSession])

  return {
    isGioActive,
    gioTranscript,
    clipboardContent,
    gioError,
    startGioSession,
    endGioSession,
    setClipboardContent,
    pendingClipboardWriteRef
  }
}
