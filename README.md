# SIH26237: traceable classified release

One image is encrypted once and distributed to several officers. Each officer's copy is forensically
unique but looks identical to every other copy. Every opening is signed with a post-quantum key and
committed to an offline transparency log. A leaked image traces back to whoever opened it.

Built for Smart India Hackathon 2026, problem statement SIH26237 (Ministry of Defence).

**One caveat up front:** the verbatim problem statement was never available while this was built.
Everything here follows a one paragraph restatement of it. Check the real wording before treating
any claim below as a claim about what SIH26237 asks for.

## The idea that makes this different

Most watermarking systems decrypt a document and then stamp it. That means there is a moment when
the recipient's machine holds an unmarked copy, and a modified client can simply skip the stamping
step.

Here the mark is produced *by* the decryption. Every tile of the image is encrypted twice, as two
visually identical variants. An officer's key set opens exactly one variant per tile, so the only
image their keys can assemble is the one that identifies them. There is no unmarked intermediate,
and nothing to skip. This is the ETSI TS 104 002 approach used against video piracy, adapted to
still images.

## What it does

- **Seal.** The commanding officer picks an image and a distribution list. One package goes out, with
  a key bundle per recipient. The package commits to a Merkle root over all 256 encrypted boxes.
- **Open.** An officer inserts their card, enters a PIN, and their workstation assembles the only
  image their keys allow. The ledger append happens before any bytes are released, so no receipt
  means no copy.
- **Compare.** Two officers' copies sit side by side. You will not tell them apart. An amplification
  slider, labelled with its factor, shows you what you could not see.
- **Damage.** Compress it, blur it, resize it, crop it, or average two officers' copies together.
- **Trace.** Feed the damaged file back in and get a name, or get silence, along with everything
  needed to disagree with the answer.

## Running it

You need [Bun](https://bun.sh) and Node.

```bash
cd server
bun install
bun test           # 124 tests, about 90 seconds
bun run dev        # API on http://localhost:8090
```

```bash
cd web
npm install
npm run dev        # page on http://localhost:5173
```

The page expects the API on 8090. If you are running the backend on a remote machine instead, open
an SSH port forward to it first and the page will find it at the same address.

### Deploying the backend

`deploy/deploy.sh` syncs `server/` to a host, rebuilds one container, and prints every container
still running afterwards so you can confirm nothing else was disturbed. Set `SIH_HOST` and
`SIH_REMOTE_DIR` for your own host. The API binds `0.0.0.0` inside the container because Docker's
port mapping cannot reach `127.0.0.1` from outside it; the host side mapping is loopback only, so
the API never lands on a public interface.

## Cryptography

Everything is CNSA 2.0, via [@noble/post-quantum](https://github.com/paulmillr/noble-post-quantum).

| | |
|---|---|
| Key encapsulation | ML-KEM-1024 (FIPS 203) |
| Signatures | ML-DSA-87 (FIPS 204), SHA-512 prehash |
| Long term anchors | SLH-DSA-SHA2-128f (FIPS 205) |
| Encryption | AES-256-GCM |
| Key derivation | HKDF-SHA-512 |

No classical signatures anywhere, which is why Hyperledger Fabric was not an option: its default
signatures are ECDSA.

Officer secret keys live inside `server/src/cards.ts` and nowhere else. `CardReader.unlock(name,
pin, use)` hands out a session that is destroyed as soon as `use` returns, so the HTTP layer cannot
sign as an officer even if it wanted to. That shape is deliberate: `unlock` is the PKCS#11 login
boundary, and swapping in a real hardware token replaces that one file.

## The ledger

Four attester nodes in four places under four custodians, quorum of three. Sized as 3f+1 to survive
one hostile operator, not just one that crashed.

- Records are leaves in a Merkle transparency log with RFC 6962 inclusion and consistency proofs.
- Each node writes an equivocation lock to disk *before* producing a signature, so a node that
  signed and then crashed cannot come back and sign something different at the same height.
- Signed tree heads are anchored with both ML-DSA and SLH-DSA and taken out of custody. Without an
  anchor, four machines that all agree can still be rewritten together by whoever holds all four.
- Enrolment and revocation are records in the log, so a signature is checked against the officer's
  standing *at the height it was made*. Revoking a card does not invalidate what it signed before.
- When quorum cannot be reached, a single use break-glass token issued in advance releases the copy
  and the release reconciles into the log when the attesters come back. Without a path like this,
  the first time an officer cannot read an operational order the system gets switched off.

## Measurements

512x512 images, 16x8 grid of 128 tiles, alpha 1.5, carrier band [0.25, 0.6] of Nyquist. Full
sweeps and the two constructions that did not work are in [server/docs/PARAMETERS.md](server/docs/PARAMETERS.md).

| | textured survey | mostly flat chart |
|---|---|---|
| PSNR between two officers' copies | 42.0 dB | 40.0 dB |
| SSIM | 0.966 | 0.934 |
| largest pixel change | 10 / 255 | 13 / 255 |
| tiles readable, clean copy | 128 / 128 | 127 / 128 |
| tiles readable, unmarked image | 0 / 128 | 0 / 128 |

Survives noise to sigma 10, JPEG down to q=70, blur, 50% resize, brightness and contrast changes,
posterize, and JPEG q=80 followed by 50% resize, with zero wrong bits among readable tiles in every
case.

### Where it fails, asserted as tests rather than hidden

- JPEG below about q=70 falls under the readable floor and the answer is silence, not a guess.
- A centred crop keeps the aspect ratio, so registration cannot refuse it. At a 4px crop only 14
  tiles read, with 6 wrong bits. What protects the verdict there is the floor of 32 readable tiles,
  not the per tile confidence gate.
- Two officers who average their copies are reported as a set. Neither is separated from the other.

## Reading a verdict

The finding is written as a proposition about a *file*, never about a person's conduct:

> The exhibit is the copy issued to Cdr nair, rather than a copy issued to any of the other 8
> officers.

Not "nair leaked it". The system establishes whose copy something is. It cannot establish who
transmitted it. Forensic reporting practice calls this the source level and activity level
distinction, and running the two together is the fastest way to lose a knowledgeable room.

Every officer stays on the candidate chart with a zero based axis and a drawn threshold, because the
evidence is the distance between the closest officer and the rest. The flat bars are the exhibit.

Checks are tiered by how much you have to trust this program:

- **Cryptographic.** Signatures, Merkle paths, quorum. Holds on its own; anyone with the published
  public keys can redo them without this code.
- **Derived.** Measurements this program made. Another implementation of the detector should
  reproduce them.
- **Asserted.** That a key set belongs to a particular person. This comes from how the card was
  issued and no cryptography establishes it.

## Not built

- Tardos collusion secure codes. Symmetric Tardos needs roughly 272 tiles for c=2 at eps=1e-3
  against the 128 used here, and the two tier set rule already identifies the whole colluding set.
- A public DNS record to turn the deployed demo into a link for reviewers.

## Layout

```
server/src/      the whole system. No framework.
server/test/     124 tests, including the failure modes above
server/docs/     how every parameter was measured
server/scripts/  the sweeps that produced those parameters
web/src/         Vite + React. The pixel art is string arrays, no binary assets
deploy/          Dockerfile, compose, deploy and tunnel scripts
```
