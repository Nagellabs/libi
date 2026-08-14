export type AnalysisStepKind =
  | "transcript"
  | "summary"
  | "frames"
  | `script:${string}:${string}`
  | `caption_spec:${string}:${string}`;
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
  /** Stringified ElevenLabsWord[]. */
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
  Script,
  Shot,
  TranscriptWord,
  TranscriptMetadata,
  TranscriptSentence,
} from "./schemas";
