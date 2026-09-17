/** One timed token from an STT engine, in seconds. Local Whisper emits
 *  `type: "word"` with `speaker_id: null`; a diarizing provider saved through
 *  Path B (analysis_save_audio_chunk) may carry `spacing` / `audio_event`
 *  tokens and real speaker ids. Same shape as `transcriptWordSchema`. */
export interface SttWord {
  text: string;
  start: number;
  end: number;
  type?: "word" | "spacing" | "audio_event";
  speaker_id?: string | null;
}

/** The per-chunk result every STT path produces before it is saved. */
export interface SttTranscription {
  language_code: string;
  language_probability: number;
  text: string;
  words: SttWord[];
}

export type AnalysisStepKind =
  | "transcript"
  | "summary"
  | "frames";
export type AnalysisStepStatus = "not_started" | "ready" | "failed";

export interface AnalysisStep {
  id: string;
  fileId: string;
  pieceId: string | null;
  kind: AnalysisStepKind;
  status: AnalysisStepStatus;
  /** Transcript: plain text. Summary: stringified VideoSummary JSON. Frames: null. */
  content: string | null;
  /** Stringified JSON metadata (provider/model/segments for transcript, etc). */
  metadata: string | null;
  errorMessage: string | null;
  sourceModifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnalysisKeyframe {
  id: string;
  fileId: string;
  stepId: string;
  filePath: string;
  frameIndex: number;
  /** Seconds. */
  timestamp: number;
  /** Stringified FrameDescription JSON. Null when skipped. */
  description: string | null;
  skipped: boolean;
  skipReason: string | null;
  /** Stringified JSON freeform bag. */
  custom: string | null;
  sourceModifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnalysisAudioChunk {
  id: string;
  fileId: string;
  stepId: string;
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  filePath: string | null;
  status: AnalysisStepStatus;
  text: string | null;
  /** Stringified SttWord[]. */
  words: string | null;
  language: string | null;
  languageProbability: number | null;
  errorMessage: string | null;
  sourceModifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Returned by `getAnalysis`. */
export interface AnalysisBundle {
  steps: AnalysisStep[];
  keyframes: AnalysisKeyframe[];
  audioChunks: AnalysisAudioChunk[];
  /** Keyframes whose source_modified_at is older than the file's current mtime. */
  staleKeyframeIds: string[];
}

export type {
  FrameDescription,
  VideoSummary,
  TranscriptWord,
  TranscriptMetadata,
  TranscriptSentence,
} from "./schemas";
