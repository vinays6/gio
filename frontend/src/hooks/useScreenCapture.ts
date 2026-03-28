import { useState, useRef, useCallback, useEffect } from 'react'
import { GoogleGenAI } from '@google/genai'
import { ANALYSIS_SYSTEM_PROMPT } from '../constants'
import CaptureWorker from '../workers/captureWorker?worker'

const supportsOffscreenCanvas = typeof OffscreenCanvas !== 'undefined'

export function useScreenCapture({
  getApiKey,
  applyPrompt,
  userPreferences,
}: {
  getApiKey: () => string
  applyPrompt: (prompt: string) => Promise<void>
  userPreferences?: string | null
}) {
  const [captureOn, setCaptureOn] = useState(false)
  const [latestScreenshot, setLatestScreenshot] = useState<string | null>(null)
  const [captureStatus, setCaptureStatus] = useState('Not capturing')

  const [currentMusicPrompt, setCurrentMusicPrompt] = useState('ambient')
  const [lastDetectedActivity, setLastDetectedActivity] = useState<string | null>(null)
  const [lastGeminiDecision, setLastGeminiDecision] = useState<string | null>(null)
  const [lastAnalysisTime, setLastAnalysisTime] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const captureStreamRef = useRef<MediaStream | null>(null)
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const workerRef = useRef<Worker | null>(null)

  const isAnalyzing = useRef(false)
  const analyzeAndUpdateRef = useRef<((dataUrl: string) => Promise<void>) | null>(null)
  const userPreferencesRef = useRef(userPreferences)
  const currentMusicPromptRef = useRef(currentMusicPrompt)

  useEffect(() => { userPreferencesRef.current = userPreferences }, [userPreferences])
  useEffect(() => { currentMusicPromptRef.current = currentMusicPrompt }, [currentMusicPrompt])

  // Initialize worker once (only on browsers that support OffscreenCanvas)
  useEffect(() => {
    if (!supportsOffscreenCanvas) return
    const worker = new CaptureWorker()
    workerRef.current = worker
    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const analyzeAndUpdate = useCallback(async (screenshotDataUrl: string) => {
    console.log('[Analysis] Starting cycle')
    if (isAnalyzing.current) {
      console.log('[Analysis] Skipping — in flight')
      return
    }
    isAnalyzing.current = true

    try {
      const apiKey = getApiKey()
      if (!apiKey) {
        console.log('[Analysis] No API key')
        return
      }

      const base64Data = screenshotDataUrl.replace(/^data:image\/jpeg;base64,/, '')
      const client = new GoogleGenAI({ apiKey })

      const systemInstruction = userPreferencesRef.current
        ? `${ANALYSIS_SYSTEM_PROMPT}\n\nUSER MUSIC PREFERENCES:\nThe user has the following music preferences: "${userPreferencesRef.current}". You MUST factor these preferences into your decision when recommending a new music descriptor.`
        : ANALYSIS_SYSTEM_PROMPT

      const response = await client.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        config: { systemInstruction },
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
              { text: `Current music: ${currentMusicPromptRef.current}. What should the music be?` },
            ],
          },
        ],
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
  }, [applyPrompt, getApiKey])

  // Keep ref up to date to avoid stale closures in interval
  useEffect(() => {
    analyzeAndUpdateRef.current = analyzeAndUpdate
  }, [analyzeAndUpdate])

  const stopCapture = useCallback(() => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current)
      captureIntervalRef.current = null
    }
    if (captureStreamRef.current) {
      captureStreamRef.current.getTracks().forEach((t) => t.stop())
      captureStreamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setLatestScreenshot(null)
    setCaptureStatus('Not capturing')
    setCaptureOn(false)
  }, [])

  const captureFrame = useCallback((video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string> => {
    // Off-thread path: use Web Worker + OffscreenCanvas (doesn't block main thread)
    if (supportsOffscreenCanvas && workerRef.current) {
      return new Promise((resolve, reject) => {
        createImageBitmap(video, { resizeWidth: 1280, resizeHeight: 720, resizeQuality: 'medium' })
          .then((bitmap) => {
            const worker = workerRef.current!
            const handler = (e: MessageEvent<{ dataUrl?: string; error?: string }>) => {
              worker.removeEventListener('message', handler)
              if (e.data.error) reject(new Error(e.data.error))
              else resolve(e.data.dataUrl!)
            }
            worker.addEventListener('message', handler)
            worker.postMessage({ bitmap, width: 1280, height: 720 }, [bitmap])
          })
          .catch(reject)
      })
    }

    // Fallback: synchronous main-thread encoding (Safari, older browsers)
    const ctx = canvas.getContext('2d')
    if (!ctx) return Promise.reject(new Error('No canvas context'))
    ctx.drawImage(video, 0, 0, 1280, 720)
    return Promise.resolve(canvas.toDataURL('image/jpeg', 0.7))
  }, [])

  const startCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
      captureStreamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      stream.getTracks().forEach((track) => {
        track.onended = () => stopCapture()
      })

      captureIntervalRef.current = setInterval(async () => {
        const video = videoRef.current
        const canvas = canvasRef.current
        if (!video || !canvas) return

        try {
          const dataUrl = await captureFrame(video, canvas)
          setLatestScreenshot(dataUrl)
          const timeStr = new Date().toLocaleTimeString()
          setCaptureStatus(`Capturing every 6s — last captured at ${timeStr}`)
          console.log('[Screenshot] Captured at ' + timeStr + ', length: ' + dataUrl.length)
          void analyzeAndUpdateRef.current?.(dataUrl)
        } catch (err) {
          console.error('[Screenshot] Capture failed:', err)
        }
      }, 6000)

      setCaptureOn(true)
      setCaptureStatus('Capturing every 6s — waiting for first capture...')
    } catch {
      setCaptureOn(false)
      setCaptureStatus('Screen share was denied or cancelled')
    }
  }, [stopCapture, captureFrame])

  const toggleCapture = useCallback(async () => {
    if (captureOn) stopCapture()
    else await startCapture()
  }, [captureOn, startCapture, stopCapture])

  useEffect(() => {
    return () => {
      stopCapture()
    }
  }, [stopCapture])

  return {
    captureOn,
    latestScreenshot,
    captureStatus,
    currentMusicPrompt,
    lastDetectedActivity,
    lastGeminiDecision,
    lastAnalysisTime,
    toggleCapture,
    videoRef,
    canvasRef,
  }
}
