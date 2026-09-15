# How the parameters were chosen

Every number in `src/config.ts` came out of a measurement. The scripts that produced
them are in `scripts/` and can be re-run at any time. This file records what was
measured, what it showed, and what got rejected along the way.

All figures below: 512x512 images, a 16x8 grid of 128 tiles at 32x64 px each, five
officers, `bun run scripts/<name>.ts`.

## Two constructions that did not work

**Naive antipodal embedding.** The obvious scheme is `variant = tile ± alpha·P`, read
back as the sign of the correlation. It fails. A natural tile has its own projection
onto the carrier, measured here at `h = -2.75` against an alpha of about 1.2. Both
variants then land on the same side of zero and the sign carries no information at
all. The fix is to cancel the host term at embed time: variant A is displaced by
`(alpha - h)` and variant B by `(-alpha - h)`, which forces the projections to exactly
`+alpha` and `-alpha` whatever is underneath. `test/variants.test.ts` asserts this
directly.

**A low-pass carrier.** With the host projection cancelled, a low-pass carrier makes
the two variants wildly asymmetric: at `h = 2.75` and alpha 3, variant A moves by 5.75
and variant B by 0.25, so one officer's copy scores 32.9 dB and another's 56.5 dB
against the same original. Moving to a band-pass carrier dropped `|h|` from 2.746 to
0.450, a factor of six, and the asymmetry with it.

## Carrier band: measured, not assumed

The first working band, `[0.08, 0.28]` of Nyquist, read only **6 of 128 tiles** on a
clean copy. The cause was a frequency collision: that band sits at 0.04 to 0.14
cycles per pixel, and the detector's own high-pass residual removes everything below
roughly 0.1. The detector was filtering away its own signal.

Sweeping the band against the full attack suite (`scripts/bandsweep.ts`), readable
tiles out of 128:

| attack | 0.15-0.45 | 0.2-0.55 | **0.25-0.6** | 0.3-0.7 | 0.35-0.8 |
|---|---|---|---|---|---|
| clean | 78 | 123 | **126** | 128 | 128 |
| jpeg q=90 | 62 | 119 | **119** | 123 | 122 |
| jpeg q=80 | 35 | 64 | **57** | 41 | 13 |
| blur r=1 | 51 | 81 | **107** | 94 | 65 |
| resize 50% | 53 | 63 | **75** | 73 | 68 |
| jpeg q=80 + resize 50% | 36 | 42 | **53** | 32 | 10 |
| unmarked image | 0 | 0 | **0** | 1 | 1 |

`[0.25, 0.6]` wins on blur, on 50% resize, and on the compound attack that models a
realistic leak, while still reading nothing at all on an unmarked image. Higher bands
look better on clean images and collapse under compression, which is the trade the
sweep exists to expose.

**Codeword errors were zero in every cell of that table.** Tiles either read correctly
or fall below the confidence gate; a readable tile carrying a wrong bit did not occur
under any photometric attack.

## Strength: bounded by A-vs-B, not by A-vs-original

The binding quality constraint is the distance between the two variants, not between
a variant and the original. `A - B` is twice the carrier, so it always scores worse.
Quoting PSNR against the original would have flattered the result by 10 to 12 dB.

At band `[0.25, 0.6]` (`scripts/alphasweep.ts`), readable tiles out of 128:

| | alpha 1.2 | **alpha 1.5** | alpha 1.8 | alpha 2.1 |
|---|---|---|---|---|
| jpeg q=80 | 62 | **121** | 128 | 128 |
| jpeg q=70 | 8 | **59** | 118 | 128 |
| resize 50% | 78 | **94** | 114 | 123 |
| jpeg q=80 + resize 50% | 53 | **79** | 100 | 117 |
| PSNR(A,B), textured | 44.1 | **42.2** | 40.7 | 39.3 |
| SSIM(A,B), flat chart | 0.961 | **0.943** | 0.922 | 0.900 |

**alpha = 1.5.** Going to 1.8 buys JPEG q=70 but drops the flat image to SSIM 0.92,
where the mark starts to show as banding in smooth areas. SSIM is what catches this;
PSNR alone still looks fine at that strength.

Measured at alpha 1.5:

| | textured survey | mostly-flat chart |
|---|---|---|
| PSNR(original, copy) | 44.7 dB | 43.4 dB |
| SSIM(original, copy) | 0.982 | 0.966 |
| PSNR(A, B) | 42.0 dB | 40.0 dB |
| SSIM(A, B) | 0.966 | 0.934 |
| largest pixel change | 10 / 255 | 13 / 255 |
| clean readable tiles | 128 / 128 | 127 / 128 |
| unmarked image readable | 0 / 128 | 0 / 128 |

## The confidence gate, and why silence is a feature

The sign of a correlation is always defined, so a detector built on sign alone hands
back a complete 128-bit codeword for a photograph of a cat. With five officers, the
nearest of five random codewords to a random reading sits around 26 bits away, close
enough to a threshold to name an innocent person.

So magnitude decides readability, and magnitude only means something relative to what
an arbitrary pattern scores on the same image. Each tile's carrier is z-scored against
32 decoy carriers drawn from a fixed public seed:

| | measured |z| |
|---|---|
| marked tile, textured | 6.3 |
| marked tile, flat | 32.4 |
| unmarked tile | 0.63 |
| marked copy, wrong document's carrier | 0.76 |

The gate sits at 3.5, roughly five times the noise floor and half the weakest real
signal. Clean copies read 128/128; unmarked images, pure noise, flat colour fields and
never-sealed fixtures read 0.

A degenerate case had to be handled explicitly: a perfectly uniform tile has no
residual, so both the real score and the decoy spread are floating-point dust, and
dividing one by the other manufactures a large z from nothing. Such tiles are
unreadable by definition.

## Known limits, stated rather than hidden

**JPEG below about q=70.** At q=50 only 7 of 128 tiles read. That is below the floor
of 32, so the verdict is silence, not a wrong name. Asserted as a test.

**Centred crops.** Registration compares aspect ratio, which catches a one-sided crop
but not a centred one: trimming the same margin from all four sides leaves the ratio
unchanged. The image then lands on the grid misaligned, and this is the single case
where a tile can read as confidently readable and still be wrong. Measured:

| crop | readable | wrong bits among readable |
|---|---|---|
| 1 px | 89 | 0 |
| 4 px | 14 | **6** |
| 8 px | 2 | 0 |
| 16 px+ | 0 | 0 |

The per-tile gate does not protect the verdict here. The floor on how many tiles must
be readable does: 14 is below 32, so the answer is INSUFFICIENT. This is why the floor
exists and why it is not merely a tidiness threshold.

**Collusion.** Not yet measured in this codebase; the attack functions exist in
`src/attacks.ts` and the verdict tiers that use them are Phase 4.
