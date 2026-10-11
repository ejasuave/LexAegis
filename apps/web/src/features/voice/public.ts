export { VoiceController, DEFAULT_LANGUAGE, MAX_CAPTURE_MS } from './recognition';
export type { CapturePhase, VoiceCapability, VoiceSnapshot } from './recognition';
export { ReadAloudController, MAX_READ_CHARS, toPlainText } from './read-aloud';
export type { PlaybackState, ReadAloudSnapshot } from './read-aloud';
export { browserRecognitionAdapter, browserSynthesisAdapter } from './adapter';
export type { RecognitionAdapter, SynthesisAdapter, VoiceInfo } from './adapter';
