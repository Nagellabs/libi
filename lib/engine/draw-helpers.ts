import * as animation from "./animation";
import * as beats from "./beat-helpers";
import * as drawing from "./drawing";
import * as captionLogic from "./text-anim/caption-logic";

/** Shared bag of animation + drawing helpers injected into AI-generated draw
 *  functions. Used by both scene draw functions and code overlays. */
export const DRAW_HELPERS: Record<string, unknown> = {
  interpolate: animation.interpolate,
  spring: animation.spring,
  linear: animation.linear,
  easeIn: animation.easeIn,
  easeOut: animation.easeOut,
  easeInOut: animation.easeInOut,
  easeInCubic: animation.easeInCubic,
  easeOutCubic: animation.easeOutCubic,
  easeInOutCubic: animation.easeInOutCubic,
  easeInBack: animation.easeInBack,
  easeOutBack: animation.easeOutBack,
  easeOutElastic: animation.easeOutElastic,
  stagger: animation.stagger,
  drawSvg: drawing.drawSvg,
  drawRoundedRect: drawing.drawRoundedRect,
  drawGradient: drawing.drawGradient,
  drawTextBlock: drawing.drawTextBlock,
  drawCircle: drawing.drawCircle,
  loadImage: drawing.loadImage,
  svgToImage: drawing.svgToImage,
  // Beat helpers (added 2026-05-20 for beat-synced animations)
  nearestBeat: beats.nearestBeat,
  beatPulse: beats.beatPulse,
  // Word-driven caption timing (used by the speech-captions style templates AND
  // any custom code/three caption overlay — all element-local, lead-aware, and
  // the SAME functions the built-in reveal renderer uses). Pass the overlay's
  // `words` (injected into the draw scope) + element-local `time`.
  cumulativeLabel: captionLogic.cumulativeLabel,
  currentWord: captionLogic.currentWord,
  activeWordIndex: captionLogic.activeWordIndex,
  fadeWordsAlphaByTime: captionLogic.fadeWordsAlphaByTime,
  typewriterRevealedText: captionLogic.typewriterRevealedText,
  typewriterVisibleGlyphCount: captionLogic.typewriterVisibleGlyphCount,
};
