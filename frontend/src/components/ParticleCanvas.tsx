import { useRef, useEffect } from 'react'

export function ParticleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const COUNT = 30
    interface Particle { x: number; y: number; speed: number; opacity: number; size: number }

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()

    const particles: Particle[] = Array.from({ length: COUNT }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      speed: 0.25 + Math.random() * 0.45,
      opacity: 0.1 + Math.random() * 0.15,
      size: 1.5 + Math.random() * 1,
    }))

    let rafId: number
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const rgb = isDark ? '255,255,255' : '51,51,51'
      for (const p of particles) {
        p.y -= p.speed
        if (p.y < -5) {
          p.y = canvas.height + 5
          p.x = Math.random() * canvas.width
        }
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${rgb},${p.opacity})`
        ctx.fill()
      }
      rafId = requestAnimationFrame(render)
    }

    rafId = requestAnimationFrame(render)
    const onResize = () => resize()
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0, left: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  )
}
