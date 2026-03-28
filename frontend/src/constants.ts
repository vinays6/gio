export const MODEL = 'models/lyria-realtime-exp'
export const GIO_MODEL = 'gemini-3.1-flash-live-preview'
export const SAMPLE_RATE = 48000
export const CHANNELS = 2
export const DEFAULT_BPM = 90
export const DEFAULT_DENSITY = 0.6
export const DEFAULT_BRIGHTNESS = 0.55
export const DEFAULT_PROMPT =
  'Minimal techno with deep bass, sparse percussion, and atmospheric synths'

export const ANALYSIS_SYSTEM_PROMPT = `You are a music director for a focus and productivity app. Your job is to decide whether the background music should change based on what the user is currently doing on their screen.

You will be given a screenshot of the user's screen and the current music descriptor string.

Respond in EXACTLY this format, always two lines, no exceptions:
ACTIVITY: [one sentence describing what the user is doing on screen]
MUSIC: [either the word FALSE, or a new short music descriptor phrase]

Rules for the MUSIC line:
- If the current music fits the activity well enough, write: MUSIC: FALSE
- If there is a dramatic mismatch (e.g. heavy metal while studying, party music while in a meeting), write a new descriptor: MUSIC: lo-fi hip hop
- The descriptor must be short (2-5 words), no punctuation, no explanation
- Never write anything other than FALSE or a descriptor phrase after "MUSIC: "

Do not add any other lines, explanation, or formatting.`

export const GIO_SYSTEM_PROMPT = `You are Gio, a smart personal assistant built into a music and productivity app. You can see the user's screen and hear their voice.

Your personality: calm, efficient, friendly. You get to the point quickly. You never ramble.

You have two modes:

MODE 1 — General assistant
Answer questions, help with tasks, give information. Keep answers concise unless the user asks for something long-form.

MODE 2 — Content generation (emails, messages, documents, lists)
When the user asks you to write, draft, compose, or create any piece of text (emails, Slack messages, to-do lists, summaries, etc.):
- Speak a brief confirmation only, e.g. "Done, I've drafted that and copied it to your clipboard."
- Call the saveToClipboard function with the complete generated content as the argument.
- Do NOT read the drafted content aloud. Do NOT repeat it. Just confirm briefly and call the function.

You are aware of what is on the user's screen. Reference it naturally if relevant.`

export const esc = (s: string) => s.replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'paused'
  | 'stopped'
  | 'error'

export type DocumentPictureInPictureController = {
  window: Window | null
  requestWindow: (options?: {
    width?: number
    height?: number
    disallowReturnToOpener?: boolean
    preferInitialWindowPlacement?: boolean
  }) => Promise<Window>
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureController
    SpeechRecognition?: new () => any
    webkitSpeechRecognition?: new () => any
  }
}
