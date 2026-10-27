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

- `AgentAccount`: a sale lock is bound to the holding period it was set in, so it no longer comes back when the seller buys the agent back (A→B→A).
- `AgentReputation`: the constructor refuses an `agents` address with no code, and `renounceOwnership` always reverts.
- `npm run web:build` writes `web/vendor/SHA256SUMS` with the versions and SHA-256 of every vendored file (`sha256sum -c SHA256SUMS` in `web/vendor`).
- The contracts changed, so the next Sepolia rehearsal (with `REHEARSAL_PIN=yes`) covers them before mainnet.

## Accepted risks (by design, disclosed)

- Royalty info and the contract URI stay changeable by the owner after `freezeMetadata`. Token metadata does not.
- The reveal seed resists a single block producer, but a validator who proposes both `revealBlock` and `revealBlock + 1` can bias it by skipping. Never call the reveal "provably fair".
- Lab challenges can be requested with a public owner address, so a stranger can use up that token's hourly bad-signature budget. Lab passes stay safe, because only the holder can sign them.
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
