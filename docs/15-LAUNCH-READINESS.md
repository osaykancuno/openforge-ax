# Launch readiness report (2026-10-26)

A pre-launch audit of the whole project: contracts and launch scripts, the self-hosted verifier and servers, the website, and secrets in the files that will be published. Four ECC reviews ran in parallel (read-only), then two builders fixed the findings with regression tests. The launch-day steps live in [02-LAUNCH-CHECKLIST.md](02-LAUNCH-CHECKLIST.md) §0b.

## Result

| Area | Reviewer | Before fixes | After fixes |
| --- | --- | --- | --- |
| Contracts, deploy, reveal, finalize | ecc:security-reviewer | 0 critical, 0 high, 3 medium, 6 low | Medium items fixed in `deploy.js` or moved to the checklist; low items disclosed or fixed |
| Verifier and servers | ecc:security-reviewer | 0 critical, 1 high, 6 medium, 7 low | Fixed, 31 new tests |
| Website | ecc:security-reviewer | 0 critical, 2 high (config, headers), 5 medium, 8 low | Fixed or moved to the checklist |
| Secrets and personal data | ecc:opensource-sanitizer | PASS with warnings | `.gitignore` and `.env.example` completed |

Automated checks:
- `npx hardhat test`: 470 passing, 5 pending, 0 failing (after the 2026-10-27 backlog fixes).
- `npm run test:fork` (mainnet fork): 5 passing.
- The Sepolia rehearsal with the 11 classes passed: collection `0x5BFcB5a510Aa820E2477646209AD5a1dD6A8Bf46`, 0.002 test ETH.
- `npm run site:check -- 11155111` fails only on deploy-time values, as expected.

`npm audit` reports 4 moderate issues in production dependencies, all in `uuid` through `@openzeppelin/merkle-tree`. That package is used only by the scripts, never by the site or the contracts. The development toolchain (Hardhat 2) has 53 advisories. None of these ship to users. Do not run `npm audit fix --force`: it downgrades packages and breaks the build.

## What changed

**Contracts and launch scripts** (`scripts/deploy.js`, `hardhat.config.js`)
- The 11 classes check out: the weights sum to 10,000, every class is reachable, the trait roll has no fallback bias, and the 11 class names are present.
- On mainnet the deploy now recomputes the art generator hash and refuses a stale `PROVENANCE_HASH`. The hash is locked at the first mint.
- On mainnet, `MAX_SUPPLY=1024`, `TEAM_RESERVE=100`, `ROYALTY_BPS`, `REVEAL_DEADLINE_DAYS` (7-45), `PUBLIC_PRICE_ETH` and `MAX_PER_WALLET` must be set explicitly. Nothing falls back to a default.
- `EXTERNAL_URL` may not contain quotes, backslashes or control characters, which the renderer would refuse after the contracts are deployed.
- Sepolia never falls back to the mainnet deploy key.

**Verifier** (`scripts/proving-server.mjs`, `scripts/lib/trials.mjs`, `scripts/lib/signatures.mjs`)
- A batch whose transaction is still pending is never resent, so no gas is wasted and records are not mislabelled. The reconcile loop cannot crash the process.
- Rate limits group IPv6 clients by /64 and IPv4-mapped addresses as IPv4. The tables are capped.
- Signatures are checked before the run is replayed. Each token gets 20 bad signatures per hour, then 429, and lab challenges are never retired.
- Open challenges are capped per network and overall, evicting the oldest. Existing pilots are never locked out.
- Episode files are kept only for attested runs. A trial keeps only its best episode.
- File downloads are rate-limited and read asynchronously. JSON responses carry `nosniff` and `no-store`.
- An `ADMIN_TOKEN` set in the environment must be at least 32 characters, and `/admin/flush` is rate-limited.
- On the local demo the servers bind to 127.0.0.1 and refuse foreign Host headers (DNS rebinding). `HOST=0.0.0.0` exposes them on purpose, for example to test the Phone Brain from a phone.

**Self-hosting** (`scripts/serve.mjs`, `scripts/selfhost.mjs`, `scripts/world/*`, `docs/06-SELF-HOSTING.md`)
- Each child process gets only the secrets it needs: the web and world servers get no keys or tokens.
- The static server adds `frame-ancestors 'none'`, and the world server has the same host and IPv6 hardening.

**Website** (`web/`)
- Only known, well-formed keys are read from `deployment.json`, and links must be https (plain http only for localhost).
- Before any transaction the wallet's network is checked again, and a network switch reloads the page.
- Agent proposals show the full target address and the call selector, and need an explicit confirmation.
- When a host ignores `web/_headers`, a framed page hides itself (clickjacking fallback).
- The CSP lists loopback hosts only for the local demo build.
- Neo-Forge no longer guesses `ws://localhost` when no server is configured.

## Backlog closed after the audit (2026-10-27)

- `AgentAccount`: the sale lock now binds the wallet, not the seller (decision of 2026-10-27, see the audit below). The earlier "bound to the holding period" design is superseded.
- `AgentReputation`: the constructor refuses an `agents` address with no code, and `renounceOwnership` always reverts.
- `npm run web:build` writes `web/vendor/SHA256SUMS` with the versions and SHA-256 of every vendored file (`sha256sum -c SHA256SUMS` in `web/vendor`).
- The contracts changed, so the next Sepolia rehearsal (with `REHEARSAL_PIN=yes`) covers them before mainnet.

## Security audit (2026-10-27)

Secrets scan: PASS (repo and every commit clean, no key rotation needed). `npm audit`: 4 moderate in `uuid` through `@openzeppelin/merkle-tree`, scripts only. Fixed, each with a regression test:

- **Sale lock binds the wallet.** Until `lockedUntil` (at most 30 days, extend-only) nobody can move the wallet's contents: not the seller, not a second address of theirs, not the buyer. The buyer gets full control at expiry. A self-transfer no longer bumps `transferNonce`.
- **Reveal seed without `blockhash`**: `prevrandao` of `revealBlock + 1`, chain id, total supply and the contract address. A proposer who builds their own block can no longer grind it.
- **Launch scripts**: `deploy.js` also requires a future `PUBLIC_START`, `PUBLIC_END + 3 days` on or before the reveal deadline, `OPENSEA_FEE_BPS` 500–2000, and a `CONFIRM_PRICE` / `CONFIRM_MAX_PER_WALLET` that repeats any price or per-wallet cap other than the decided 0.015 / 3. `generate` and `pin` refuse an image set that is not exactly `1..N.png`; `finalize` with `FREEZE` checks that the first and last image are served as PNGs; `post-reveal` exits with code 2 and "NOT DONE" when the base URI is not on-chain yet.
- **Market page**: sales are read only from `OrderFulfilled` events of the official Seaport 1.5/1.6 contracts, with the token's `Transfer` in the same receipt.
- **Agent page**: wallet and proposal data are re-read through the wallet's own provider before signing; Top up shows the recipient, and approvals show the operator and limit.
- **Verifier and servers**: malformed URLs answer 400 instead of crashing, atomic file writes, coarser rate limits (/48, /24), a fee cap with same-nonce replacement, request timeouts, and RPC URLs redacted in logs.
- **Site build**: GitHub Actions pinned by commit SHA, vendored files checked with `sha256sum -c`, loopback CSP sources stripped from the published build, `site:check` fails on a loopback CSP or `fromBlock` 0 outside the local chain.

## Accepted risks (by design, disclosed)

- Royalty info and the contract URI stay changeable by the owner after `freezeMetadata`. Token metadata does not.
- The reveal seed resists a single block producer, but a validator who proposes `revealBlock + 1` can still skip it (one bit of bias) or censor the reveal transaction. Never call the reveal "provably fair".
- **The traits are computable about one block early.** `prevrandao` of `revealBlock + 1` is known once the beacon block at `revealBlock` is out, so a bot can read every trait about 12 seconds before the reveal lands and buy listed rares in that window. Same class as the residual above; a fix would need VRF or a secret commit.
- **A seller can lock just before a sale lands.** The lock binds the wallet for every holder, so a seller who sees a purchase coming can lock for up to 30 days first; the buyer then holds a wallet they can't use until expiry (never longer: only the current holder can extend it). Buyers should check the lock on the agent page (`lockedUntil`) before buying; the "sell safely" guide says so.
- **The sale lock cannot revoke approvals.** Token approvals the wallet gave other apps before the lock still count, and no contract can withdraw them. Every place that describes the lock says so.
- `AgentAccount.isValidSignature` validates the raw hash it is given. Apps that ask the wallet to sign through Permit2 or other raw-hash schemes rely on the holder reading what they sign; a lock or pause still voids every signature.
- The site is served from the shared `osaykancuno.github.io` origin until a custom domain is set. Move to a custom domain before launch (storage and service-worker scope are shared with other Pages sites on that origin).
- Lab challenges can be requested with a public owner address, so a stranger can use up that token's hourly bad-signature budget. Lab passes stay safe, because only the holder can sign them, and since 2026-10-27 a run signed by the holder's own key is still accepted when the budget is spent. A holder whose wallet is a smart contract (ERC-1271) can still be held up for that hour.
- `img-src https:` and `connect-src https: wss:` stay wide on most pages, so visitors can point the site at their own verifier. Scripts are limited to `'self'` and every untrusted value is escaped.

## Before launch (you)

These steps are in [02-LAUNCH-CHECKLIST.md](02-LAUNCH-CHECKLIST.md) §0b:
1. Done on 2026-10-27: the art is final and `PROVENANCE_HASH` is fresh. Run `npm run assets` again after setting `PINATA_JWT` or `EXTERNAL_URL`, so the image links are written to `.env`.
2. Fill in the supply values, `OWNER`, `TREASURY` and `EXTERNAL_URL`.
3. The Safe calls `acceptOwnership` on all three contracts.
4. Mint the reserve before the public phase ends.
5. Deploy, regenerate `web/deployment.json`, then run `npm run web:build`.
6. Check the live headers with `curl -I`.
7. Publish from a clean `git init`.
8. An independent human audit, starting with `AgentAccount`, is still recommended.
