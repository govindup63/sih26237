/**
 * Does Tardos work at 128 tiles?
 *
 * The claim used to justify leaving it out was that a symmetric Tardos code needs
 * a few hundred tiles for two colluders at a false-accusation rate of 1e-3, and
 * this system has 128. That was an assertion, not a measurement, and the rest of
 * this codebase does not run on assertions. So: simulate it.
 *
 * The attack model is the one this system actually faces. Colluders compare their
 * copies; where they agree the tile survives with that value, and where they
 * disagree the carrier cancels under averaging and the tile stops being readable.
 * That is weaker than the textbook marking assumption, which lets colluders choose
 * a value on every position where they differ, so both are measured here.
 *
 *   bun run scripts/tardossweep.ts
 */
import { tardosAccuse, tardosBiases, tardosCodeword } from '../src/tardos.ts'
import { sha512, utf8 } from '../src/bytes.ts'

type Attack = 'erase' | 'choose' | 'majority'

function trial(
  tiles: number,
  officers: number,
  colluders: number,
  cutoff: number,
  threshold: number,
  attack: Attack,
  seed: number,
): { caught: number; framed: number; silent: boolean } {
  const docKey = sha512(utf8(`tardos-sweep-${seed}`)).subarray(0, 32)
  const docId = `doc-${seed}`
  const biases = tardosBiases(docKey, docId, tiles, cutoff)

  const issued = Array.from({ length: officers }, (_, i) => {
    const fp = `officer-${i}`
    return { name: fp, fp, codeword: tardosCodeword(docKey, docId, fp, biases) }
  })

  // The first `colluders` officers conspire. Everyone else is innocent.
  const guilty = issued.slice(0, colluders)
  const recovered = new Uint8Array(tiles)
  const mask = new Uint8Array(tiles)

  for (let i = 0; i < tiles; i++) {
    const bits = guilty.map((g) => g.codeword[i])
    const agree = bits.every((b) => b === bits[0])
    if (agree) {
      recovered[i] = bits[0]
      mask[i] = 1
      continue
    }
    if (attack === 'erase') {
      // What averaging really does: the carrier cancels and nothing is readable.
      mask[i] = 0
      continue
    }
    if (attack === 'majority') {
      const ones = bits.filter((b) => b === 1).length
      recovered[i] = ones * 2 > bits.length ? 1 : 0
      mask[i] = 1
      continue
    }
    // Textbook marking assumption: pick whichever value hurts them least, which
    // for the symmetric score is the common one.
    recovered[i] = biases[i] > 0.5 ? 1 : 0
    mask[i] = 1
  }

  const scored = tardosAccuse(recovered, mask, issued, biases, { cutoff, threshold })
  const accused = scored.filter((s) => s.accused)
  const guiltySet = new Set(guilty.map((g) => g.fp))
  return {
    caught: accused.filter((a) => guiltySet.has(a.fp)).length,
    framed: accused.filter((a) => !guiltySet.has(a.fp)).length,
    silent: accused.length === 0,
  }
}

function run(tiles: number, colluders: number, cutoff: number, threshold: number, attack: Attack, trials: number) {
  let anyCaught = 0
  let framedTrials = 0
  let silentTrials = 0
  for (let s = 0; s < trials; s++) {
    const r = trial(tiles, 12, colluders, cutoff, threshold, attack, s)
    if (r.caught > 0) anyCaught++
    if (r.framed > 0) framedTrials++
    if (r.silent) silentTrials++
  }
  return {
    caught: anyCaught / trials,
    framed: framedTrials / trials,
    silent: silentTrials / trials,
  }
}

const FOCUSED = process.argv.includes('--focused')
const TRIALS = FOCUSED ? 2000 : 400
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

console.log('12 officers, %d trials per cell. "caught" = at least one real colluder named.', TRIALS)
console.log('"framed" = at least one innocent officer named. Framing is the number that matters.\n')

const TILESET = FOCUSED ? [128] : [128, 256, 512]
const CUTOFFS = FOCUSED ? [0.25, 0.3, 0.35, 0.4, 0.45] : [0.05, 0.15, 0.3]
const THRESHOLDS = FOCUSED ? [4, 5, 6, 7] : [6, 8, 10.5, 13]

for (const attack of ['erase', 'majority', 'choose'] as Attack[]) {
  console.log(`--- attack: ${attack}`)
  console.log('tiles  c  cutoff  thresh   caught   framed   silent')
  for (const tiles of TILESET) {
    for (const colluders of [1, 2, 3]) {
      for (const cutoff of CUTOFFS) {
        for (const threshold of THRESHOLDS) {
          const r = run(tiles, colluders, cutoff, threshold, attack, TRIALS)
          // Only print rows that never framed anybody, plus the best of the rest.
          if (!FOCUSED && r.framed > 0 && r.caught < 0.99) continue
          console.log(
            `${String(tiles).padStart(5)}  ${colluders}  ${cutoff.toFixed(2).padStart(6)}  ${threshold
              .toFixed(1)
              .padStart(6)}  ${pct(r.caught).padStart(7)}  ${pct(r.framed).padStart(7)}  ${pct(r.silent).padStart(7)}`,
          )
        }
      }
    }
  }
  console.log()
}
