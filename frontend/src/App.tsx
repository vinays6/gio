import { useLyriaStream } from './hooks/useLyriaStream'
import { useScreenCapture } from './hooks/useScreenCapture'
import { useGioSession } from './hooks/useGioSession'
import { useDocumentPiP } from './hooks/useDocumentPiP'
import { LandingPage } from './components/LandingPage'
import './index.css'

function App() {
  const getApiKey = () => import.meta.env.VITE_GEMINI_API_KEY?.trim() ?? ''

  const lyria = useLyriaStream(getApiKey)
  const capture = useScreenCapture({ getApiKey, applyPrompt: lyria.applyPrompt })
  const gio = useGioSession({ getApiKey, fadeVolume: lyria.fadeVolume, latestScreenshot: capture.latestScreenshot })

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
    <>
      <LandingPage
        status={lyria.status}
        playStream={lyria.playStream}
        pauseStream={lyria.pauseStream}
        error={lyria.error}
        analyserRef={lyria.analyserRef}
        vocalsEnabled={lyria.vocalsEnabled}
        toggleVocals={lyria.toggleVocals}
        onlyBassAndDrums={lyria.onlyBassAndDrums}
        setOnlyBassAndDrums={lyria.setOnlyBassAndDrums}
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
        syncPrompt={lyria.syncPrompt}
        syncConfig={lyria.syncConfig}
        captureOn={capture.captureOn}
        captureStatus={capture.captureStatus}
        toggleCapture={capture.toggleCapture}
        currentMusicPrompt={capture.currentMusicPrompt}
        lastDetectedActivity={capture.lastDetectedActivity}
        latestScreenshot={capture.latestScreenshot}
        lastGeminiDecision={capture.lastGeminiDecision}
        lastAnalysisTime={capture.lastAnalysisTime}
        isGioActive={gio.isGioActive}
        startGioSession={gio.startGioSession}
        endGioSession={gio.endGioSession}
        gioTranscript={gio.gioTranscript}
        clipboardContent={gio.clipboardContent}
        gioError={gio.gioError}
        setClipboardContent={gio.setClipboardContent}
        pendingClipboardWriteRef={gio.pendingClipboardWriteRef}
        isDocumentPiPSupported={pip.isDocumentPiPSupported}
        openDocumentPiP={pip.openDocumentPiP}
        pipMessage={pip.pipMessage}
      />
      {/* Hidden elements for screen capture */}
      <video ref={capture.videoRef} style={{ display: 'none' }} muted playsInline />
      <canvas ref={capture.canvasRef} width={1280} height={720} style={{ display: 'none' }} />
    </>
  )
}

export default App
