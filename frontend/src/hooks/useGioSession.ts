/* eslint-disable @typescript-eslint/no-explicit-any, no-empty */
import { useState, useRef, useCallback, useEffect } from 'react'
import { GoogleGenAI, Modality, Type, type Session } from '@google/genai'
import { GIO_MODEL, GIO_SYSTEM_PROMPT } from '../constants'

export function useGioSession({
  getApiKey,
  fadeVolume,
  latestScreenshot,
}: {
  getApiKey: () => string
  fadeVolume: (targetVolume: number, durationMs: number) => void
  latestScreenshot: string | null
}) {
  const [isGioActive, setIsGioActive] = useState(false)
  const [gioTranscript, setGioTranscript] = useState('')
  const [clipboardContent, setClipboardContent] = useState<string | null>(null)
  const [gioError, setGioError] = useState<string | null>(null)

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
  const pendingClipboardWriteRef = useRef<string | null>(null)
  const wakeWordRecognitionRef = useRef<any>(null)
  const wakeWordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUnmountingRef = useRef(false)
  const latestScreenshotRef = useRef(latestScreenshot)

  useEffect(() => {
    latestScreenshotRef.current = latestScreenshot
  }, [latestScreenshot])

  // Single helper for all clipboard write attempts.
  // Tries the Clipboard API first, falls back to execCommand.
  // Clears pendingClipboardWriteRef on success so retries don't duplicate.
  const writeToClipboard = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      pendingClipboardWriteRef.current = null
      console.log('[Gio] Clipboard written, length:', content.length)
      return
    } catch { /* fall through to execCommand */ }
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
      console.log('[Gio] Clipboard written via execCommand, length:', content.length)
    } catch { /* both paths failed — content stays in pendingClipboardWriteRef for retry */ }
  }

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
    // Always attempt clipboard write first — this runs with a user gesture
    // when the user taps stop, which is the most reliable write opportunity.
    if (pendingClipboardWriteRef.current) {
      await writeToClipboard(pendingClipboardWriteRef.current)
    }

    if (!isGioActiveRef.current && !gioSessionRef.current && !gioMicStreamRef.current) return

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
      } catch { /* ignore */ }
      gioMicProcessorRef.current = null
    }
    if (gioMicStreamRef.current) {
      gioMicStreamRef.current.getTracks().forEach((t) => t.stop())
      gioMicStreamRef.current = null
    }

    if (gioSessionRef.current) {
      try { gioSessionRef.current.close() } catch { /* ignore */ }
      gioSessionRef.current = null
    }

    fadeVolume(1.0, 800)
  }, [fadeVolume])

  const startGioSession = useCallback(async () => {
    if (isGioActiveRef.current) return

    const apiKey = getApiKey()
    if (!apiKey) {
      setGioError('No API key configured')
      return
    }

    // Attempt to flush any pending clipboard write from the previous session
    // before clearing it — starting a new session is a user gesture.
    if (pendingClipboardWriteRef.current) {
      void writeToClipboard(pendingClipboardWriteRef.current)
    }

    gioTranscriptRef.current = ''
    pendingClipboardWriteRef.current = null
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

      const client = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' })
      const session = await client.live.connect({
        model: GIO_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: GIO_SYSTEM_PROMPT,
          tools: [{
            functionDeclarations: [{
              name: 'saveToClipboard',
              description: 'Saves drafted or generated text content directly to the user\'s clipboard. Call this whenever you have composed a complete piece of content the user asked you to write.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  content: {
                    type: Type.STRING,
                    description: 'The complete text content to copy to the clipboard, ready to paste.',
                  },
                },
                required: ['content'],
              },
            }],
          }],
        },
        callbacks: {
          onmessage: (msg) => {
            const textChunks: string[] = []
            if (msg.text) textChunks.push(msg.text)
            const transcription = (msg as any).serverContent?.outputTranscription?.text
            if (transcription) textChunks.push(transcription)
            const parts = msg.serverContent?.modelTurn?.parts ?? []
            for (const part of parts) {
              if ((part as any).text) textChunks.push((part as any).text)
              if (part.inlineData?.data) {
                void scheduleGioAudioChunk(part.inlineData.data, part.inlineData.mimeType)
              }
            }
            if (textChunks.length > 0) {
              const next = gioTranscriptRef.current + textChunks.join('')
              gioTranscriptRef.current = next
              setGioTranscript(next)
            }

            const calls = (msg as any).toolCall?.functionCalls ?? []
            for (const call of calls) {
              if (call.name === 'saveToClipboard') {
                const content: string = call.args?.content ?? ''
                if (content) {
                  setClipboardContent(content)
                  pendingClipboardWriteRef.current = content
                  // Try immediately — works if the page has focus (tab is active).
                  // If it fails, pendingClipboardWriteRef stays set for retry via
                  // onclose, endGioSession, or the window focus listener.
                  void writeToClipboard(content)
                }
                try {
                  gioSessionRef.current?.sendToolResponse({
                    functionResponses: [{
                      id: call.id,
                      name: call.name,
                      response: { output: { success: true } },
                    }],
                  })
                } catch (e) {
                  console.warn('[Gio] Tool response send failed:', e)
                }
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
            }
            // Session closed (naturally or otherwise) — try to flush any pending clipboard write.
            if (pendingClipboardWriteRef.current) {
              void writeToClipboard(pendingClipboardWriteRef.current)
            }
          },
        },
      })

      gioSessionRef.current = session

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
        } catch { }
      }

      micSource.connect(processor)
      processor.connect(micContext.destination)
      gioMicProcessorRef.current = { source: micSource, processor, context: micContext }

    } catch (err) {
      console.error('[Gio] Error starting session:', err)
      const isPermission = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      setGioError(isPermission ? 'Microphone access denied' : 'Gio is unavailable')
      fadeVolume(1.0, 800)
      isGioActiveRef.current = false
      setIsGioActive(false)
      if (gioMicStreamRef.current) {
        gioMicStreamRef.current.getTracks().forEach((t) => t.stop())
        gioMicStreamRef.current = null
      }
    }
  }, [fadeVolume, getApiKey])

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
          console.log('[Gio] Wake word detected')
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
          try { recognition.start() } catch { }
        }, 1000)
      }
    }

    try {
      recognition.start()
      wakeWordRecognitionRef.current = recognition
    } catch (err) { }

    return () => {
      if (wakeRestartTimer) clearTimeout(wakeRestartTimer)
      recognition.onend = null
      try { recognition.stop() } catch { }
    }
  }, [])

  // Retry clipboard write whenever the main page regains focus.
  // This is the key fallback for when the user is working in the PiP
  // and the main page wasn't focused when saveToClipboard fired.
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
