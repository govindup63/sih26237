# SIH26237

Smart India Hackathon 2026, Ministry of Defence: cryptographic attribution and immutable
decryption provenance for multi-recipient encrypted document distribution. This repo is the
working demo, images only.

**The verbatim problem statement was never found on this machine.** Everything here traces to the
team's one paragraph restatement. Confirm the real wording before relying on any claim about what
SIH26237 requires.

## The one idea

The watermark is produced *by* decryption, not applied after it. Every tile of the image is
encrypted twice, as visually identical variants A and B. An officer's key set opens exactly one
variant per tile, so the only image their keys can assemble is the one that identifies them. There
is no moment when anybody holds an unmarked copy, and no marking step a modified client could skip.
This is the ETSI TS 104 002 model, adapted to still images.

## Layout

```
server/          Bun + TypeScript. No framework.
  src/cnsa.ts        ML-KEM-1024, ML-DSA-87, SLH-DSA, AES-256-GCM, HKDF-SHA-512
  src/cards.ts       the card boundary. Secret keys live here and nowhere else
  src/variants.ts    tiles, mid-band DCT carrier, informed embedding
  src/detect.ts      blind detection, z-scored against decoy carriers
  src/seal.ts        2T encrypted boxes, per-box keys and AAD, Merkle root
  src/pipeline.ts    open and assemble, break-glass release, reconciliation
  src/ledger.ts      Merkle transparency log, 4 attesters, quorum 3
  src/merkle.ts      RFC 6962 inclusion and consistency proofs
  src/forensics.ts   tiered verdict, tiered checks
  src/store.ts       SQLite persistence
  src/world.ts       the demo world: officers, rooms, terminals
  src/server.ts      HTTP routes
web/             Vite + React 19. Pixel art drawn on canvas, no binary assets.
deploy/          Dockerfile compose, deploy.sh, tunnel.sh
```

## Running it

```bash
cd server && bun install && bun test        # 124 tests, about 90 seconds
cd server && bun run typecheck
cd server && bun run dev                    # API on 8090

cd web && npm install && npm run dev        # page on 5173, expects API on 8090
```

Deploying to the VM: `bash deploy/deploy.sh` syncs `server/` and rebuilds only the `sih26237`
container. Eight unrelated production containers share that box and must stay up; the script prints
the list after every deploy, check it. `bash deploy/tunnel.sh` opens the SSH port forward the local
frontend talks through. The API binds 0.0.0.0 inside the container because Docker's port mapping
cannot reach 127.0.0.1; exposure is bounded by the host side mapping, which is loopback only.

## Decisions worth not relitigating

- **Secret keys never leave `cards.ts`.** `CardReader.unlock(name, pin, use)` hands out a session
  that is torn down when `use` returns. The HTTP layer physically cannot sign as an officer. Before
  this existed the PIN was a plaintext compare and non-repudiation was not actually established.
- **Parameters are measured, not chosen.** `alpha 1.5`, carrier band `[0.25, 0.6]`, `z >= 3.5`, 32
  decoy carriers, 128 tiles. `server/docs/PARAMETERS.md` has the sweeps. The band was moved from
  [0.08, 0.28] because it sat below the detector's own high pass residual and only 6 of 128 tiles
  read.
- **The magnitude gate is what makes NO_WATERMARK reachable.** A sign only detector returns a full
  codeword for any image at all.
- **Codewords are stored as commitments.** Three colluders who know a fourth's codeword can frame
  him about 99.5% of the time.
- **The verdict is tiered, not threshold plus margin.** Under collusion the top two candidates are
  near tied by construction, so a margin rule returns INCONCLUSIVE almost always.
- **Forensic checks are tiered cryptographic / derived / asserted**, and the key to person binding
  is deliberately filed under asserted. Saying out loud which rows need no trust in this program is
  what makes the rest of them worth anything.
- **Everything persists**, including released copies. Without that the log holds records naming
  copies that no longer exist.
- **The deck plan is near greyscale on purpose.** State is carried by borders and lit screens, so
  the one room that lights up at the end lands.

## Not built

- Deploy automation. CI runs on every push; deploying is still `bash deploy/deploy.sh` by hand.
  Automating it needs an SSH key as a repository secret, and that host is shared with a teammate's
  own release process for the public frontend, so it is a coordination question before a technical
  one.

Tardos codes WERE built, after the reason for skipping them turned out to be wrong. The claim was
that 128 tiles is too short; `scripts/tardossweep.ts --focused` measures it instead. At cutoff 0.45
and threshold 5 the scheme catches one or two colluders essentially always and never named an
innocent officer in 18,000 trials. It is off by default (`SIH_CODEWORD_SCHEME=tardos` turns it on)
because the tiered verdict rule in `forensics.ts` is calibrated against the uniform null, and the
two schemes are not interchangeable.

## House rules

Signed commits (`-s`). No AI attribution anywhere, including commit messages. No em dashes in
documentation. Read existing code before changing it and match what is there.
