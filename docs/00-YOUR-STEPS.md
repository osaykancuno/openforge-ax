# Your steps (the only ones that need you)

Everything else is automated. Each step names what to do and where; afterwards, run the command shown, or ask Claude to.

| # | What | Where | Time |
| --- | --- | --- | --- |
| 1 | Create a **Safe** (multisig, e.g. 2-of-3) and copy its address into `.env` as `OWNER` and `TREASURY` | app.safe.global → Create account | 10 min |
| 2 | Create a **new wallet** only for the deploy; put its private key in `.env` as `PRIVATE_KEY` | MetaMask → Add account → Account details → Show private key | 3 min |
| 3 | Pick the **site address** and put it in `.env` as `EXTERNAL_URL`, then run `npm run assets`. The site also serves the images, so no other account is needed. Cloudflare Pages is free | pages.cloudflare.com → create a project (Claude can publish `web/` with its CLI after you log in once) | 10 min |
| 4 | *(Optional, recommended before freezing)* A free **Pinata** account puts the images on IPFS, so they no longer depend on your domain. Put the JWT in `.env` as `PINATA_JWT`; `npm run assets` and `post-reveal` then use IPFS on their own | pinata.cloud → API Keys → New key (Admin) | 5 min |
| 5 | ~~Sepolia rehearsal~~ **Done 2026-10-26**: all 10 steps passed on Sepolia (report `rehearsal-11155111.txt`) | — | — |
| 6 | **Mainnet**: send ETH to the deploy wallet (about 2× the Sepolia gas, for example 0.05–0.1 ETH), then `$env:CONFIRM_MAINNET="yes"; npm run deploy:mainnet` | your exchange or wallet | 10 min |
| 7 | **OpenSea Studio**: log in with the deploy wallet, upload logo/banner/featured from `art/launch-assets/`, paste the texts from `08-LAUNCH-COPY.md`, set the two stages (0.01 / 0.015 ETH, max 3) | opensea.io/studio | 30 min |
| 8 | **Safe**: accept ownership on the 3 contracts, then reserve-mint the team agents | Safe → Transaction Builder (steps in `02-LAUNCH-CHECKLIST.md` §3) | 15 min |
| 9 | After the sale: `npm run reveal:mainnet`, then `npm run post-reveal -- mainnet`, check OpenSea, then freeze | terminal | 30 min |

Optional but recommended: an Etherscan API key (`ETHERSCAN_API_KEY`, free) to verify the contracts automatically; X and Discord accounts (texts in `08-LAUNCH-COPY.md`); a human audit before mainnet.
