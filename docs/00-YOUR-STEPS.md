# Your steps (the only ones that need you)

Everything else is automated: after each step, tell Claude "done" and it runs the rest. Nothing goes to mainnet, to your Pinata account or to OpenSea without your yes in chat. Status: 2026-10-27.

## A. One evening of accounts (about 45 minutes)

| # | What | Where | Time |
| --- | --- | --- | --- |
| 1 | **Site preview with https on GitHub Pages** (also lets you test the Phone Brain's camera and sensors on your phone). Done once: in the repo, Settings → General → Danger Zone → **Change visibility → Public**; then Settings → **Pages** → Source: **GitHub Actions**. The workflow `.github/workflows/pages.yml` publishes `web/` on every push to https://osaykancuno.github.io/openforge-ax/ . Until the launch it is a preview: search engines are told to skip it, and the blockchain pages show "not published yet" | github.com/osaykancuno/openforge-ax/settings | 5 min |
| 2 | **Pinata** (puts the images on IPFS, so they never depend on a server): create an API key with Admin rights and paste the JWT into `.env` as `PINATA_JWT` | app.pinata.cloud → API Keys → New key | 5 min |
| 3 | **Sepolia test ETH** for the final rehearsal: about 0.05 test ETH to the test key's address (Claude prints it) | a Sepolia faucet, e.g. Google Cloud Web3 faucet | 5 min |
| 4 | **Etherscan API key** (free; verifies the contracts so anyone can read their code): paste into `.env` as `ETHERSCAN_API_KEY` | etherscan.io/myapikey | 3 min |
| 5 | **Safe** (multisig, e.g. 2-of-3 on different devices): copy its address into `.env` as `OWNER` and `TREASURY` | app.safe.global → Create account | 10 min |
| 6 | **New deploy wallet** used only for the deploy: its private key into `.env` as `PRIVATE_KEY` | MetaMask → Add account → Account details → Show private key | 3 min |
| 7 | **X and Discord** profiles: texts are ready in `08-LAUNCH-COPY.md`; send Claude the two links | x.com, discord.com | 10 min |

Then Claude runs, on its own: `npm run assets` (images on IPFS), the full Sepolia rehearsal with the real IPFS path and the updated contracts, the mainnet-fork simulation, the site checks, and a report of what passed.

## B. Two small checks with Claude (about 20 minutes)

| # | What | Where | Time |
| --- | --- | --- | --- |
| 8 | On OpenSea **testnets**: open the rehearsal collection Claude links, and mint one from a second wallet (confirms Studio accepts our contract) | testnets.opensea.io | 10 min |
| 9 | **Comprehension test**: show the site to 5 people for 2 minutes and ask the 5 questions in [16-COMPREHENSION-TEST.md](16-COMPREHENSION-TEST.md) | in person or on a call | 10 min each |

## C. Launch day, together (about 1.5 hours)

| # | What | Where | Time |
| --- | --- | --- | --- |
| 10 | Send ETH to the deploy wallet (about 0.05–0.1 ETH; Claude gives the exact figure from the rehearsal), then say "go" in chat: Claude deploys to mainnet | your exchange or wallet | 10 min |
| 11 | **Safe**: accept ownership on the 3 contracts (Claude prepares the three transactions) | Safe → Transaction Builder | 15 min |
| 12 | **OpenSea Studio**: log in, upload the images from `art/launch-assets/`, paste the texts from `08-LAUNCH-COPY.md`, set the two stages (allowlist then public, both 0.01024 ETH, max 3 per wallet), check the fee recipient | opensea.io/studio | 30 min |
| 13 | **Reserve**: mint the 100 team agents from the Safe **before the public phase ends** | Safe (Claude prepares it) | 10 min |
| 14 | **Domain** (optional): point your domain at the Pages project; Claude switches the site config to the live contracts and pushes | Cloudflare → your Pages project → Custom domains | 10 min |

## D. After the sale (about 30 minutes)

| # | What | Where | Time |
| --- | --- | --- | --- |
| 15 | Say "reveal": Claude runs the reveal, renders and pins the art, and you check a few agents on OpenSea; then Claude locks the renderer and freezes the metadata | terminal + opensea.io | 30 min |

Strongly recommended, not blocking: an independent human audit of `AgentAccount` (one contract for all 1,024 wallets), and a short legal opinion on the sale (MiCA, Italy). If you skip the audit, announce a bug bounty.
