export function StackSection() {
  return (
    <section className="max-w-[1120px] mx-auto pt-7 pb-0">
      <p className="m-0 mb-2.5 text-[#f7b267] text-[0.78rem] font-bold tracking-[0.08em] uppercase">Stack</p>
      <h2 className="m-0 mb-5 text-[#f8fafc] text-[1.7rem]">Powered by</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">gemini-3.1-pro-preview</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Vision analysis and music direction</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-orange-500/18 text-orange-300 border border-orange-500/25">Vision</span>
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-orange-500/18 text-orange-300 border border-orange-500/25">Reasoning</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">gemini-3.1-flash-live-preview</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Push-to-talk voice assistant (Gio)</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-orange-500/18 text-orange-300 border border-orange-500/25">Live Audio</span>
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-orange-500/18 text-orange-300 border border-orange-500/25">Voice</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">lyria-realtime-exp</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Realtime adaptive music generation</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-orange-500/18 text-orange-300 border border-orange-500/25">Music Generation</span>
          </div>
        </div>
        {/* Browser APIs */}
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">getDisplayMedia</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Screen capture for activity analysis</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
             <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-blue-500/14 text-blue-300 border border-blue-500/22">Browser API</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">getUserMedia</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Microphone capture for Gio</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-blue-500/14 text-blue-300 border border-blue-500/22">Browser API</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">Web Speech API</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">"Hey Gio" wake word detection</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
             <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-blue-500/14 text-blue-300 border border-blue-500/22">Browser API</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">Picture-in-Picture API</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Floating player while you work</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
             <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-blue-500/14 text-blue-300 border border-blue-500/22">Browser API</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">Web Audio API</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">PCM16 audio scheduling and playback</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-blue-500/14 text-blue-300 border border-blue-500/22">Browser API</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">Canvas API</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Frame extraction from video stream</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
             <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-blue-500/14 text-blue-300 border border-blue-500/22">Browser API</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-4 py-4 px-4.5 border border-white/10 rounded-[18px] bg-[#070c14]/60 backdrop-blur-[12px]">
          <p className="m-0 text-[#f8fafc] text-[0.88rem] font-bold font-mono tracking-[-0.01em]">WebSocket API</p>
          <p className="m-0 flex-1 text-[#e2e8f0]/60 text-[0.78rem] leading-[1.45]">Realtime connection to Lyria model</p>
          <div className="flex flex-wrap gap-1.5 mt-0.5">
             <span className="inline-flex items-center h-[22px] px-[9px] rounded-full text-[0.64rem] font-bold tracking-[0.06em] uppercase bg-blue-500/14 text-blue-300 border border-blue-500/22">Browser API</span>
          </div>
        </div>
      </div>
    </section>
  )
}
