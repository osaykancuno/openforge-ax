# 18 · Feasibility: everything we say, and what makes it real

Rule: the site and the posts only say what one of these rows supports. **Today** = works now. **Ready** = the code or
contract for it exists; what is missing is an operation (money, people, a date). **Groundwork** = the building blocks
exist; a feature still has to be built on them. Nothing here is a promise to holders; see the disclaimer on the site.

| Claim (site, posts) | Status | What already exists | What is still needed |
|---|---|---|---|
| The lab is free, no wallet | Today | Every page works without a wallet | — |
| The Phone Brain drives AX-1's 3D twin | Today | `web/js/pilot/` (twin transport running the bridge logic) | — |
| The AI Pilot turns typed requests into safe moves | Today | `web/js/pilot/ai/` (parser, optional local model, run gate; never arms) | — |
| …and spoken requests | Today (Chrome/Edge) | `web/js/pilot/ai/voice.js`: browser speech recognition into the same request path | Wider browser support follows the browsers |
| A real AX-1 over Bluetooth | Groundwork | `ble-transport.js`, the AX protocol, bridge firmware in `firmware/` | The team's first hardware build and a measured test; firmware is experimental |
| The bridge stops and holds if the phone goes quiet | Groundwork (designed) | Watchdog in the firmware and in the twin's bridge simulation | Test on hardware (say "designed to") |
| AX-1's twin on your floor in AR at real size (~23 cm), driven by voice | Today (Android Chrome on ARCore phones) | `web/ar.html`, `web/js/ar/ar-view.js` (WebXR hit-test), voice through the Phone Brain request path (`voice.js`, built-in parser, drive loop, bridge sim) | List the tested phones in the build log |
| The AR twin stops for real obstacles ("Something is in my way, about 30 cm ahead") | Today (phones with the ARCore Depth API) | `web/js/ar/obstacle.js` (phone depth along the twin's path; forward hit-test fallback) | Say "on phones with depth sensing" and "about"; objects lower than about 20 cm may be missed; thin, dark, glossy or moving objects untested |
| iPhone camera view: the twin over the live camera, voice works | Today | `web/ar.html` camera view (Safari has no WebXR AR) | Not anchored to the floor, no obstacle sensing: say both |
| "Look around": finds 80 everyday object types on the phone (nothing leaves it) | Today (twin only) | `web/js/ar/vision/` with MediaPipe EfficientDet-Lite0 (Apache 2.0), self-hosted | In AR it needs the browser's camera-access support, else camera view only; finding objects is not mapping a room |
| Command your real AX-1 by voice, as you do the AR twin | Groundwork | Same app and drive loop; `ble-transport.js` | Hardware build and measured tests. Say "Planned", never "today"; an AR view of a real robot is not built |
| Real-world action by touch, text or voice | Groundwork | Same app, same transports; voice and text already produce plans | Hardware build; field tests |
| On-phone vision and autonomy | Groundwork | Camera motion detection in the Phone Brain; plan executor with safety gate | A vision model on the phone; a policy that runs in sim and on a unit |
| Passed and failed runs written on-chain | Today | Verifier (`scripts/proving-server.mjs`), `AgentReputation` | A hosted verifier at launch (docs/06) |
| Each agent has its own wallet with limits | Today | ERC-6551 `AgentAccount`: Manual approval, daily limit, pause, lock | — |
| Assisted and Autonomous modes | Groundwork | Contract levels, operator role, limits | The agent software that uses them |
| Sell your own CC0 kits and guides | Today | CC0 licence on models, firmware, app, docs | — |
| Credited run datasets | Groundwork | Runs hashed and attested to the agent; LeRobot export (`LeRobotExport` test) | A public dataset release with a contributor list |
| Prize missions | Ready | Missions, verifier, leaderboards, agent wallets to pay into | Treasury funds and an event calendar |
| Builder bounties | Ready | Agent wallets to pay into; holder checks by signature (`scripts/lib/signatures.mjs`) | A bounty board (GitHub issues are enough) and a budget |
| Early access for holders | Ready | Ownership checks by signature, as in the Proving Grounds | A gated page or Discord role bot |
| Holder votes on the roadmap | Ready | ERC-721 ownership on-chain | An off-chain vote counted by agent (e.g. Snapshot); scope to define |
| Market page: floor, sales, holders, rarity | Today | `market.html`: sales from Seaport orders, holders from transfers; floor via `/market` | `OPENSEA_API_KEY` on the verifier for the floor price |
| Mint only on OpenSea, reveal by public draw | Today | SeaDrop, commit-reveal in `OpenForgeAgents` | Mint date |

**How to keep it true:** when a row moves (a hardware test passes, a bounty board opens), update this table first, then
the site copy, then the posts.
