interface ControlPanelProps {
  prompt: string
  setPrompt: (v: string) => void
  bpm: number
  setBpm: (v: number) => void
  density: number
  setDensity: (v: number) => void
  brightness: number
  setBrightness: (v: number) => void
  bpmOverridden: boolean
  setBpmOverridden: (v: boolean) => void
  densityOverridden: boolean
  setDensityOverridden: (v: boolean) => void
  brightnessOverridden: boolean
  setBrightnessOverridden: (v: boolean) => void
  vocalsEnabled: boolean
  setVocalsEnabled: (v: boolean) => void
  onlyBassAndDrums: boolean
  setOnlyBassAndDrums: (v: boolean) => void
  syncPrompt: () => void
  syncConfig: () => void
  toggleVocals: () => void
  captureOn: boolean
  captureStatus: string
  toggleCapture: () => void
  isConnected: boolean
}

export function ControlPanel({
  prompt, setPrompt,
  bpm, setBpm,
  density, setDensity,
  brightness, setBrightness,
  bpmOverridden, setBpmOverridden,
  densityOverridden, setDensityOverridden,
  brightnessOverridden, setBrightnessOverridden,
  vocalsEnabled, toggleVocals,
  onlyBassAndDrums, setOnlyBassAndDrums,
  syncPrompt, syncConfig,
  captureOn, captureStatus, toggleCapture,
  isConnected
}: ControlPanelProps) {
  return (
    <section className="grid grid-cols-2 gap-[14px] max-[860px]:grid-cols-1 max-w-[1120px] mx-auto">
      <div className="flex flex-col min-h-full gap-[14px]">
        {/* Prompt Card */}
        <section className="flex flex-col rounded-[24px] p-[28px] text-left border border-white/12 bg-[#070c14]/70 backdrop-blur-[18px]">
          <div className="mb-[22px]">
            <p className="m-0 mb-2.5 text-orange-300 text-[0.78rem] font-bold tracking-[0.08em] uppercase">Prompt</p>
            <h2 className="m-0 text-[#f8fafc] text-[1.7rem]">Shape the track</h2>
          </div>
          <label className="block mb-2.5 text-slate-200/70 text-[0.74rem] font-bold tracking-[0.08em] uppercase" htmlFor="prompt">Weighted prompt</label>
          <textarea
            id="prompt"
            className="w-full min-h-[84px] mb-[18px] box-border border border-white/12 rounded-[18px] p-4 bg-slate-900/70 text-slate-50 font-inherit resize-y placeholder:text-slate-400/75"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the sound you want Lyria to generate."
            rows={3}
          />
          <button
            className="w-full border border-white/12 rounded-[18px] py-[14px] px-[18px] font-bold cursor-pointer transition-all hover:-translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed bg-white/10 text-slate-200"
            disabled={!isConnected}
            onClick={() => syncPrompt()}
          >
            Apply prompt
          </button>
        </section>

        {/* Capture Card */}
        <section className="flex flex-col rounded-[24px] p-[28px] text-left border border-white/12 bg-[#070c14]/70 backdrop-blur-[18px]">
          <div className="mb-[22px]">
            <p className="m-0 mb-2.5 text-orange-300 text-[0.78rem] font-bold tracking-[0.08em] uppercase">Capture</p>
            <h2 className="m-0 text-[#f8fafc] text-[1.7rem]">Activity Monitor</h2>
          </div>
          <div className="flex items-center gap-[14px] mt-3.5 flex-wrap">
            <button
              className={`flex-shrink-0 border border-white/12 rounded-[18px] py-[14px] px-[18px] font-bold cursor-pointer transition-all hover:-translate-y-[1px] text-slate-200 ${captureOn ? 'bg-gradient-to-br from-orange-500 to-rose-400 border-0 shadow-[0_18px_30px_rgba(249,115,22,0.28)]' : 'bg-white/10'}`}
              onClick={() => toggleCapture()}
            >
              {captureOn ? 'Turn off Activity Monitor' : 'Activity Monitor'}
            </button>
            <p className="m-0 text-slate-200/70 text-[0.72rem] tracking-[0.04em] uppercase">{captureStatus}</p>
          </div>
        </section>
      </div>

      {/* Groove Card */}
      <section className="rounded-[24px] p-[28px] text-left border border-white/12 bg-[#070c14]/70 backdrop-blur-[18px]">
        <div className="mb-[22px]">
          <p className="m-0 mb-2.5 text-orange-300 text-[0.78rem] font-bold tracking-[0.08em] uppercase">Generation</p>
          <h2 className="m-0 text-[#f8fafc] text-[1.7rem]">Adjust the groove</h2>
        </div>

        {/* BPM */}
        <label className="block mb-2.5 text-slate-200/70 text-[0.74rem] font-bold tracking-[0.08em] uppercase" htmlFor="bpm">BPM</label>
        <label className="flex items-center justify-between gap-3 m-[0_0_6px] p-[9px_12px] border border-white/12 rounded-[14px] bg-white/5 cursor-pointer" htmlFor="bpm-override">
          <span className="flex items-baseline gap-2">
            <span className="text-[#f8fafc] text-[0.82rem] font-bold tracking-[0.05em] uppercase">Override</span>
            <span className="text-slate-200/70 text-[0.8rem] leading-none">{bpmOverridden ? `${bpm} BPM` : 'Infer'}</span>
          </span>
          <input
            id="bpm-override"
            type="checkbox"
            className="w-[18px] h-[18px] accent-rose-400 cursor-pointer"
            checked={bpmOverridden}
            onChange={(event) => setBpmOverridden(event.target.checked)}
          />
        </label>
        <input
          id="bpm"
          className="w-full m-[4px_0_8px] accent-rose-400"
          type="range"
          min="60"
          max="200"
          value={bpm}
          onChange={(event) => setBpm(Number(event.target.value))}
          disabled={!bpmOverridden}
        />
        <p className="m-[0_0_18px] text-slate-200/80 text-[0.72rem] tracking-[0.08em] uppercase">
          {bpmOverridden ? `${bpm} BPM override` : 'Model will infer BPM'}
        </p>

        {/* Density */}
        <label className="block mb-2.5 text-slate-200/70 text-[0.74rem] font-bold tracking-[0.08em] uppercase" htmlFor="density">Density</label>
        <label className="flex items-center justify-between gap-3 m-[0_0_6px] p-[9px_12px] border border-white/12 rounded-[14px] bg-white/5 cursor-pointer" htmlFor="density-override">
          <span className="flex items-baseline gap-2">
            <span className="text-[#f8fafc] text-[0.82rem] font-bold tracking-[0.05em] uppercase">Override</span>
            <span className="text-slate-200/70 text-[0.8rem] leading-none">{densityOverridden ? density.toFixed(2) : 'Infer'}</span>
          </span>
          <input
            id="density-override"
            type="checkbox"
            className="w-[18px] h-[18px] accent-rose-400 cursor-pointer"
            checked={densityOverridden}
            onChange={(event) => setDensityOverridden(event.target.checked)}
          />
        </label>
        <input
          id="density"
          className="w-full m-[4px_0_8px] accent-rose-400"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={density}
          onChange={(event) => setDensity(Number(event.target.value))}
          disabled={!densityOverridden}
        />
        <p className="m-[0_0_18px] text-slate-200/80 text-[0.72rem] tracking-[0.08em] uppercase">
          {densityOverridden ? `${density.toFixed(2)} density override` : 'Model will infer density'}
        </p>

        {/* Brightness */}
        <label className="block mb-2.5 text-slate-200/70 text-[0.74rem] font-bold tracking-[0.08em] uppercase" htmlFor="brightness">Brightness</label>
        <label className="flex items-center justify-between gap-3 m-[0_0_6px] p-[9px_12px] border border-white/12 rounded-[14px] bg-white/5 cursor-pointer" htmlFor="brightness-override">
          <span className="flex items-baseline gap-2">
            <span className="text-[#f8fafc] text-[0.82rem] font-bold tracking-[0.05em] uppercase">Override</span>
            <span className="text-slate-200/70 text-[0.8rem] leading-none">{brightnessOverridden ? brightness.toFixed(2) : 'Infer'}</span>
          </span>
          <input
            id="brightness-override"
            type="checkbox"
            className="w-[18px] h-[18px] accent-rose-400 cursor-pointer"
            checked={brightnessOverridden}
            onChange={(event) => setBrightnessOverridden(event.target.checked)}
          />
        </label>
        <input
          id="brightness"
          className="w-full m-[4px_0_8px] accent-rose-400"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={brightness}
          onChange={(event) => setBrightness(Number(event.target.value))}
          disabled={!brightnessOverridden}
        />
        <p className="m-[0_0_18px] text-slate-200/80 text-[0.72rem] tracking-[0.08em] uppercase">
          {brightnessOverridden ? `${brightness.toFixed(2)} brightness override` : 'Model will infer brightness'}
        </p>

        {/* Toggles */}
        <label className="flex items-center justify-between gap-4 m-[8px_0_22px] p-[16px_18px] border border-white/12 rounded-[18px] bg-slate-900/40 cursor-pointer" htmlFor="vocals-enabled">
          <span className="text-slate-200/70 text-[0.74rem] font-bold tracking-[0.08em] uppercase m-0">Vocals</span>
          <input
            id="vocals-enabled"
            type="checkbox"
            className="w-[22px] h-[22px] accent-rose-400 cursor-pointer"
            checked={vocalsEnabled}
            onChange={() => toggleVocals()}
          />
        </label>

        <label className="flex items-center justify-between gap-4 m-[8px_0_22px] p-[16px_18px] border border-white/12 rounded-[18px] bg-slate-900/40 cursor-pointer" htmlFor="only-bass-and-drums">
          <span className="text-slate-200/70 text-[0.74rem] font-bold tracking-[0.08em] uppercase m-0">Only bass and drums</span>
          <input
            id="only-bass-and-drums"
            type="checkbox"
            className="w-[22px] h-[22px] accent-rose-400 cursor-pointer"
            checked={onlyBassAndDrums}
            onChange={(event) => setOnlyBassAndDrums(event.target.checked)}
          />
        </label>

        <button
          className="w-full border border-white/12 rounded-[18px] py-[14px] px-[18px] font-bold cursor-pointer transition-all hover:-translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed bg-white/10 text-slate-200"
          disabled={!isConnected}
          onClick={() => syncConfig()}
        >
          Apply settings
        </button>
      </section>
    </section>
  )
}
