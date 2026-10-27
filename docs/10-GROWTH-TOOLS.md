# Growth tools: pilot trials, KPI report, film mode

Why: the marketing plan ([09](09-MARKETING-STRATEGY.md)) has two gaps.
- The allowlist should be earned by flying the Proving Grounds, but guest runs were not recorded and nobody owns an agent before the mint, so nothing measured them.
- The hero video (browser run next to the real SO-101) needed ad-hoc screen recording.

## 1. Pilot trials (pre-mint, no agent needed)

A guest flies the mission, then signs the run with **any wallet** (free EIP-712, no gas). The verifier replays it deterministically and ranks the best verified time per wallet. Nothing goes on-chain.

- `GET /trial/challenge?wallet=0x…` → `{ challengeId, seed, expiresAt }`.
  - Server-random seed, single use, 10-minute TTL.
  - Rate limit: 120 per hour per IP.
- `POST /trial/episodes { episode, signature, deadline }`. The episode has `tokenId: 0`. Checks, in order:
  1. challenge exists, is a trial, unused, not expired;
  2. actions valid;
  3. canonical episode rebuilt server-side;
  4. not faster than real time;
  5. signature by the challenge's wallet (EOA or ERC-1271);
  6. then the per-wallet quota (30 per hour), charged only on signed submissions.
- Typed data: domain `{ name: "OpenForge Pilot Trials", version: "1", chainId }`, type `Trial(address wallet, bytes32 challengeId, bytes32 episodeHash, string mission, string sim, uint256 deadline)`.
  - The domain name and primary type differ from `Run`, so a trial signature can never be replayed as an agent run, nor the reverse.
  - No `verifyingContract`: trials run before any deployment.
- Storage: `DATA_DIR/trials/<wallet>.json` → `{ wallet, runs, successes, bestSeconds, bestDataHash, firstAt, lastAt }`. The episode is kept for the best run only.
- `GET /trial/leaderboard` → top 100 by best time; ties go to whoever was first.
- `GET /stats` → aggregate counters only, no personal data beyond public addresses already on the leaderboard:
  - trials submitted and unique trial wallets;
  - verified runs and unique pilots;
  - runs attested on-chain.
- **Trials-only mode:** if `deployment.json` has no `agents` address (pre-deploy), the verifier serves only `/health`, `/stats` and `/trial/*`.
- Site: in the arena, a guest who is connected sees "Submit to the pilot ranking" after a successful run. A "Pilot ranking" panel shows the top 10.

**Honest limits (ECC security review, 2026-10-26).** The gate is a speed bump, not proof of a human: the mission is deterministic, so a scripted solver can qualify. Per-network limits apply:
- 10 new wallets per day;
- IPv6 grouped by /64;
- the rightmost `X-Forwarded-For` entry behind the proxy, so configure the proxy to append or overwrite it.

Abuse controls:
- 60 submissions per hour per network, before any parsing or RPC call;
- 3 bad signatures retire a mission;
- open missions are recycled per network, so nobody can lock out someone else's wallet;
- caps on missions and pilots.

The human review of the export stays mandatory.

### Running the pilot ranking before the deploy

1. Create a deployment file with only the chain: `{ "chainId": 1 }`. Do not use `web/deployment.json` if the site still points at a demo.
2. Host the verifier with:
   - `DEPLOYMENT_FILE=<that file>`;
   - `ALLOWED_ORIGIN=https://<site>`;
   - `TRUST_PROXY=true`;
   - a persistent `DATA_DIR`.

   It starts in trials-only mode.
3. Put its https URL as `provingApi` in `web/deployment.json`. The arena then shows the Pilot ranking to guests with a wallet.
4. At allowlist time, run `npm run trials:export -- <DATA_DIR>` and review `allowlist-candidates.csv`:
   - one spot per cluster;
   - check the fastest submit times;
   - replay any best run from `/trial/episodes/<hash>`.

   Then upload the final list in OpenSea Studio.
5. After the deploy, swap in the real deployment file and restart. Trials keep running, and agent runs and attestations switch on.

Tested in `test/ProvingServer.test.js`:
- replay verification;
- domain separation from agent runs, both ways;
- single-use challenges;
- auditable best runs;
- `/stats` caching;
- trials-only mode.

## 2. KPI report

`npm run kpi -- <network>` prints a table and writes `kpi-<chainId>-<date>.json`.
- **On-chain:** minted; unique holders; agent wallets with an operator configured; wallets locked for sale; real attestations (tasks); sim runs attested.
- **Verifier** (`PROVING_API`): trial submissions and wallets; verified runs; pilots.
- **Site traffic:** use the host's cookie-less analytics (Cloudflare Web Analytics, toggle in the Pages dashboard; no code, no cookie banner).

## 3. Film mode and clip recording

- Shared module `web/js/recorder.js`. It composes one or two sources (a `<canvas>`, optionally a `<video>` from the camera) onto an offscreen canvas at 30 fps, with title and lower-third text. It records with `MediaRecorder` (WebM, VP9 or VP8) and offers a download.
  - Nothing is uploaded.
  - The camera is used only after an explicit click, and the stream stops when filming ends.
- **Robot Link, "Film mode":** twin on the left, phone or webcam on the right, the title "Browser run → real SO-101" and a run timer. It records the whole play, from Play until it ends or STOP.
- **Proving Grounds, "Record clip":** records the next run or demo, with the title "OpenForge AX · Proving Grounds".
- The `Permissions-Policy` header must allow `camera=(self)`.
