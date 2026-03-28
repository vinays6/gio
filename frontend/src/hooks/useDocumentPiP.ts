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

    pipWindow.document.title = 'Gio controls'
    pipWindow.document.body.innerHTML = ''

    const style = pipWindow.document.createElement('style')
    style.textContent = `
      :root { color-scheme: dark; font-family: "Segoe UI", sans-serif; }
      body {
        margin: 0; min-height: 100vh; padding: 12px; box-sizing: border-box;
        background: radial-gradient(circle at top, rgba(249,115,22,0.24), transparent 36%),
                    linear-gradient(180deg, #08131f 0%, #101d2f 100%);
        color: #f8fafc;
      }
      .pip-shell {
        min-height: calc(100vh - 24px); display: grid; gap: 10px; align-content: start;
        border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; padding: 14px;
        background: rgba(7,12,20,0.82); backdrop-filter: blur(18px);
      }
      .pip-title-bar { display: flex; align-items: center; gap: 10px; }
      .pip-title { margin: 0; font-size: 1.1rem; line-height: 1; flex: 1; }
      .pip-status {
        display: inline-flex; align-items: center; justify-content: center;
        height: 28px; border-radius: 999px; padding: 0 10px;
        font-size: 0.72rem; font-weight: 700; text-transform: capitalize;
        background: rgba(148,163,184,0.16); color: #cbd5e1; white-space: nowrap;
      }
      .pip-status.streaming { background: rgba(34,197,94,0.2); color: #86efac; }
      .pip-status.connecting { background: rgba(251,191,36,0.18); color: #fde68a; }
      .pip-status.error { background: rgba(248,113,113,0.18); color: #fca5a5; }
      .pip-now-playing {
        padding: 8px 10px; border: 1px solid rgba(249,115,22,0.22);
        border-radius: 12px; background: rgba(249,115,22,0.07);
      }
      .pip-now-playing-label {
        margin: 0 0 3px; font-size: 0.6rem; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase; color: #f7b267;
      }
      .pip-now-playing-value {
        margin: 0; font-size: 0.82rem; color: #f8fafc; line-height: 1.4; word-break: break-word;
      }
      .pip-gio-section { display: grid; gap: 7px; }
      .pip-gio-indicator {
        display: flex; align-items: center; gap: 8px;
        font-size: 0.78rem; font-weight: 700; color: #c4b5fd;
      }
      .pip-gio-pulse {
        width: 9px; height: 9px; border-radius: 50%; background: #a78bfa; flex-shrink: 0;
        animation: pipGioPulse 1.2s ease-in-out infinite;
      }
      @keyframes pipGioPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(1.5); }
      }
      .pip-gio-transcript {
        max-height: 120px; overflow-y: auto; padding: 8px 10px;
        border: 1px solid rgba(167,139,250,0.2); border-radius: 10px;
        background: rgba(139,92,246,0.07); font-size: 0.77rem;
        line-height: 1.5; color: rgba(226,232,240,0.88); word-break: break-word;
      }
      .pip-gio-clipboard {
        padding: 9px 11px; border: 1px solid rgba(52,211,153,0.25);
        border-radius: 10px; background: rgba(52,211,153,0.06); display: grid; gap: 6px;
      }
      .pip-gio-clipboard-header { display: flex; align-items: center; justify-content: space-between; }
      .pip-gio-clipboard-label {
        font-size: 0.65rem; font-weight: 700; letter-spacing: 0.07em;
        text-transform: uppercase; color: #6ee7b7;
      }
      .pip-gio-clipboard-dismiss {
        background: none; border: none !important; color: rgba(226,232,240,0.4);
        font-size: 0.8rem; padding: 0 4px; cursor: pointer; border-radius: 4px;
      }
      .pip-gio-clipboard-preview {
        font-family: ui-monospace, Consolas, monospace; font-size: 0.68rem;
        color: rgba(226,232,240,0.62); margin: 0; line-height: 1.5;
        white-space: pre-wrap; word-break: break-word;
      }
      .pip-gio-clipboard-copy {
        background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.22) !important;
        color: #6ee7b7; font-size: 0.72rem; padding: 6px 12px;
        border-radius: 8px; cursor: pointer; font-weight: 700;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      .pip-gio-clipboard-copy:hover {
        background: rgba(52,211,153,0.22); border-color: rgba(52,211,153,0.45) !important;
      }
      .pip-gio-clipboard-copy.copied {
        background: rgba(52,211,153,0.3) !important; border-color: #34d399 !important;
        color: #fff; cursor: default;
      }
      .pip-gio-error { margin: 0; font-size: 0.74rem; color: #fca5a5; }
      .pip-gio-btn {
        width: 100%; padding: 11px 12px; border-radius: 14px;
        border: 1.5px solid rgba(139,92,246,0.35) !important;
        background: rgba(139,92,246,0.13); color: #c4b5fd;
        font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer; user-select: none;
      }
      .pip-gio-btn.active {
        background: rgba(139,92,246,0.28);
        border-color: rgba(167,139,250,0.6) !important;
        color: #ede9fe; animation: pipGioBtn 1.5s ease-in-out infinite;
      }
      @keyframes pipGioBtn {
        0%, 100% { box-shadow: 0 0 0 0 rgba(139,92,246,0.25); }
        50% { box-shadow: 0 0 0 5px rgba(139,92,246,0); }
      }
      .pip-debug-toggle {
        width: 100%; background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.09) !important;
        border-radius: 10px; padding: 6px 10px; font-size: 0.68rem; font-weight: 700;
        letter-spacing: 0.07em; text-transform: uppercase;
        color: rgba(226,232,240,0.45); cursor: pointer; text-align: left;
      }
      .pip-debug-toggle:hover { background: rgba(255,255,255,0.07); color: rgba(226,232,240,0.65); }
      .pip-debug-drawer { display: none; }
      .pip-debug-drawer.open { display: grid; gap: 5px; }
      .pip-debug-row {
        padding: 7px 9px; border: 1px solid rgba(255,255,255,0.06);
        border-radius: 10px; background: rgba(0,0,0,0.28);
      }
      .pip-debug-label {
        margin: 0 0 2px; font-size: 0.58rem; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase; color: rgba(247,178,103,0.65);
      }
      .pip-debug-value {
        margin: 0; font-family: ui-monospace, Consolas, monospace;
        font-size: 0.7rem; color: rgba(226,232,240,0.65); line-height: 1.4; word-break: break-word;
      }
      .pip-debug-value-false { color: rgba(148,163,184,0.5); }
      .pip-debug-value-change { color: #86efac; font-weight: 700; }
      .pip-debug-thumbnail {
        max-height: 70px; width: auto; max-width: 100%; object-fit: contain;
        border-radius: 6px; display: block; border: 1px solid rgba(255,255,255,0.08);
      }
      .pip-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      button {
        border: 0; border-radius: 14px; padding: 11px 12px;
        font: inherit; font-size: 0.82rem; font-weight: 700; cursor: pointer;
      }
      .pip-primary { background: linear-gradient(135deg,#f97316 0%,#fb7185 100%); color: #fff7ed; }
      .pip-secondary {
        background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #e2e8f0;
      }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
    `

    const isPlayable = state.status === 'paused' || state.status === 'stopped' || state.status === 'idle'
    const playPauseLabel = state.status === 'streaming' ? 'Pause' : 'Play'
    const vocalsLabel = state.vocalsEnabled ? 'Vocals on' : 'Vocals off'

    const thumbnailHtml = state.latestScreenshot
      ? `<img class="pip-debug-thumbnail" src="${state.latestScreenshot}" alt="Last capture" />`
      : `<p class="pip-debug-value">No capture yet</p>`
    const activityHtml = state.lastDetectedActivity
      ? `<p class="pip-debug-value">${esc(state.lastDetectedActivity)}</p>`
      : `<p class="pip-debug-value">Waiting for first analysis...</p>`

    let decisionHtml: string
    if (state.lastGeminiDecision === null) {
      decisionHtml = `<p class="pip-debug-value">Waiting...</p>`
    } else if (state.lastGeminiDecision === 'FALSE') {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-false">No change (FALSE)</p>`
    } else {
      decisionHtml = `<p class="pip-debug-value pip-debug-value-change">Changed to: ${esc(state.lastGeminiDecision)}</p>`
    }

    const gioIndicatorHtml = state.isGioActive
      ? `<div class="pip-gio-indicator"><div class="pip-gio-pulse"></div><span>Gio is listening...</span></div>`
      : state.gioTranscript
        ? `<div class="pip-gio-indicator"><span>✓ Gio responded</span></div>`
        : ''

    const gioTranscriptHtml = state.gioTranscript
      ? `<div class="pip-gio-transcript">${esc(state.gioTranscript)}</div>`
      : ''

    let gioClipboardHtml = ''
    if (state.clipboardContent) {
      const lines = state.clipboardContent.split('\n')
      const preview = lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n...' : '')
      gioClipboardHtml = `
        <div class="pip-gio-clipboard">
          <div class="pip-gio-clipboard-header">
            <span class="pip-gio-clipboard-label">📋 Clipboard ready</span>
            <button class="pip-gio-clipboard-dismiss" type="button">×</button>
          </div>
          <p class="pip-gio-clipboard-preview">${esc(preview)}</p>
          <button class="pip-gio-clipboard-copy" type="button">Copy</button>
        </div>`
    }
    const gioErrorHtml = state.gioError
      ? `<p class="pip-gio-error">${esc(state.gioError)}</p>`
      : ''
    const debugOpen = showDebugRef.current

    const shell = pipWindow.document.createElement('main')
    shell.className = 'pip-shell'
    shell.innerHTML = `
      <div class="pip-title-bar">
        <h1 class="pip-title">Gio controls</h1>
        <span class="pip-status ${state.status}">${state.status}</span>
      </div>
      <div class="pip-now-playing">
        <p class="pip-now-playing-label">Now playing</p>
        <p class="pip-now-playing-value">${esc(state.currentMusicPrompt)}</p>
      </div>
      <div class="pip-gio-section">
        ${gioIndicatorHtml}
        ${gioTranscriptHtml}
        ${gioClipboardHtml}
        ${gioErrorHtml}
        <button class="pip-gio-btn${state.isGioActive ? ' active' : ''}" type="button">
          ${state.isGioActive ? '🎙 Stop Gio' : 'Talk to Gio'}
        </button>
      </div>
      <button class="pip-debug-toggle" type="button">Debug ${debugOpen ? '▲' : '▼'}</button>
      <div class="pip-debug-drawer${debugOpen ? ' open' : ''}">
        <div class="pip-debug-row">
          <p class="pip-debug-label">Last screen capture</p>
          ${thumbnailHtml}
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Gemini sees</p>
          ${activityHtml}
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Gemini decision</p>
          ${decisionHtml}
        </div>
        <div class="pip-debug-row">
          <p class="pip-debug-label">Last analysis</p>
          <p class="pip-debug-value">${state.lastAnalysisTime ?? 'Not yet'}</p>
        </div>
      </div>
      <div class="pip-actions">
        <button class="pip-primary" type="button" ${state.status === 'connecting' ? 'disabled' : ''}>
          ${playPauseLabel}
        </button>
        <button class="pip-secondary" type="button" ${state.status === 'connecting' ? 'disabled' : ''}>
          ${vocalsLabel}
        </button>
      </div>
    `

    pipWindow.document.head.innerHTML = ''
    pipWindow.document.head.appendChild(style)
    pipWindow.document.body.appendChild(shell)

    shell.querySelector<HTMLButtonElement>('.pip-debug-toggle')?.addEventListener('click', () => {
      showDebugRef.current = !showDebugRef.current
      // eslint-disable-next-line react-hooks/exhaustive-deps
      setTimeout(() => updatePiPContents(), 0)
    })

    const gioBtn = shell.querySelector<HTMLButtonElement>('.pip-gio-btn')
    if (gioBtn) {
      gioBtn.addEventListener('click', () => {
        if (state.isGioActive) {
          actions.endGioSession()
        } else {
          actions.startGioSession()
        }
      })
    }

    const copyBtn = shell.querySelector<HTMLButtonElement>('.pip-gio-clipboard-copy')
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
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

        if (pipWindow.navigator?.clipboard) {
          pipWindow.navigator.clipboard.writeText(state.clipboardContent)
            .then(showSuccess)
            .catch(() => {
              try {
                const ta = pipWindow.document.createElement('textarea')
                ta.value = state.clipboardContent!
                ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
                pipWindow.document.body.appendChild(ta)
                ta.focus(); ta.select()
                pipWindow.document.execCommand('copy')
                pipWindow.document.body.removeChild(ta)
                showSuccess()
              } catch { /* no-op */ }
            })
        } else {
          try {
            const ta = pipWindow.document.createElement('textarea')
            ta.value = state.clipboardContent!
            ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
            pipWindow.document.body.appendChild(ta)
            ta.focus(); ta.select()
            pipWindow.document.execCommand('copy')
            pipWindow.document.body.removeChild(ta)
            showSuccess()
          } catch (err) { /* no-op */ }
        }
      })
    }

    shell.querySelector<HTMLButtonElement>('.pip-gio-clipboard-dismiss')?.addEventListener('click', () => {
      actions.setClipboardContent(null)
    })

    shell.querySelector<HTMLButtonElement>('.pip-primary')?.addEventListener('click', () => {
      if (state.status === 'streaming') { actions.pauseStream(); return }
      if (isPlayable) actions.playStream()
    })

    shell.querySelector<HTMLButtonElement>('.pip-secondary')?.addEventListener('click', () => {
      actions.toggleVocals()
    })
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
        width: 340,
        height: 580,
        preferInitialWindowPlacement: true,
      })
      pipWindowRef.current = pipWindow
      setPipMessage('')
      pipWindow.addEventListener('pagehide', () => { pipWindowRef.current = null })

      pipWindow.document.addEventListener('click', () => {
        const content = state.pendingClipboardWriteRef?.current
        if (!content) return
        pipWindow.navigator.clipboard.writeText(content)
          .then(() => {
            if (state.pendingClipboardWriteRef) state.pendingClipboardWriteRef.current = null
          })
          .catch(() => { })
      }, { capture: true })

      updatePiPContents()
    } catch (pipError) {
      const message = pipError instanceof Error ? pipError.message : 'The browser blocked the Picture-in-Picture window.'
      setPipMessage(message)
    }
  }, [isDocumentPiPSupported, state.pendingClipboardWriteRef, updatePiPContents])

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

  // Expose unmount for App.tsx
  useEffect(() => {
    return () => {
      closeDocumentPiP()
    }
  }, [closeDocumentPiP])

  return {
    isDocumentPiPSupported,
    pipMessage,
    openDocumentPiP,
    closeDocumentPiP
  }
}
