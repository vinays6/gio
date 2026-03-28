import { useRef, useLayoutEffect, useState, useEffect } from 'react'

interface MarqueeTextProps {
  text: string
  className?: string
}

export function MarqueeText({ text, className = '' }: MarqueeTextProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [offset, setOffset] = useState('0px')

  useLayoutEffect(() => {
    const container = containerRef.current
    const inner = innerRef.current
    if (!container || !inner) return

    const check = () => {
      const containerWidth = container.offsetWidth
      const innerWidth = inner.scrollWidth
      if (innerWidth > containerWidth) {
        setOverflows(true)
        setOffset(`-${innerWidth - containerWidth + 24}px`)
      } else {
        setOverflows(false)
      }
    }

    check()
    const ro = new ResizeObserver(check)
    ro.observe(container)
    return () => ro.disconnect()
  }, [text])

  // Recalculate on text change
  useEffect(() => {
    const container = containerRef.current
    const inner = innerRef.current
    if (!container || !inner) return
    const containerWidth = container.offsetWidth
    const innerWidth = inner.scrollWidth
    if (innerWidth > containerWidth) {
      setOverflows(true)
      setOffset(`-${innerWidth - containerWidth + 24}px`)
    } else {
      setOverflows(false)
    }
  }, [text])

  const duration = overflows ? `${Math.max(5, text.length * 0.12)}s` : '0s'

  return (
    <div ref={containerRef} className={`marquee-container ${className}`}>
      <span
        ref={innerRef}
        className={`marquee-inner${overflows ? ' scrolling' : ''}`}
        style={{
          ['--marquee-offset' as string]: offset,
          ['--marquee-duration' as string]: duration,
        } as React.CSSProperties}
      >
        {text}
      </span>
    </div>
  )
}
