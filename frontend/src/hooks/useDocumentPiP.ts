import { useState, useRef, useEffect, useCallback } from 'react'
import { esc, type StreamStatus } from '../constants'

export interface PiPState {
  status: StreamStatus
  vocalsEnabled: boolean
  currentMusicPrompt: string
  latestScreenshot: string | null
  lastDetectedActivity: string | null
  lastGeminiDecision: string | null
  lastAnalysisTime: string | null
  isGioActive: boolean
  gioTranscript: string
  clipboardContent: string | null
  gioError: string | null
  pendingClipboardWriteRef?: React.MutableRefObject<string | null>
}

export interface PiPActions {
  playStream: () => void
  pauseStream: () => void
  toggleVocals: () => void
  startGioSession: () => void
  endGioSession: () => void
  setClipboardContent: (content: string | null) => void
}

export function useDocumentPiP(state: PiPState, actions: PiPActions) {
  const [pipMessage, setPipMessage] = useState('')
  const pipWindowRef = useRef<Window | null>(null)
  const showDebugRef = useRef(false)

  const isDocumentPiPSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window

  const closeDocumentPiP = useCallback(() => {
    pipWindowRef.current?.close()
    pipWindowRef.current = null
  }, [])

  const updatePiPContents = useCallback(() => {
    const pipWindow = pipWindowRef.current
    if (!pipWindow || pipWindow.closed) {
      pipWindowRef.current = null
      return
    }

    pipWindow.document.title = 'Gio'
    pipWindow.document.body.innerHTML = ''

    const style = pipWindow.document.createElement('style')
    style.textContent = `
      :root { color-scheme: dark; font-family: system-ui, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        background: #111; color: #f0f0f0;
        width: 100vw; min-height: 100vh;
        overflow-x: hidden;
      }
      .pip-root {
        display: flex; flex-direction: column;
        background: #1a1a1a;
        overflow: hidden;
        min-height: 100vh;
      }
      .pip-header {
        height: 36px; display: flex; align-items: center; justify-content: center;
        background: linear-gradient(90deg, #34A853, #FBBC05, #EA4335);
        flex-shrink: 0;
      }
      .pip-header-title {
        font-size: 16px; font-weight: 700; color: #fff; letter-spacing: 0.12em;
      }
      .pip-section {
        padding: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .pip-section:last-child { border-bottom: none; }
      .pip-label {
        font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
        text-transform: uppercase; color: rgba(240,240,240,0.35);
        margin-bottom: 8px;
      }
      .pip-music-row {
        display: flex; align-items: center; gap: 10px;
      }
      .pip-play-btn {
        width: 36px; height: 36px; border-radius: 50%; border: none;
        background: rgba(255,255,255,0.1); color: #f0f0f0;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; flex-shrink: 0; font-size: 14px;
        transition: background 150ms;
      }
      .pip-play-btn:hover { background: rgba(255,255,255,0.18); }
      .pip-play-btn:active { transform: scale(0.92); }
      .pip-play-btn.playing { background: rgba(52,168,83,0.25); }
      .pip-marquee-wrap {
        overflow: hidden; flex: 1; min-width: 0; white-space: nowrap;
      }
      .pip-marquee-inner {
        display: inline-block; font-size: 13px; color: #f0f0f0;
        white-space: nowrap;
      }
      .pip-marquee-inner.scrolling {
        animation: pipMarquee var(--md, 8s) linear infinite;
      }
      @keyframes pipMarquee {
        0%  { transform: translateX(0); }
        10% { transform: translateX(0); }
        80% { transform: translateX(var(--mo, -60px)); }
        90% { transform: translateX(var(--mo, -60px)); }
        100%{ transform: translateX(0); }
      }
      .pip-mic-row {
        display: flex; align-items: center; justify-content: center; gap: 12px;
      }
      .pip-mic-btn {
        width: 56px; height: 56px; border-radius: 50%; border: none;
        background: rgba(255,255,255,0.08); color: #f0f0f0;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; font-size: 22px;
        transition: background 200ms;
      }
      .pip-mic-btn:active { transform: scale(0.92); }
      .pip-mic-btn.active {
        background: rgba(52,168,83,0.18);
        animation: pipMicRing 1.5s ease-in-out infinite;
      }
      @keyframes pipMicRing {
        0%,100% { box-shadow: 0 0 0 0 rgba(52,168,83,0.5); }
        50% { box-shadow: 0 0 0 8px rgba(52,168,83,0.08); }
      }
      .pip-eq {
        display: flex; align-items: flex-end; gap: 2px; height: 16px;
      }
      .pip-eq-bar {
        width: 3px; background: #34A853; border-radius: 2px;
      }
      .pip-eq-bar:nth-child(1) { animation: eqB1 0.7s ease-in-out infinite; }
      .pip-eq-bar:nth-child(2) { animation: eqB2 0.9s ease-in-out infinite; }
      .pip-eq-bar:nth-child(3) { animation: eqB3 0.6s ease-in-out infinite; }
      @keyframes eqB1 { 0%,100%{height:4px} 50%{height:14px} }
      @keyframes eqB2 { 0%,100%{height:10px} 50%{height:4px} }
      @keyframes eqB3 { 0%,100%{height:6px} 50%{height:12px} }
      .pip-transcript {
        max-height: 80px; overflow-y: auto; font-size: 12px;
        line-height: 1.5; color: rgba(240,240,240,0.65);
        -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
        mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      }
      .pip-clipboard {
        padding: 9px 10px; border: 1px solid rgba(52,211,153,0.25);
        border-radius: 10px; background: rgba(52,211,153,0.06);
        display: flex; flex-direction: column; gap: 6px;
      }
      .pip-clipboard-header { display: flex; align-items: center; justify-content: space-between; }
      .pip-clipboard-label { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #6ee7b7; }
      .pip-clipboard-dismiss { background: none; border: none; color: rgba(240,240,240,0.4); font-size: 14px; cursor: pointer; padding: 0 4px; }
      .pip-clipboard-preview { font-family: ui-monospace, monospace; font-size: 10px; color: rgba(240,240,240,0.5); white-space: pre-wrap; word-break: break-word; }
      .pip-clipboard-copy { background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.3); border-radius: 7px; color: #6ee7b7; font-size: 11px; font-weight: 700; padding: 5px 10px; cursor: pointer; }
      .pip-clipboard-copy:hover { background: rgba(52,211,153,0.22); }
      .pip-clipboard-copy.copied { background: rgba(52,211,153,0.3); color: #fff; cursor: default; }
      .pip-debug-toggle {
        display: flex; align-items: center; justify-content: space-between;
        width: 100%; background: none; border: none; cursor: pointer;
        color: rgba(240,240,240,0.35); font-size: 9px; font-weight: 700;
        letter-spacing: 0.1em; text-transform: uppercase; padding: 0;
      }
      .pip-debug-toggle:hover { color: rgba(240,240,240,0.6); }
      .pip-debug-row { margin-top: 8px; }
      .pip-debug-label { font-size: 8px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(247,178,103,0.6); margin-bottom: 3px; }
      .pip-debug-val { font-family: ui-monospace, monospace; font-size: 10px; color: rgba(240,240,240,0.55); line-height: 1.4; word-break: break-word; }
      .pip-debug-thumb { max-height: 60px; width: auto; max-width: 100%; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); display: block; object-fit: contain; }
      .pip-gio-error { font-size: 11px; color: #fca5a5; margin-top: 4px; }
    `

    const isPlaying = state.status === 'streaming'
    const isPlayable = state.status === 'paused' || state.status === 'stopped' || state.status === 'idle'
    const debugOpen = showDebugRef.current

    // Marquee check will be done after inject via script
    const shell = pipWindow.document.createElement('div')
    shell.className = 'pip-root'

    const showOutput = state.gioTranscript || state.clipboardContent

    let clipboardHtml = ''
    if (state.clipboardContent) {
      const lines = state.clipboardContent.split('\n')
      const preview = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : '')
      clipboardHtml = `
        <div class="pip-clipboard">
          <div class="pip-clipboard-header">
            <span class="pip-clipboard-label">Clipboard ready</span>
            <button class="pip-clipboard-dismiss" type="button">×</button>
          </div>
          <p class="pip-clipboard-preview">${esc(preview)}</p>
          <button class="pip-clipboard-copy" type="button">Copy</button>
        </div>`
    }

    let decisionText = 'Waiting…'
    let decisionColor = 'rgba(240,240,240,0.55)'
    if (state.lastGeminiDecision === 'FALSE') { decisionText = 'No change (FALSE)'; decisionColor = 'rgba(240,240,240,0.3)' }
    else if (state.lastGeminiDecision) { decisionText = `Changed to: ${esc(state.lastGeminiDecision)}`; decisionColor = '#86efac' }

    shell.innerHTML = `
      <div class="pip-header">
        <span class="pip-header-title">GIO</span>
      </div>

      <div class="pip-section">
        <p class="pip-label">Music</p>
        <div class="pip-music-row">
          <button class="pip-play-btn${isPlaying ? ' playing' : ''}" type="button"
            ${state.status === 'connecting' ? 'disabled' : ''}>
            ${isPlaying ? '⏸' : '▶'}
          </button>
          <div class="pip-marquee-wrap" id="pip-marquee-wrap">
            <span class="pip-marquee-inner" id="pip-marquee-inner">${esc(state.currentMusicPrompt || 'ambient')}</span>
          </div>
        </div>
      </div>

      <div class="pip-section">
        <p class="pip-label">Gio Assistant</p>
        <div class="pip-mic-row">
          <button class="pip-mic-btn${state.isGioActive ? ' active' : ''}" type="button">🎙</button>
          ${state.isGioActive ? '<div class="pip-eq"><div class="pip-eq-bar"></div><div class="pip-eq-bar"></div><div class="pip-eq-bar"></div></div>' : ''}
        </div>
        ${state.gioError ? `<p class="pip-gio-error">${esc(state.gioError)}</p>` : ''}
      </div>

      ${showOutput ? `
      <div class="pip-section">
        ${state.gioTranscript ? `<div class="pip-transcript">${esc(state.gioTranscript)}</div>` : ''}
        ${clipboardHtml}
      </div>` : ''}

      <div class="pip-section">
        <button class="pip-debug-toggle" type="button">
          <span>Debug</span>
          <span>${debugOpen ? '▲' : '▼'}</span>
        </button>
        ${debugOpen ? `
        <div>
          <div class="pip-debug-row">
            <p class="pip-debug-label">Last capture</p>
            ${state.latestScreenshot ? `<img class="pip-debug-thumb" src="${state.latestScreenshot}" alt="capture" />` : '<p class="pip-debug-val">No capture yet</p>'}
          </div>
          <div class="pip-debug-row">
            <p class="pip-debug-label">Gemini sees</p>
            <p class="pip-debug-val">${esc(state.lastDetectedActivity ?? 'Waiting…')}</p>
          </div>
          <div class="pip-debug-row">
            <p class="pip-debug-label">Gemini decision</p>
            <p class="pip-debug-val" style="color:${decisionColor}">${decisionText}</p>
          </div>
          <div class="pip-debug-row">
            <p class="pip-debug-label">Last analysis</p>
            <p class="pip-debug-val">${state.lastAnalysisTime ?? 'Not yet'}</p>
          </div>
          <div class="pip-debug-row">
            <p class="pip-debug-label">Now playing</p>
            <p class="pip-debug-val">${esc(state.currentMusicPrompt)}</p>
          </div>
        </div>` : ''}
      </div>
    `

    pipWindow.document.head.innerHTML = ''
    pipWindow.document.head.appendChild(style)
    pipWindow.document.body.appendChild(shell)

    // Marquee: check overflow after DOM paint
    setTimeout(() => {
      const wrap = shell.querySelector<HTMLElement>('#pip-marquee-wrap')
      const inner = shell.querySelector<HTMLElement>('#pip-marquee-inner')
      if (wrap && inner && inner.scrollWidth > wrap.offsetWidth) {
        const offset = -(inner.scrollWidth - wrap.offsetWidth + 20)
        inner.style.setProperty('--mo', `${offset}px`)
        const duration = Math.max(5, state.currentMusicPrompt.length * 0.12)
        inner.style.setProperty('--md', `${duration}s`)
        inner.classList.add('scrolling')
      }
    }, 50)

    // ── Event listeners (with stopPropagation on all buttons) ──

    shell.querySelector<HTMLButtonElement>('.pip-play-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (state.status === 'streaming') {
        actions.pauseStream()
      } else if (isPlayable) {
        actions.playStream()
      }
    })

    const micBtn = shell.querySelector<HTMLButtonElement>('.pip-mic-btn')
    if (micBtn) {
      micBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (state.isGioActive) {
          actions.endGioSession()
        } else {
          actions.startGioSession()
        }
      })
    }

    shell.querySelector<HTMLButtonElement>('.pip-debug-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation()
      showDebugRef.current = !showDebugRef.current
      setTimeout(() => updatePiPContents(), 0)
    })

    shell.querySelector<HTMLButtonElement>('.pip-clipboard-dismiss')?.addEventListener('click', (e) => {
      e.stopPropagation()
      actions.setClipboardContent(null)
    })

    const copyBtn = shell.querySelector<HTMLButtonElement>('.pip-clipboard-copy')
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (!state.clipboardContent) return

        const showSuccess = () => {
          copyBtn.textContent = '✓ Copied!'
          copyBtn.classList.add('copied')
          copyBtn.disabled = true
          setTimeout(() => {
            copyBtn.textContent = 'Copy'
            copyBtn.classList.remove('copied')
            copyBtn.disabled = false
          }, 2000)
        }

        const writeText = state.clipboardContent
        if (pipWindow.navigator?.clipboard) {
          pipWindow.navigator.clipboard.writeText(writeText).then(showSuccess).catch(() => {
            try {
              const ta = pipWindow.document.createElement('textarea')
              ta.value = writeText
              ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
              pipWindow.document.body.appendChild(ta); ta.focus(); ta.select()
              pipWindow.document.execCommand('copy')
              pipWindow.document.body.removeChild(ta)
              showSuccess()
            } catch { /* no-op */ }
          })
        }
      })
    }
  }, [state, actions])

  const openDocumentPiP = useCallback(async () => {
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
        width: 300,
        height: 480,
        preferInitialWindowPlacement: true,
      })
      pipWindowRef.current = pipWindow
      setPipMessage('')
      pipWindow.addEventListener('pagehide', () => { pipWindowRef.current = null })

      // BUG FIX: removed the { capture: true } document-level click listener
      // that was intercepting play button clicks and causing unexpected PiP closure.
      // Clipboard writes are now handled only via explicit copy button clicks.
      // The pendingClipboardWriteRef is still handled in endGioSession (main window).

      updatePiPContents()
    } catch (pipError) {
      const message = pipError instanceof Error ? pipError.message : 'The browser blocked the Picture-in-Picture window.'
      setPipMessage(message)
    }
  }, [isDocumentPiPSupported, updatePiPContents])

  useEffect(() => {
    updatePiPContents()
  }, [updatePiPContents])

  useEffect(() => {
    if (!isDocumentPiPSupported) return
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden' || state.status !== 'streaming') return
      void openDocumentPiP()
    }
    const handlePageHide = () => {
      if (state.status !== 'streaming') return
      void openDocumentPiP()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [isDocumentPiPSupported, state.status, openDocumentPiP])

  useEffect(() => {
    return () => { closeDocumentPiP() }
  }, [closeDocumentPiP])

  return { isDocumentPiPSupported, pipMessage, openDocumentPiP, closeDocumentPiP }
}
