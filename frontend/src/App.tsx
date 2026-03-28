import { useUser } from './hooks/useUser'
import { useLyriaStream } from './hooks/useLyriaStream'
import { useScreenCapture } from './hooks/useScreenCapture'
import { useGioSession } from './hooks/useGioSession'
import { useDocumentPiP } from './hooks/useDocumentPiP'

import { HeroPanel } from './components/HeroPanel'
import { ControlPanel } from './components/ControlPanel'
import { StackSection } from './components/StackSection'

import './index.css'

function App() {
  const getApiKey = () => import.meta.env.VITE_GEMINI_API_KEY?.trim() ?? ''

  // 0. User Hook
  const { user, loading, setPreferences } = useUser()

  // 1. Lyria Stream Hook
  const lyria = useLyriaStream(getApiKey)

  // 2. Screen Capture Hook
  const capture = useScreenCapture({
    getApiKey,
    applyPrompt: lyria.applyPrompt,
    userPreferences: user?.preferences,
  })

  // 3. Gio Session Hook
  const gio = useGioSession({
    getApiKey,
    fadeVolume: lyria.fadeVolume,
    latestScreenshot: capture.latestScreenshot,
  })

  // 4. Document PiP Hook
  const pip = useDocumentPiP(
    {
      status: lyria.status,
      vocalsEnabled: lyria.vocalsEnabled,
      currentMusicPrompt: capture.currentMusicPrompt,
      latestScreenshot: capture.latestScreenshot,
      lastDetectedActivity: capture.lastDetectedActivity,
      lastGeminiDecision: capture.lastGeminiDecision,
      lastAnalysisTime: capture.lastAnalysisTime,
      isGioActive: gio.isGioActive,
      gioTranscript: gio.gioTranscript,
      clipboardContent: gio.clipboardContent,
      gioError: gio.gioError,
      pendingClipboardWriteRef: gio.pendingClipboardWriteRef,
    },
    {
      playStream: lyria.playStream,
      pauseStream: lyria.pauseStream,
      toggleVocals: lyria.toggleVocals,
      startGioSession: gio.startGioSession,
      endGioSession: gio.endGioSession,
      setClipboardContent: gio.setClipboardContent,
    }
  )

  return (
    <main className="min-h-screen px-4 pb-14 pt-6 md:px-8 md:pt-12 md:pb-[56px] box-border text-center bg-[radial-gradient(circle_at_top_left,rgba(255,136,77,0.24),transparent_28%),radial-gradient(circle_at_top_right,rgba(73,166,255,0.22),transparent_24%),linear-gradient(180deg,#08131f_0%,#0e1726_45%,#101d2f_100%)] text-[#f3f4f6]">
      <HeroPanel
        status={lyria.status}
        playStream={lyria.playStream}
        pauseStream={lyria.pauseStream}
        isDocumentPiPSupported={pip.isDocumentPiPSupported}
        openDocumentPiP={pip.openDocumentPiP}
        isGioActive={gio.isGioActive}
        startGioSession={gio.startGioSession}
        endGioSession={gio.endGioSession}
        gioError={gio.gioError}
        pipMessage={pip.pipMessage}
        error={lyria.error}
      />

      <ControlPanel
        user={user}
        userLoading={loading}
        setPreferences={setPreferences}
        prompt={lyria.prompt}
        setPrompt={lyria.setPrompt}
        bpm={lyria.bpm}
        setBpm={lyria.setBpm}
        density={lyria.density}
        setDensity={lyria.setDensity}
        brightness={lyria.brightness}
        setBrightness={lyria.setBrightness}
        bpmOverridden={lyria.bpmOverridden}
        setBpmOverridden={lyria.setBpmOverridden}
        densityOverridden={lyria.densityOverridden}
        setDensityOverridden={lyria.setDensityOverridden}
        brightnessOverridden={lyria.brightnessOverridden}
        setBrightnessOverridden={lyria.setBrightnessOverridden}
        vocalsEnabled={lyria.vocalsEnabled}
        setVocalsEnabled={lyria.setVocalsEnabled}
        onlyBassAndDrums={lyria.onlyBassAndDrums}
        setOnlyBassAndDrums={lyria.setOnlyBassAndDrums}
        syncPrompt={lyria.syncPrompt}
        syncConfig={lyria.syncConfig}
        toggleVocals={lyria.toggleVocals}
        captureOn={capture.captureOn}
        captureStatus={capture.captureStatus}
        toggleCapture={capture.toggleCapture}
        isConnected={lyria.status === 'streaming' || lyria.status === 'paused'}
      />

      <StackSection />

      {/* Hidden elements for screen capture */}
      {/* eslint-disable react-hooks/refs */}
      <video ref={capture.videoRef} style={{ display: 'none' }} muted playsInline />
      <canvas ref={capture.canvasRef} width={1280} height={720} style={{ display: 'none' }} />
      {/* eslint-enable react-hooks/refs */}
    </main>
  )
}

export default App
