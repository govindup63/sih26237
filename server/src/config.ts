/**
 * Every tunable in one place, each overridable by environment variable so the
 * robustness report can sweep them without editing code.
 *
 * The numbers below are measured, not guessed. See docs/PARAMETERS.md for the
 * experiments behind each one.
 */
const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${raw}`)
  return parsed
}

export const CONFIG = {
  port: num('PORT', 8090),
  host: process.env.SIH_HOST_BIND ?? '127.0.0.1',
  dbPath: process.env.SIH_DB_PATH ?? './data/ledger.sqlite',

  /** Demo images are 512x512. A 16x8 grid gives 128 tiles of 32x64 px. */
  imageWidth: num('SIH_IMAGE_W', 512),
  imageHeight: num('SIH_IMAGE_H', 512),
  gridW: num('SIH_GRID_W', 16),
  gridH: num('SIH_GRID_H', 8),

  /**
   * Embedding strength in grey levels RMS. The binding constraint is PSNR
   * between variant A and variant B, not between the original and a variant:
   * A - B = 2*alpha*P, so A-vs-B lands 10-12 dB below orig-vs-variant.
   * Measured at alpha 1.5 over 128 tiles: PSNR(A,B) 42.2 dB on the textured
   * survey and 40.9 dB on the mostly-flat chart, SSIM 0.968 / 0.943, and no
   * pixel moved by more than 11 of 255. Raising it to 1.8 buys JPEG q=70 but
   * drops the flat image to SSIM 0.92, which starts to be visible as banding.
   */
  alpha: num('SIH_ALPHA', 1.5),
  /**
   * Strength follows local activity as `base + slope * activity / ref`, clamped
   * to [floorMul, capMul] times alpha. The base is what a completely flat tile
   * gets, and it is deliberately non-zero: a tile with no mark at all would be a
   * genuinely unattributable region, and "no unmarked pixel is ever transmitted"
   * has to hold for every tile or it holds for none.
   */
  alphaBase: num('SIH_ALPHA_BASE', 0.4),
  alphaSlope: num('SIH_ALPHA_SLOPE', 0.9),
  alphaFloorMul: num('SIH_ALPHA_FLOOR_MUL', 0.35),
  alphaCapMul: num('SIH_ALPHA_CAP_MUL', 2.0),
  activityRef: num('SIH_ACTIVITY_REF', 12),
  activityWindow: num('SIH_ACTIVITY_WINDOW', 7),

  /**
   * Mid-band carrier, as a fraction of Nyquist on each axis.
   *
   * This band was measured, not chosen. At [0.08, 0.28] the carrier sat below
   * the detector's own high-pass residual and only 6 of 128 tiles were readable
   * on a clean image: the detector was filtering away its own signal. Sweeping
   * the band against the full attack suite put [0.25, 0.6] ahead on blur (107
   * readable), 50% resize (75) and the compound JPEG-plus-resize case (53),
   * while still reading nothing at all on an unmarked image.
   */
  bandLo: num('SIH_BAND_LO', 0.25),
  bandHi: num('SIH_BAND_HI', 0.6),

  /** Detection. The sign of a correlation is always +/-1, so magnitude is what
   *  distinguishes a marked tile from an unmarked one. Each tile is z-scored
   *  against decoy carriers; measured |z| is 6-32 for marked tiles and ~0.7 for
   *  unmarked ones or the wrong document's carrier. */
  decoyCount: num('SIH_DECOYS', 32),
  zThreshold: num('SIH_Z_THRESHOLD', 3.5),
  residualWindow: num('SIH_RESIDUAL_WINDOW', 5),

  /** Verdict tiers. A confident wrong name is the only unacceptable outcome. */
  minReadable: num('SIH_MIN_READABLE', 32),
  tier1Tau: num('SIH_TIER1_TAU', 0.2),
  /**
   * How far clear of the next officer the match has to be. This is a gap, not an
   * absolute bar on the runner-up: with 128 tiles a non-owner's error rate is
   * 50% +/- 4.4%, so an innocent officer lands near 35% roughly once in six
   * thousand and an absolute floor there refuses to name anyone when they do.
   * A gap of 0.15 is about 6.8 standard deviations of that null.
   */
  tier1Margin: num('SIH_TIER1_MARGIN', 0.15),
  tier1Clear: num('SIH_TIER1_CLEAR', 0.35),
  tier2Margin: num('SIH_TIER2_MARGIN', 5),
  tier2MaxSetSize: num('SIH_TIER2_MAX_SET', 2),
} as const

export const TILES = CONFIG.gridW * CONFIG.gridH

export function configSummary() {
  return { ...CONFIG, tiles: TILES }
}
