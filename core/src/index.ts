export { Board, footprintsOverlap, slotKey, HOLDER_SLOTS } from './board.js';
export type { BoardOptions, Slot, Tile, TileId, TileInput } from './board.js';
export { facesMatch, STANDARD_144 } from './faces.js';
export { assessDifficulty, bucketDifficulty, difficultyScore, scoreDifficulty } from './difficulty.js';
export type { DifficultyAssessment, DifficultyBucket, DifficultyMetrics } from './difficulty.js';
export { generateLevel, generateValidatedLevel } from './generator.js';
export type { GeneratedLevel } from './generator.js';
export {
  solve,
  findHint,
  hasPlayableMove,
  legalPairs,
  DEFAULT_MAX_HOLD_STATES,
  DEFAULT_MAX_STATES,
} from './solver.js';
export type { SolveOptions, SolveResult, SolveVerdict } from './solver.js';
export { parseLayout, SEED_LAYOUTS } from './layouts.js';
export type { Layout, LayoutFile } from './layouts.js';
export { canMatch, matchPair } from './match.js';
export type { MatchCheck, MatchRejection } from './match.js';
export { MoveStack } from './moves.js';
export type {
  HoldMove,
  MatchMove,
  MoveBase,
  MoveRecord,
  MoveStackState,
  UnholdMove,
} from './moves.js';
export { ScoreKeeper, BASE_PAIR_POINTS, COMBO_WINDOW_MS } from './scoring.js';
export type { MatchScore, ScoreSnapshot } from './scoring.js';
export { shuffleBoard } from './shuffle.js';
