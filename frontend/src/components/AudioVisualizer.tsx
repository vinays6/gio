import { useRef, useEffect } from 'react'
import type { StreamStatus } from '../constants'

interface AudioVisualizerProps {
  analyserRef: React.RefObject<AnalyserNode | null>
  status: StreamStatus
}

export function AudioVisualizer({ analyserRef, status }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const BAR_COUNT = 32
    let rafId: number

    const render = (time: number) => {
      const W = canvas.offsetWidth
      const H = canvas.offsetHeight
      canvas.width = W
      canvas.height = H
      ctx.clearRect(0, 0, W, H)

      const barWidth = W / BAR_COUNT - 2
      const analyser = analyserRef.current
      const isPlaying = status === 'streaming'

      let heights: number[]

      if (analyser && isPlaying) {
        const data = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(data)
        heights = Array.from({ length: BAR_COUNT }, (_, i) => {
          const raw = data[Math.floor(i * data.length / BAR_COUNT)] ?? 0
          return 8 + (raw / 255) * 72
        })
      } else {
        heights = Array.from({ length: BAR_COUNT }, (_, i) => {
          return 8 + (Math.sin(time * 0.0015 + i * 0.45) * 0.5 + 0.5) * 28
        })
      }

      for (let i = 0; i < BAR_COUNT; i++) {
        const x = i * (barWidth + 2)
        const h = heights[i]
        const t = i / (BAR_COUNT - 1)

        // Interpolate: green → yellow → red
        let r, g, b
        if (t < 0.5) {
          const p = t * 2
          r = Math.round(52 + (251 - 52) * p)
          g = Math.round(168 + (188 - 168) * p)
          b = Math.round(83 + (5 - 83) * p)
        } else {
          const p = (t - 0.5) * 2
          r = Math.round(251 + (234 - 251) * p)
          g = Math.round(188 + (67 - 188) * p)
          b = Math.round(5 + (53 - 5) * p)
        }

        ctx.fillStyle = `rgba(${r},${g},${b},0.8)`
        ctx.beginPath()
        ;(ctx as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, H - h, barWidth, h, 3)
        ctx.fill()
      }

      rafId = requestAnimationFrame(render)
    }

    rafId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafId)
  }, [analyserRef, status])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        bottom: 0, left: 0,
        width: '100%', height: '100px',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  )
}
