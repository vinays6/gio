import { useState } from 'react'
import type { StreamStatus } from '../constants'
import { MarqueeText } from './MarqueeText'
import { AudioVisualizer } from './AudioVisualizer'
import { ParticleCanvas } from './ParticleCanvas'
import { esc } from '../constants'

// Mic SVG icon
function MicIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  )
}

// Play/Pause SVG
function PlayIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5,3 19,12 5,21"/>
    </svg>
  )
}
function PauseIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
    </svg>
  )
}
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
      <polyline points={open ? "18,15 12,9 6,15" : "6,9 12,15 18,9"}/>
    </svg>
  )
}

interface LandingPageProps {
  // Lyria
  status: StreamStatus
  playStream: () => void
  pauseStream: () => void
  error: string
  analyserRef: React.RefObject<AnalyserNode | null>
  vocalsEnabled: boolean
  toggleVocals: () => void
  onlyBassAndDrums: boolean
  setOnlyBassAndDrums: (v: boolean) => void
  prompt: string
  setPrompt: (v: string) => void
  bpm: number; setBpm: (v: number) => void
  density: number; setDensity: (v: number) => void
  brightness: number; setBrightness: (v: number) => void
  bpmOverridden: boolean; setBpmOverridden: (v: boolean) => void
  densityOverridden: boolean; setDensityOverridden: (v: boolean) => void
  brightnessOverridden: boolean; setBrightnessOverridden: (v: boolean) => void
  syncPrompt: () => void
  syncConfig: () => void
  // Capture
  captureOn: boolean
  captureStatus: string
  toggleCapture: () => void
  currentMusicPrompt: string
  lastDetectedActivity: string | null
  latestScreenshot: string | null
  lastGeminiDecision: string | null
  lastAnalysisTime: string | null
  // Gio
  isGioActive: boolean
  startGioSession: () => void
  endGioSession: () => void
  gioTranscript: string
  clipboardContent: string | null
  gioError: string | null
  setClipboardContent: (c: string | null) => void
  pendingClipboardWriteRef: React.MutableRefObject<string | null>
  // PiP
  isDocumentPiPSupported: boolean
  openDocumentPiP: () => void
  pipMessage: string
}

const MODELS = [
  { name: 'gemini-3.1-pro-preview', desc: 'Vision analysis and music direction', category: 'google' as const },
  { name: 'gemini-3.1-flash-live-preview', desc: 'Push-to-talk voice assistant (Gio)', category: 'google' as const },
  { name: 'lyria-realtime-exp', desc: 'Realtime adaptive music generation', category: 'google' as const },
  { name: 'getDisplayMedia', desc: 'Screen capture for activity analysis', category: 'browser' as const },
  { name: 'getUserMedia', desc: 'Microphone capture for Gio', category: 'browser' as const },
  { name: 'Web Speech API', desc: '"Hey Gio" wake word detection', category: 'browser' as const },
  { name: 'Picture-in-Picture', desc: 'Floating player while you work', category: 'browser' as const },
  { name: 'Web Audio API', desc: 'PCM16 audio scheduling', category: 'browser' as const },
  { name: 'Canvas API', desc: 'Frame extraction from video stream', category: 'browser' as const },
  { name: 'WebSocket API', desc: 'Realtime connection to Lyria', category: 'browser' as const },
]

export function LandingPage({
  status, playStream, pauseStream, error, analyserRef,
  vocalsEnabled, toggleVocals, onlyBassAndDrums, setOnlyBassAndDrums,
  prompt, setPrompt, bpm, setBpm, density, setDensity, brightness, setBrightness,
  bpmOverridden, setBpmOverridden, densityOverridden, setDensityOverridden,
  brightnessOverridden, setBrightnessOverridden, syncPrompt, syncConfig,
  captureOn, captureStatus, toggleCapture, currentMusicPrompt,
  lastDetectedActivity, latestScreenshot, lastGeminiDecision, lastAnalysisTime,
  isGioActive, startGioSession, endGioSession, gioTranscript, clipboardContent,
  gioError, setClipboardContent, pendingClipboardWriteRef,
  isDocumentPiPSupported, openDocumentPiP, pipMessage,
}: LandingPageProps) {
  const [debugOpen, setDebugOpen] = useState(false)
  const isConnected = status === 'streaming' || status === 'paused'
  const isPlaying = status === 'streaming'

  // suppress unused warning — esc is used in tooltip rendering via JS if needed
  void esc

  const handleCopyClipboard = async () => {
    if (!clipboardContent) return
    try {
      await navigator.clipboard.writeText(clipboardContent)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = clipboardContent
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      document.body.appendChild(ta); ta.focus(); ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    pendingClipboardWriteRef.current = null
  }

  return (
    <div style={{ position: 'relative', minHeight: '100vh', background: 'var(--bg)', overflowX: 'hidden' }}>
      {/* Layer 1: Gradient orbs */}
      <div className="gio-orb gio-orb-1" />
      <div className="gio-orb gio-orb-2" />
      <div className="gio-orb gio-orb-3" />

      {/* Layer 2: Particle canvas */}
      <ParticleCanvas />

      {/* Main content */}
      <div style={{ position: 'relative', zIndex: 2, maxWidth: 960, margin: '0 auto', padding: '60px 20px 140px' }}>
        {/* GIO Wordmark */}
        <div style={{ textAlign: 'center', marginBottom: 48 }} className="gio-wordmark-enter">
          <h1
            className="gio-gradient-text"
            style={{ fontSize: 'clamp(64px, 10vw, 120px)', fontWeight: 700, margin: 0, letterSpacing: '-0.04em', lineHeight: 1 }}
          >
            GIO
          </h1>
          <p style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 14, letterSpacing: '0.06em' }}>
            your ambient music assistant
          </p>
        </div>

        {/* PiP button row */}
        <div style={{ textAlign: 'center', marginBottom: 32, display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          {isDocumentPiPSupported && (
            <button
              onClick={openDocumentPiP}
              style={{
                padding: '8px 18px', borderRadius: 999, border: '1px solid var(--border)',
                background: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, transition: 'all 150ms',
              }}
            >
              Pop out player
            </button>
          )}
        </div>
        {pipMessage && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 }}>{pipMessage}</p>}
        {error && (
          <div style={{ marginBottom: 16, padding: '12px 16px', border: '1px solid rgba(234,67,53,0.3)', borderRadius: 12, background: 'rgba(234,67,53,0.08)', color: '#fca5a5', fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Card grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>

          {/* Card 1: MUSIC */}
          <div className="gio-card">
            <p className="gio-card-label">Music</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <button
                className={`gio-play-btn${isPlaying ? ' playing' : ''}`}
                onClick={() => isPlaying ? pauseStream() : playStream()}
                disabled={status === 'connecting'}
                style={{ opacity: status === 'connecting' ? 0.5 : 1, cursor: status === 'connecting' ? 'not-allowed' : 'pointer' }}
              >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <MarqueeText
                  text={currentMusicPrompt || 'ambient'}
                  className=""
                />
                <span style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'capitalize' }}>{status}</span>
              </div>
            </div>

            {/* Prompt input */}
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 6 }}>
                Manual prompt
              </label>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={2}
                style={{
                  width: '100%', boxSizing: 'border-box', background: 'var(--surface-hover)',
                  border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px',
                  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--sans)',
                  resize: 'vertical', outline: 'none',
                }}
                placeholder="Describe the sound…"
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  disabled={!isConnected}
                  onClick={syncPrompt}
                  style={{
                    flex: 1, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
                    background: 'var(--surface-hover)', color: 'var(--text-primary)', fontSize: 12,
                    fontWeight: 600, cursor: isConnected ? 'pointer' : 'not-allowed', opacity: isConnected ? 1 : 0.5,
                  }}
                >Apply prompt</button>
                <button
                  disabled={!isConnected}
                  onClick={() => toggleVocals()}
                  style={{
                    padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
                    background: vocalsEnabled ? 'rgba(52,168,83,0.15)' : 'var(--surface-hover)',
                    color: vocalsEnabled ? 'var(--gio-green)' : 'var(--text-primary)', fontSize: 12,
                    fontWeight: 600, cursor: isConnected ? 'pointer' : 'not-allowed', opacity: isConnected ? 1 : 0.5,
                  }}
                >{vocalsEnabled ? 'Vocals: On' : 'Vocals: Off'}</button>
              </div>
            </div>
          </div>

          {/* Card 2: ACTIVITY MONITOR */}
          <div className="gio-card">
            <p className="gio-card-label">Activity Monitor</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14 }}>
              <button
                className={`gio-pill-toggle${captureOn ? ' active' : ''}`}
                onClick={toggleCapture}
              >
                <span className="gio-pill-dot" />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {captureOn ? 'Capturing' : 'Start capturing'}
                </span>
              </button>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 11, color: 'var(--text-muted)' }}>{captureStatus}</p>
            {lastDetectedActivity && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, padding: '8px 10px', background: 'var(--surface-hover)', borderRadius: 8, marginTop: 4 }}>
                {lastDetectedActivity}
              </div>
            )}
          </div>

          {/* Card 3: GIO ASSISTANT */}
          <div className="gio-card">
            <p className="gio-card-label">Gio Assistant</p>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <button
                className={`gio-mic-btn${isGioActive ? ' active' : ''}`}
                onClick={() => isGioActive ? endGioSession() : startGioSession()}
              >
                <MicIcon size={32} />
              </button>
              <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>{isGioActive ? 'Tap to stop Gio' : 'Tap to talk to Gio'}</p>
              {gioError && <p style={{ margin: 0, fontSize: 11, color: '#fca5a5' }}>{gioError}</p>}
            </div>
            {(gioTranscript || clipboardContent) && (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {gioTranscript && (
                  <div className="gio-transcript">{gioTranscript}</div>
                )}
                {clipboardContent && (
                  <div className="gio-clipboard">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span className="gio-clipboard-label">Clipboard ready</span>
                      <button
                        onClick={() => setClipboardContent(null)}
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 4px', fontSize: 14 }}
                      >×</button>
                    </div>
                    <p style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {clipboardContent.split('\n').slice(0, 3).join('\n')}{clipboardContent.split('\n').length > 3 ? '\n…' : ''}
                    </p>
                    <button className="gio-clipboard-copy" onClick={handleCopyClipboard}>Copy to clipboard</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Card 4: MODELS */}
          <div className="gio-card">
            <p className="gio-card-label">Models & APIs</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {MODELS.map(m => (
                <div key={m.name} className="gio-model-pill">
                  <span className={`gio-model-dot ${m.category}`} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                  <span className="gio-model-tooltip">{m.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Card 5: DEBUG (collapsible, full width) */}
          <div className="gio-card" style={{ gridColumn: '1 / -1' }}>
            <button
              onClick={() => setDebugOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', padding: 0,
              }}
            >
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Debug</span>
              <ChevronIcon open={debugOpen} />
            </button>
            <div className={`gio-debug-drawer${debugOpen ? ' open' : ''}`}>
              {latestScreenshot && (
                <div>
                  <p style={{ margin: '0 0 4px', fontSize: 10, color: 'var(--text-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Last capture</p>
                  <img src={latestScreenshot} alt="Last capture" style={{ maxHeight: 70, maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)', objectFit: 'contain' }} />
                </div>
              )}
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 10, color: 'var(--text-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Gemini sees</p>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{lastDetectedActivity ?? 'Waiting for first analysis…'}</p>
              </div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 10, color: 'var(--text-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Gemini decision</p>
                <p style={{ margin: 0, fontSize: 12, color: lastGeminiDecision === 'FALSE' ? 'var(--text-subtle)' : '#86efac' }}>
                  {lastGeminiDecision === null ? 'Waiting…' : lastGeminiDecision === 'FALSE' ? 'No change (FALSE)' : `Changed to: ${lastGeminiDecision}`}
                </p>
              </div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 10, color: 'var(--text-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Last analysis</p>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{lastAnalysisTime ?? 'Not yet'}</p>
              </div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 10, color: 'var(--text-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Now playing</p>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{currentMusicPrompt}</p>
              </div>

              {/* Advanced settings (groove controls) collapsed into debug */}
              <details style={{ marginTop: 8 }}>
                <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>Advanced generation settings</summary>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* BPM */}
                  <div>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                      <span>BPM override {bpmOverridden ? `(${bpm})` : '(infer)'}</span>
                      <input type="checkbox" checked={bpmOverridden} onChange={e => setBpmOverridden(e.target.checked)} style={{ accentColor: 'var(--gio-green)' }} />
                    </label>
                    <input type="range" min={60} max={200} value={bpm} onChange={e => setBpm(Number(e.target.value))} disabled={!bpmOverridden} style={{ width: '100%', accentColor: 'var(--gio-green)' }} />
                  </div>
                  {/* Density */}
                  <div>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                      <span>Density {densityOverridden ? `(${density.toFixed(2)})` : '(infer)'}</span>
                      <input type="checkbox" checked={densityOverridden} onChange={e => setDensityOverridden(e.target.checked)} style={{ accentColor: 'var(--gio-green)' }} />
                    </label>
                    <input type="range" min={0} max={1} step={0.01} value={density} onChange={e => setDensity(Number(e.target.value))} disabled={!densityOverridden} style={{ width: '100%', accentColor: 'var(--gio-green)' }} />
                  </div>
                  {/* Brightness */}
                  <div>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                      <span>Brightness {brightnessOverridden ? `(${brightness.toFixed(2)})` : '(infer)'}</span>
                      <input type="checkbox" checked={brightnessOverridden} onChange={e => setBrightnessOverridden(e.target.checked)} style={{ accentColor: 'var(--gio-green)' }} />
                    </label>
                    <input type="range" min={0} max={1} step={0.01} value={brightness} onChange={e => setBrightness(Number(e.target.value))} disabled={!brightnessOverridden} style={{ width: '100%', accentColor: 'var(--gio-green)' }} />
                  </div>
                  {/* Only bass and drums */}
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                    <span>Only bass and drums</span>
                    <input type="checkbox" checked={onlyBassAndDrums} onChange={e => setOnlyBassAndDrums(e.target.checked)} style={{ accentColor: 'var(--gio-green)' }} />
                  </label>
                  <button
                    disabled={!isConnected}
                    onClick={syncConfig}
                    style={{
                      padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)',
                      background: 'var(--surface-hover)', color: 'var(--text-primary)', fontSize: 12,
                      fontWeight: 600, cursor: isConnected ? 'pointer' : 'not-allowed', opacity: isConnected ? 1 : 0.5,
                    }}
                  >Apply settings</button>
                </div>
              </details>
            </div>
          </div>

        </div>
      </div>

      {/* Layer 3: Audio visualizer at bottom */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 100, zIndex: 1, pointerEvents: 'none' }}>
        <AudioVisualizer analyserRef={analyserRef} status={status} />
      </div>
    </div>
  )
}
