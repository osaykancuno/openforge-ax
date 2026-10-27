# Launch Checklist: OpenForge AX on Ethereum + OpenSea

> Rationale for each decision: [01-ANALYSIS.md](01-ANALYSIS.md). Art, metadata and code are CC0; no external legal review is planned (decision of 2026-10-25). The "no promise of returns" wording stays on every page and in the OpenSea description.

Legend: 🧑 = you (keys, funds, accounts; not delegable) · 🤖 = ready in the repo

Commands are written for **PowerShell** (Windows). Set a variable for one command like this: `$env:IMAGES_CID="bafy…"; npm run finalize:mainnet`. Clear it afterwards with `Remove-Item Env:IMAGES_CID`.

## 0. Prerequisites

- [x] 🤖 **License**: CC0 1.0 for art, metadata and code (`LICENSE`, `web/license.html`, `license` field on-chain and in `contractURI`). Nothing to fill in.
- [ ] 🧑 **Safe** multisig (safe.global), for example 2-of-3 with keys on different devices, as `OWNER`. Use a second Safe, or the same one, as `TREASURY`: it receives mint proceeds and royalties.
- [ ] 🧑 **Deploy wallet**: a fresh key used only for the deploy. Fund it with about 2× the deploy cost measured on Sepolia (see §1). Its key goes only in the local `.env`, never in chat or git.
- [ ] 🧑 Accounts: RPC provider (Alchemy/Infura), Etherscan API key, Pinata (`PINATA_JWT`), a domain, and static hosting that reads `web/_headers` (Cloudflare Pages or Netlify). Robot Link needs HTTPS.
- [ ] 🧑 **Audit**: an independent human audit is strongly recommended, starting with `AgentAccount` (one immutable implementation for all 1,024 wallets). If you skip it, publish a bug bounty and say so.

## 0b. Pre-launch audit (2026-10-26): what it left for launch day

Four ECC audits ran (contracts and launch scripts, verifier and servers, website, secrets/PII). No CRITICAL or HIGH issue remains in code. These items are operational and are checked again on launch day:

- [x] 🤖 **Provenance**: the art was declared final on 2026-10-27 and `npm run assets` ran then, so `PROVENANCE_HASH` is current. If the art or the traits change again, run it again. `deploy.js` now recomputes the generator hash on mainnet and refuses a stale `PROVENANCE_HASH` (it is locked at the first mint).
- [ ] 🧑 **Supply values are explicit**: on mainnet `deploy.js` requires `MAX_SUPPLY=1024`, `TEAM_RESERVE=100`, `ROYALTY_BPS` (0-1000), `REVEAL_DEADLINE_DAYS` (7-45), `PUBLIC_PRICE_ETH` and `MAX_PER_WALLET` in `.env`. No silent defaults.
  - Since the 2026-10-27 audit it also requires `OPENSEA_FEE_BPS` (500–2000, check Studio), a `PUBLIC_START` in the future and a `PUBLIC_END` at least 3 days before the reveal deadline (both unix seconds).
  - A price other than 0.015 or a cap other than 3 is refused unless `CONFIRM_PRICE` / `CONFIRM_MAX_PER_WALLET` repeat the value.
- [ ] 🧑 **The contracts changed on 2026-10-27** (wallet-bound sale lock, reveal seed without `blockhash`): run the Sepolia rehearsal again with `REHEARSAL_PIN=yes` before mainnet.
- [ ] 🧑 **Ownership**: the Safe must call `acceptOwnership` on all three contracts (Ownable2Step) before the drop opens. Keep the deploy key on a minimal balance until then.
- [ ] 🧑 **Reserve before the end of the public phase** (see §3 step 4): an unminted reserve is lost if anyone commits the reveal at the deadline.
- [ ] 🤖 **Smoke test**: `npm run site:smoke` must report 140/140 (every page, 3 viewports, both themes: no page errors, no 4xx, no page scroll, no horizontal overflow, no sound before a gesture).
- [ ] 🧑 **Comprehension test** with 5 people ([16-COMPREHENSION-TEST.md](16-COMPREHENSION-TEST.md)): at least 4 of 5 right on every question.
- [ ] 🧑 **Site config**: `web/deployment.json` must come from the real deploy (`npm run site:check -- 1` refuses chain 31337, localhost and `#` links). Then `npm run web:build`: the CSP lists loopback hosts only for the local demo.
- [ ] 🧑 **Headers on the live host**: `curl -I https://<site>/arena.html` must show `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, HSTS and nosniff from `web/_headers`. On a host that ignores `_headers`, the pages hide themselves when framed (fallback in `theme-boot.js`), but set the headers anyway.
- [ ] 🧑 **Publish from a clean tree**: `git init`, then check `git status --ignored` before the first commit. `.gitignore` keeps out `.env`, `.claude/`, `coverage.json`, `data/`, `art/out*`, `web/demo-images/` and rehearsal logs.
- [ ] 🧑 **Verifier host**: behind a reverse proxy, bind the servers to 127.0.0.1 and set `TRUST_PROXY` ([06-SELF-HOSTING.md](06-SELF-HOSTING.md)). Set an `ADMIN_TOKEN` of at least 32 characters, or let the server print a random one.
- [ ] 🤖 **Disclosed, by design**: royalty info and the contract URI stay changeable by the owner after `freezeMetadata` (token metadata does not). The reveal seed resists a single block producer but is not unbiasable against one who proposes both `revealBlock` and `revealBlock + 1`: say so in the docs and FAQ, never claim "provably fair".

## 1. Dry run on Sepolia (the whole launch, end to end)

- [x] 🤖 Local suite: `npm test` (130 tests, Solidity branch coverage 92%) and the local demo ([docs/07-LOCAL-TEST.md](07-LOCAL-TEST.md)).
- [x] 🤖 Mainnet fork: `npm run test:fork` (5 tests). `npm run deploy:fork` rehearses the mainnet deploy, including its refusal of missing values. Measured mint gas: ~145k per agent, wallet included.
- [x] 🤖 `.env` exists. `PROVENANCE_HASH` is already in it (written by `npm run assets`). Only the lines marked YOU are yours; the short list is in [00-YOUR-STEPS.md](00-YOUR-STEPS.md).
- [x] 🤖 `npm run rehearsal:fork`: the whole launch on a Sepolia fork with the real SeaDrop and registry:
  - deploy;
  - public mint through SeaDrop;
  - reserve and sold out;
  - agent wallet actions;
  - exact-block reveal;
  - reputation and tokenURI;
  - base URI, lock and freeze.

  Passed on 2026-10-26, cost ≈ 0.014 ETH.
- [x] 🤖 `npm run rehearsal:sepolia`: the same on the real Sepolia network, with the test wallet in `.env` (`SEPOLIA_PRIVATE_KEY`). **Passed on 2026-10-26**: all 10 steps, 0.0088 Sepolia ETH, collection `0xAA5D6243a4bAb4746a82E756C77284b08a70ab98`; report in `rehearsal-11155111.txt`.
  - It exposed two issues with public load-balanced RPCs, now fixed for mainnet too: stale nonces (`scripts/lib/nonce-guard.js`) and stale reads in the reveal, which now takes its state from receipts.
- [ ] 🧑 `npm run deploy:sepolia` with the real `.env` values. Note the gas used. The script verifies all four contracts on Etherscan, which also proves the API key works.
- [ ] 🧑 On OpenSea testnets: find the collection in Studio, set a stage, mint from a second wallet. This confirms Studio accepts this SeaDrop contract.
- [ ] 🧑 `npm run reveal:sepolia`, then art, pin, `npm run finalize:sepolia`, `npm run site:check -- 11155111`, and publish a test copy of the site.

## 2. Collection assets

- [x] 🤖 AX-1 logo, banner, featured image, social card, X header and pre-reveal image, rendered from the site's models: `npm run brand` → `art/brand/` (brand book: `docs/14-AX1-BRAND.md`).
- [ ] 🤖 `npm run assets` does the rest:
  - it writes `PLACEHOLDER_IMAGE`, `COLLECTION_IMAGE`, `COLLECTION_BANNER` and `PROVENANCE_HASH` into `.env`;
  - it leaves the files for OpenSea Studio in `art/launch-assets/`.

  With `PINATA_JWT` the images go to IPFS. Without it they are served by the site (`EXTERNAL_URL/assets/…`), so publish `web/` before deploying.
- [ ] 🧑 X and Discord profiles (texts in [08-LAUNCH-COPY.md](08-LAUNCH-COPY.md)). Put the links in `web/js/config.js` (`social`).

## 3. Mainnet deploy (only when Studio setup can follow the same day)

The sale window starts at deploy: `revealDeadline` = deploy time + `REVEAL_DEADLINE_DAYS`. After it, anyone can commit the reveal, which closes minting for good. Set it to setup days + allowlist + public phase + at least 5 days of buffer. `extendRevealDeadline` can add up to 90 days later, but only from the Safe.

1. 🧑 `$env:CONFIRM_MAINNET="yes"; npm run deploy:mainnet`. It refuses to run if `OWNER`, `TREASURY`, `PROVENANCE_HASH`, `EXTERNAL_URL`, the three images or `REVEAL_DEADLINE_DAYS` are missing or placeholders.
   - It deploys and wires the contracts, sets payout and fee recipient on SeaDrop, verifies everything on Etherscan, prints the reveal deadline and writes `web/deployment.json`.
   - Then run `Remove-Item Env:CONFIRM_MAINNET`.
2. 🧑 **Studio first, Safe second.** Ownership moves only when the Safe accepts it. Until then the deploy wallet is still the owner, so do all the Studio setup with it (§4).
3. 🧑 Then, from the Safe, accept ownership on all three contracts: three separate transactions, `acceptOwnership()` on `OpenForgeAgents`, `AgentRenderer` and `AgentReputation`.
4. 🧑 From the Safe: `reserveMint(address, n)` in batches of about 25 (100 × ~145k gas would not fit one block comfortably). Do it before the public phase ends: "sold out" counts the reserve, and a commit closes minting for the reserve too.

How to send a call from the Safe: Safe app → New transaction → Transaction Builder → paste the contract address. The ABI loads from Etherscan once the contract is verified. Pick the function, fill in the values (or paste the raw calldata a script printed), "Add", then "Create batch" → sign with the other owners → execute.

## 4. OpenSea (mint venue)

- [ ] 🧑 Log into OpenSea Studio with the owner wallet (the deploy wallet until the Safe accepts), find the collection and complete the profile: name, description, logo, banner, links.
- [ ] 🧑 Drop stages in Studio:
  - allowlist phase at **0.01 ETH**, with the list uploaded;
  - public phase at **0.015 ETH**, max 3 per wallet. Its end date must be before `revealDeadline` (read `revealDeadline()` on Etherscan; the deploy also prints it);
  - creator earnings 5%.
- [ ] 🧑 Check the OpenSea primary fee and fee recipient in Studio (repo default: 10% to `0x0000a26b…a719`). If they differ, update them before the sale.
- [ ] 🧑 Test mint from a secondary wallet, then request collection verification.
- [ ] 🧑 In `web/js/config.js`, set `openseaDropUrl` to the real collection page. Remove `provingApi`/`worldWs` from `web/deployment.json` until those servers run on https/wss. Then `npm run web:build`, `npm run site:check`, and publish `web/`.

## 5. Reveal (after sold out or `revealDeadline`)

1. 🧑 Right after the sale ends (or anyone else): `npm run reveal:mainnet`.
   - It commits, then sends the reveal so it lands in exactly `revealBlock + 1`, with a high tip (`REVEAL_TIP_GWEI`, default 20). On a miss it commits again (up to `MAX_TRIES`), then prints the seed.
   - Budget about 0.01 ETH for retries. Optional: point `MAINNET_RPC_URL` at Flashbots Protect, which keeps the reveal out of the public mempool and does not charge for a missed block.
2. 🤖 `npm run post-reveal -- mainnet` does steps 2–4 in one go:
   - it reads the seed;
   - it generates the 1,024 images;
   - with `PINATA_JWT` it pins them to IPFS; without it, it copies them to `web/images/` (publish `web/` right after, about 460 MB);
   - it sets the base URI;
   - it copies `rarity.json` to the site.
   - It refuses an image folder that is not exactly `1.png … N.png`, and after pinning it checks three images by SHA-256 through the gateway.
   - If the base URI is not on-chain at the end (for example Safe calldata still to execute), it prints **NOT DONE** and exits with code 2. Do not refresh OpenSea or freeze until `baseURI()` shows the new value.
3. —
4. If the owner is the Safe, the script prints the calldata to send from the Safe.
5. 🧑 On OpenSea, spot-check 10 tokens with "Refresh metadata", including the Prime Constructs (`AgentRenderer.legendaryIds()`).
6. 🧑 `$env:FREEZE="true"; npm run finalize:mainnet` (same `IMAGES_CID` or `BASE_URI`, both saved in `.env`). **Irreversible.**
   - With site-hosted images, freezing ties every image to the domain forever, so it also needs `$env:FREEZE_HTTPS="yes"`.
   - Better: move the images to IPFS first (add `PINATA_JWT`, run `npm run post-reveal -- mainnet` again), then freeze. Nothing forces an early freeze.
   - It runs only if step 4 already set this CID, the reputation source is set and the renderer presentation is complete.
   - It also downloads the first and the last image (`IPFS_GATEWAY`, default Pinata) and refuses to freeze unless both are served as PNGs.
   - It locks the renderer, then calls `freezeMetadata()`. From the Safe, execute the printed calls in order (lock → freezeMetadata), or as one batch.
7. 🤖 `npm run web:build` copies `rarity.json` to the site (rarity-sortable gallery). Run `npm run site:check` and republish `web/`.

## 6. After launch

- [ ] 🤖 KPIs every week: `npm run kpi -- mainnet` (on-chain + verifier stats).
- [ ] 🧑 Alerts (Tenderly or Etherscan watch list) on the three contracts: `OwnershipTransferStarted`, `RoyaltyInfoUpdated`, `ContractURIUpdated`, SeaDrop drop/payout updates, `SeedCommitted`, `SeedRevealed`, `RevealDeadlineExtended`.
- [ ] 🧑 `AgentReputation.setAttester(oracle)`. Use `scripts/attest.js` to record tasks and data.
- [ ] 🧑 Set `defaultOperator` in `config.js` once the agent runtime is ready (enables one-click Assisted and Autonomous modes).
- [ ] 🧑 ERC-8004 registration (files in `art/out/agent-cards/`), after verifying the standard's current status, ABI and addresses.
- [ ] 🧑 Publish a "sell safely" guide: lock the wallet from the site, cancel old Seaport listings, then list on OpenSea. For buyers: check the agent page before buying; a wallet locked until a date stays unusable for every holder until then, and approvals it gave other apps earlier still count.
- [ ] 🧑 **Proving Grounds** (after reveal; Synth Arm agents need their traits):
  1. Create a dedicated hot key with minimal ETH, then call `AgentReputation.setSimAttester(key, true)` from the Safe.
  2. Host `scripts/proving-server.mjs` (Node 24) behind HTTPS with:
     - `SIM_ATTESTER_KEY`;
     - `PUBLIC_URL=https://…` (required: it is written on-chain);
     - `ALLOWED_ORIGIN=<site origin>` (required);
     - `TRUST_PROXY=true`;
     - a persistent `DATA_DIR`;
     - `ADMIN_TOKEN` if you want `/admin/flush`.
  3. Set `PROVING_API` and redeploy `web/`.
  4. Before any real-robot replay, calibrate the arm and run `replay_so101.py` in dry-run mode.
- [ ] 🧑 **Neo-Forge**: host `scripts/world-server.mjs` behind `wss://` (TLS proxy) with `ALLOWED_ORIGINS=<site origin>` and `TRUST_PROXY=true`, then set `WORLD_WS` and redeploy `web/`. One Node process handles the MVP (40 per room, auto instances).

## Incident runbook

| Situation | Action (from the Safe unless noted) | Reversible? |
| --- | --- | --- |
| Mint must stop now (bug, exploit, wrong price) | End the stage in OpenSea Studio, or call `updateAllowedSeaDrop([])` | Yes: re-allow the same SeaDrop address |
| Sale slips | `extendRevealDeadline(newTime)` before the deadline passes | No (only later; at most +90 days in total) |
| Deploy key leaked before the Safe accepted | Accept ownership from the Safe immediately; then the key has no power | — |
| Attester key leaked | `setAttester(addr, false)` or `setSimAttester(addr, false)` | Yes |
| Wrong royalty or contractURI | `setRoyaltyInfo` (≤ 10 %) / `setContractURI` | Yes |
| Something wrong after reveal, before freeze | Fix the base URI or renderer; do not freeze | Yes, until `freezeMetadata` |

Irreversible by design:
- `setMaxSupply`, which can only lower supply;
- `commitReveal`, which closes minting;
- `AgentRenderer.lock`;
- `freezeMetadata`;
- the provenance hash after the first mint.

The NFT contract has no global pause: holders' wallets are their own.

## Never

- Promise returns, "passive income" or ROI.
- Freeze metadata before checking it on OpenSea.
- Change the generator after `PROVENANCE_HASH` is registered (the contract forbids it after the first mint).
- Publish `web/` without `npm run site:check` passing.
