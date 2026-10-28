# OpenForge AX: Analysis and Decisions

> Technical and product analysis. Art, metadata and code are CC0. No external legal review is planned (decision of 2026-10-25), so the "no promise of returns" wording below is kept strictly everywhere.

**Status:** pre-launch · **Last updated:** 2026-10-25 · **Quickstart:** [../README.md](../README.md) · **Launch steps:** [02-LAUNCH-CHECKLIST.md](02-LAUNCH-CHECKLIST.md)

## 1. Verdict

Strong as a narrative and as an architecture: one NFT that is at once the identity, the wallet and the reputation of an agent. The timing is good: ERC-6551 is mature, ERC-8004 is recent, and physical AI is growing. The weak points are not technical. They are product honesty (what is really on-chain) and regulation. Both must be fixed in the positioning before mint.

## 2. On-chain vs off-chain

Say this plainly to the public.

| Component | Where it lives | Status |
|---|---|---|
| Ownership, agent wallet (TBA, created at mint) | On-chain | ✅ implemented |
| Autonomy mode (Manual/Assisted/Autonomous), spend limit, pause, sale lock | On-chain (`AgentAccount`) | ✅ |
| Traits, codename, 1/1 legendaries | On-chain, from a public seed (`AgentRenderer`) | ✅ |
| Reputation, task and data attestations (including failures) | On-chain (`AgentReputation`) | ✅ |
| OpenSea metadata (JSON) | On-chain, dynamic, ERC-4906 refresh | ✅ |
| Images | IPFS, generated deterministically from traits | ✅ pipeline |
| VLA model, memory, runtime, robot control (ROS 2) | Off-chain | ⏳ Phase 2 |

"The NFT is the agent" works as a slogan. The whitepaper must state that the "brain" runs off-chain and signs with an operator key that is bound by the on-chain policy.

## 3. Key risks

1. **Legal.** Wording such as "the agent generates value and the revenue ends up in its wallet" implies an expectation of profit, which risks classification as a financial instrument (Howey test in the US; MiCA and Italian law in the EU). The site and metadata already avoid yield language. No external legal opinion is planned (decision of 2026-10-25): the mitigation is the wording itself, so every page, the OpenSea description and any whitepaper must keep "no promise of returns" and avoid revenue or yield claims.
2. **Hardware.** Without a real robot producing data, Phase 2 stays a promise. Recommended bootstrap: a low-cost open-source arm (e.g. SO-101 / LeRobot) and a video demo with a sample dataset before mint. The team reserve (100) can go to the first builders.
3. **Selling a TBA.** Mitigated: one-click sale lock, policy reset on every transfer (including A→B→A), and the operator cannot move tokens or sign. Residual risk: ERC-20/ERC-721 *approvals* granted by the holder to third parties survive the sale. The buyer guide explains this.
4. **Runtime cost per agent.** Decide who pays for inference and hosting (subscription, task market). Otherwise agents stay dormant.
5. **Royalties not enforced.** ERC-2981 signals royalties, but OpenSea does not enforce them on-chain. The economic plan must rely on primary sales and services.

## 4. Decisions (revisable)

| Topic | Choice | Rationale |
|---|---|---|
| **Supply** | **1,024** (924 via OpenSea + 100 reserve) | Blue-chip scarcity and a manageable community (each agent has a real runtime cost). 1,024 = exactly the 32×32 callsign space: every callsign exists once |
| **Mint** | **On OpenSea via SeaDrop** (`0x00005EA0…4bf5`) | Price, phases, allowlist and limits are managed in OpenSea Studio. No mint site to secure |
| **Price** | **0.01024 ETH for everyone** (the allowlist only mints earlier), max 3 per wallet (user decision 2026-10-28: 1,024 agents) | Low barrier for newcomers and robot builders. At most ~8.5 ETH net of OpenSea's 10% (924 sold), so spending is prioritised (audit first, then infra) |
| **Agent wallet** | Created **automatically at mint** | Zero steps for the user (~90k extra gas per token, paid at mint) |
| **Default autonomy** | Manual (L1) | Safe for beginners: nothing happens without approval |
| **Traits** | 8 categories: Class (11: 8 open platforms + AX-1 Rover, Desk, Walker), Core Model (4), Sensor (5), Finish (7), Frame (4), District (6), Faction (5), Augment (6) | ~1,108,800 trait combinations, plus a unique callsign per agent |
| **Names** | **Unique** codename per agent (32 × 32 words, permutation from the seed) | Strong identity, as in top projects |
| **Legendaries** | **10 × 1/1 "Prime Constructs"** derived from the seed (finish 24K Circuit, district The Forge Core, Crown Halo) | Trophy pieces for collectors and PR |
| **Fairness** | Seed = future `blockhash` + the RANDAO of the one block allowed to reveal (commit → reveal); minting closed at commit; generator hash registered before mint | Nobody, team included, knows the traits in advance |
| **Metadata** | Separate on-chain renderer that can be frozen; `background_color`, `license`, `external_url`; dynamic attributes (wallet, autonomy, reputation, tasks, failures, data) | OpenSea standard, plus visibly growing value |
| **Art** | Deterministic generative cyberpunk art (1000×1000 PNG): district skylines, core neon, faction emblem, augment, glitch HUD | Reproducible and verifiable. Can be upgraded to premium illustrations while keeping the traits |
| **Royalty** | 5% (ERC-2981 + `contractURI`) | Configurable |
| **License** | **CC0 1.0** for the art of all 1,024 agents, the metadata, the code and the docs (`LICENSE`, `web/license.html`, each token's `license` field, `contractURI`). Third-party parts keep their licenses (SeaDrop interfaces MIT) | An open-source project: anyone can build on the art and the code. Holding an agent gives the agent itself (wallet, reputation, missions), not exclusive image rights. CC0 does not waive trademarks |
| **Infrastructure** | **Self-hosted by users**, with connectors we ship: Robot Link, the Proving Grounds and Neo-Forge servers, the SO-101 replay script. One command runs it all ([06-SELF-HOSTING.md](06-SELF-HOSTING.md)) | Open source with no project-funded servers or physical stations; the product must still work end to end out of the box |

## 5. Residual risks (known, not solved in code)

- **Autonomous (L3) relies on runtime trust.** The spend limit covers ETH; direct token movement is forbidden. An authorized router or multicall can still move funds.
- **ERC-1271 without domain separation (ERC-7739).** Evaluate for a v2 of the account.
- **Seed bias.** The reveal works only in block `revealBlock + 1`, so the caller cannot pick among outcomes by timing. The builder of `revealBlock` cannot know the next RANDAO, so grinding its hash is useless. What remains:
  - anyone who can keep the reveal out of that one block forces a re-commit: the builder of that block, or someone who outbids the reveal's priority fee for the whole block, or who bribes for censorship. `scripts/reveal.js` uses a high tip and retries.
  - a proposer who builds its own block at `revealBlock` knows its RANDAO and can grind the hash. A large staker could time the commit to its slot, so commit as soon as the sale ends.

  For full unbiasability, evaluate Chainlink VRF.
- **"Frozen" metadata trusts the renderer's own `locked()` flag.** It is our audited `AgentRenderer`, so this holds, but the freeze is an owner-attested lock, not a proof.
- **Old signatures revive on A→B→A.** A's ERC-1271 signatures over hashes without a nonce become valid again if A buys the agent back (A's earlier sale lock does not: it is bound to the holding period it was set in). Seaport orders carry a counter: cancel them before selling.
- **Centralized attester** at first. Roadmap: multiple attesters and the ERC-8004 Validation Registry. A compromised real attester could inflate reputation tiers (no per-token cap on `attest()`); the owner revokes it with `setAttester(addr, false)`.
- **Sim attestations trust the verifier.** Holders sign each run (EIP-712) and the verifier checks it off-chain; the contract trusts the `isSimAttester` key, capped at 10 runs per token per day, with sim hashes kept apart from real ones.
- **Autonomy trait refresh.** Changing the mode, or a transfer that resets it, emits no ERC-4906 event: OpenSea shows the new "Autonomy" after its next re-crawl or a "Refresh metadata".
- **Images are files, not on-chain.** Traits, names, stats and the wallet are fully on-chain; the 1000×1000 voxel PNGs (about 460 MB) are not, because storing or rendering them on-chain would cost far too much gas and break `tokenURI` on marketplaces.
  - They live on IPFS (Pinata) or, without an IPFS account, on the project site.
  - Either way anyone can rebuild them byte for byte from the on-chain seed with the published generator, whose hash is `PROVENANCE_HASH`.
  - Moving them to IPFS before `freezeMetadata` removes the dependency on the domain.
- **AgentAccount is immutable.** One implementation serves all 1,024 wallets and cannot be upgraded, so it deserves the most audit attention.
- **Owner powers after freeze.** Royalties (≤ 10 %), `contractURI`, SeaDrop drop settings, disabling SeaDrop (never adding a minter), metadata refresh events. Before the commit only: lowering supply, extending the reveal deadline (≤ 90 days in total).
- **ERC-8004 is still Draft** in our review. Registration files are generated, but register only after verifying the ABI and official addresses.
- **OpenSea primary fee** (`feeBps`, default 1000 = 10%) and fee recipient: verify in OpenSea Studio at launch.
- **Mocks in tests.** The ERC-6551 registry and SeaDrop are simulated locally. A **mainnet-fork** or **Sepolia** run with the real contracts is required before mainnet.

## 6. Whitepaper changes (v2.1)

1. Replace "NFTs that generate value" with "agents that accumulate reputation and verifiable data".
2. Add the on-chain/off-chain table from §2.
3. Remove any revenue promise tied to TBAs; describe technical capability only.
4. Present as differentiators: sale lock, policy reset on transfer, operator that cannot move assets or sign.
5. Add the lore (5 factions, 6 Neo-Forge districts, 10 Prime Constructs) and a "reveal fairness" section.

## 7. Security review

The first automated review (`security-reviewer` agent) produced 15 findings: 0 critical, 4 high. All were fixed, with regression tests:

- manipulable seed → replaced by commit/reveal;
- operator ERC-1271 signatures;
- operator movement of assets;
- policy and lock surviving transfers;
- ownership cycles, including multi-hop;
- unvalidated registry;
- free mint from a forgotten configuration;
- JSON injection and DoS via `tokenURI`;
- selector confusion;
- dataHash squatting;
- `renounceOwnership`.

A pre-launch audit by ECC agents (2026-10-25: contracts, servers and site, launch readiness) found 0 critical. Fixed with tests:
- the static server crash;
- the reveal-deadline extension;
- sim/real hash separation;
- the lock and whitelist edge cases;
- `tokenURI` gas bound;
- HTML escaping and CSP on every page, with vendored libraries (no CDN);
- verifier defaults (origin, proxy, quotas, admin token);
- mainnet guards in the deploy;
- `npm run site:check`.

Agent audits are not a substitute for a human one: **an independent audit (solo auditor or contest) is strongly recommended before mainnet**, with AgentAccount first. Without it, at least publish a bug bounty and state the accepted risk.
