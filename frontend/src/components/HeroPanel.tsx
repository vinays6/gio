import type { StreamStatus } from '../constants'

interface HeroPanelProps {
  status: StreamStatus
  playStream: () => void
  pauseStream: () => void
  isDocumentPiPSupported: boolean
  openDocumentPiP: () => void
  isGioActive: boolean
  startGioSession: () => void
  endGioSession: () => void
  gioError: string | null
  pipMessage: string
  error: string
}

export function HeroPanel({
  status,
  playStream,
  pauseStream,
  isDocumentPiPSupported,
  openDocumentPiP,
  isGioActive,
  startGioSession,
  endGioSession,
  gioError,
  pipMessage,
  error,
}: HeroPanelProps) {
  return (
    <section className="max-w-[1120px] mx-auto mb-6 p-8 rounded-[28px] text-left border border-white/12 bg-[#070c14]/70 backdrop-blur-[18px] shadow-[0_24px_60px_rgba(0,0,0,0.28)] max-[860px]:p-[22px] max-[860px]:rounded-[22px]">
      <p className="m-0 mb-2.5 text-[#f7b267] text-[0.78rem] font-bold tracking-[0.08em] uppercase">
        Realtime music streaming
      </p>
      <h1 className="m-0 text-[#f8fafc] text-[clamp(2.7rem,7vw,5.4rem)] leading-[0.95] tracking-[-0.04em]">
        Gio control room
      </h1>
      <p className="max-w-[760px] mt-[18px] text-[#e2e8f0]/90 text-[1.05rem] leading-[1.7]">
        Play or pause the stream, toggle vocals, and tune the groove live while the
        track keeps moving.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,220px))] gap-[14px] mt-[28px] max-[860px]:grid-cols-1">
        <span
          className={`inline-flex items-center justify-center min-h-[42px] px-4 rounded-full font-bold capitalize tracking-[0.08em] ${
            status === 'idle' || status === 'stopped' || status === 'paused'
              ? 'bg-slate-400/16 text-slate-300'
              : status === 'connecting'
              ? 'bg-amber-400/18 text-amber-200'
              : status === 'streaming'
              ? 'bg-green-500/20 text-green-300'
              : 'bg-red-400/18 text-red-300'
          }`}
        >
          {status}
        </span>
        <button
          className="border-0 rounded-[18px] py-[14px] px-[18px] font-bold cursor-pointer transition-all duration-180 hover:-translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none bg-gradient-to-br from-orange-500 to-rose-400 text-orange-50 shadow-[0_18px_30px_rgba(249,115,22,0.28)]"
          disabled={status === 'connecting'}
          onClick={() => (status === 'streaming' ? pauseStream() : playStream())}
        >
          {status === 'streaming' ? 'Pause' : 'Play'}
        </button>
        <button
          className="border border-white/12 rounded-[18px] py-[14px] px-[18px] font-bold cursor-pointer transition-all duration-180 hover:-translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none bg-white/10 text-slate-200"
          disabled={!isDocumentPiPSupported}
          onClick={() => openDocumentPiP()}
        >
          Pop out player
        </button>
      </div>

      {/* Gio push-to-talk */}
      <div className="flex items-center gap-4 mt-[22px] flex-wrap">
        <button
          className={`border-2 rounded-full py-[14px] px-[28px] font-bold text-[0.95rem] cursor-pointer select-none transition-all duration-200 ${
            isGioActive
              ? 'bg-violet-500/30 border-violet-400 text-violet-100 animate-[gio-pulse_1.5s_ease-in-out_infinite] shadow-[0_0_24px_rgba(139,92,246,0.35)]'
              : 'border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 hover:border-violet-500/60'
          }`}
          onClick={() => (isGioActive ? endGioSession() : startGioSession())}
        >
          {isGioActive ? '🎙 Stop Gio' : 'Talk to Gio'}
        </button>
        {gioError ? <p className="m-0 text-red-300 text-[0.78rem]">{gioError}</p> : null}
      </div>

      <p className="mt-[18px] text-slate-200/70 text-[0.72rem] tracking-[0.08em] uppercase">
        Use `VITE_GEMINI_API_KEY` in your local environment. When supported, the app
        will try to move into Document Picture-in-Picture if you switch away while
        streaming.
      </p>

      {pipMessage ? <p className="mt-[18px] text-slate-200/70 text-[0.72rem] tracking-[0.08em] uppercase">{pipMessage}</p> : null}
      {error ? (
        <p className="mt-[18px] p-[14px_16px] border border-red-400/30 rounded-[16px] bg-red-900/25 text-red-200">
          {error}
        </p>
      ) : null}
    </section>
  )
}
