# OpenForge AX

**An open robotics lab. Meet AX-1: a phone for a brain, open for everything else.**

Learn how robots work in interactive 3D, test them with missions in the browser, then build **AX-1**, our CC0 robot that uses a smartphone as its brain (camera, IMU, compute, Bluetooth) and an ESP32 board to drive its servos. 1,024 **OpenForge agents** on Ethereum (ERC-721 + ERC-6551 wallets, minted on OpenSea via SeaDrop) are the lab's membership and on-chain record. Direction and rules: [docs/12-OPENFORGE-LAB.md](docs/12-OPENFORGE-LAB.md).

| Folder | Contents |
|---|---|
| `web/` | Static site: the 3D lab home, **Workbench** (`bench.html`: 11 robots explained in stages, missions with levels, real BOMs), **Phone Brain** (`pilot.html`: the AX-1 app, twin mode + Web Bluetooth), **Proving Grounds** (`arena.html`), **Robot Link** for real SO-101 arms (`robot.html`), **The Codex** (`codex.html`), gallery, My agents. Shared 3D models: `web/js/models/`. |
| `firmware/ax-bridge/` | ESP32 bridge firmware for AX-1 (BLE ⇄ servo bus / motors, safety in firmware). Experimental until the first hardware build. |
| `contracts/` | `OpenForgeAgents` (ERC-721 + SeaDrop + automatic TBA + reveal), `AgentAccount` (agent wallet with L1/L2/L3 autonomy), `AgentRenderer` (on-chain metadata), `AgentReputation` (attestations) |
| `art/` | Trait mirror (`traits.mjs`), token art generator, brand sources (`art/brand/src/`: AX-1 mark and render page) |
| `scripts/` | Deploy, reveal, IPFS, finalize, attestations, local demo, site build, brand renders, Proving Grounds verifier, real SO-101 replay, LeRobot export, AX-1 loopback bridge |
| `docs/` | [Lab pivot](docs/12-OPENFORGE-LAB.md) · [Phone Brain & AX-1 build](docs/13-PHONE-BRAIN.md) · [AX-1 brand book](docs/14-AX1-BRAND.md) · [Open robot catalog](docs/research/open-robot-catalog.md) · [Launch checklist](docs/02-LAUNCH-CHECKLIST.md) · [Proving Grounds](docs/03-PROVING-GROUNDS.md) · [Robot Link](docs/05-ROBOT-LINK.md) · [Self-hosting](docs/06-SELF-HOSTING.md) · [License](LICENSE) |

## Quickstart

```bash
npm install
```

```bash
npm test
```

`npm test` runs the whole suite: contracts (Solidity branch coverage 92%), the Proving Grounds verifier end to end, Solidity ↔ JS trait parity, the Robot Link servo emulator, the Workbench missions and the AX-1 protocol.

Mainnet-fork test against the real ERC-6551 registry and SeaDrop (public RPC, or `MAINNET_RPC_URL` + `FORK_BLOCK` for a pinned run):

```bash
npm run test:fork
```

Brand assets (AX-1 logo, OpenSea banner and featured image, social card, X header, pre-reveal image), rendered from the site's own 3D models with a local Chrome or Edge:

```bash
npm run brand
```

## Self-hosting

OpenForge AX runs no project servers: run the site and the Proving Grounds yourself with one command ([guide](docs/06-SELF-HOSTING.md)):

```bash
npm run selfhost
```

## Local demo

Use two terminals.

Terminal 1, leave running:

```bash
npm run node
```

Terminal 2:

```bash
npm run demo
```

```bash
npm run serve
```

Optional, for the Proving Grounds (terminal 3):

```bash
npm run proving
```

Then open http://localhost:8080 (Workbench: /bench.html, Phone Brain: /pilot.html, arena: /arena.html).

## License

[CC0 1.0](LICENSE): the art, the metadata, the code and the docs are public domain. Third-party parts keep their own licenses (`contracts/seadrop/` interfaces: MIT, OpenSea; npm dependencies: see each package). CC0 does not waive trademarks: don't present your work as official OpenForge.

No yield or return is promised. NFTs are digital objects with operational utility.
