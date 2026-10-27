# Local test guide

Everything runs on your PC: a local blockchain, the site, the Proving Grounds verifier. Nothing here touches a real network or real money.

## 1. Start it (one command)

```bash
npm run local
```

It starts a local chain if none is running, deploys fresh demo contracts (60 agents, sold out and revealed, drawn with the 3D token art), then starts the site and the verifier. The first run takes about a minute. **Ctrl+C** stops everything it started.

To restart only the servers and keep the agents you already have:

```bash
npm run local -- --no-demo
```

| Piece | Address |
| --- | --- |
| Local chain (Hardhat) | `http://127.0.0.1:8545`, chain id `31337` |
| Site | http://localhost:8080 |
| Proving Grounds verifier | http://localhost:8787 |

## 2. Set up MetaMask (2 minutes, only for the wallet pages)

The lab pages (Workbench, Phone Brain, Codex, guest runs in the Proving Grounds) need no wallet.

1. MetaMask → Networks → Add a network manually: name `Hardhat Local`, RPC URL `http://127.0.0.1:8545`, chain ID `31337`, currency `ETH`.
2. Import account → paste the private key of Hardhat test account #4. It holds agent #1 and six more:
   `0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a`

   This key is public, printed in Hardhat's docs. **Use it only on this local chain; never send real funds to it.**
3. After every new demo, MetaMask may show "nonce too high": Settings → Advanced → Clear activity tab data.

## 3. What to try

| Page | Try |
| --- | --- |
| Home (http://localhost:8080) | The 3D lab with AX-1 Desk in the middle: hover a station, click to fly in, Ctrl+click opens it in a new tab. "Collection" opens the classes and rarity panel (11 classes). Try a phone-size window too |
| Workbench (`bench.html`) | Pick any of the 11 robots: assemble, take it apart, sensors, brain, move, then the 3 Test missions, then the Build list with real parts and licences |
| Phone Brain (`pilot.html`) | "Start with the twin", ARM, hold the D-pad to drive. AI Pilot: type `forward 2 then turn left` (the built-in parser works without any model). STOP or Esc stops at once and nothing resumes. Switch body: Rover, Desk, Walker |
| Proving Grounds (`arena.html`) | Pick a robot. As Guest every robot is open. With the wallet connected, pick one of your agents: it flies its own class robot and the three AX-1 bodies; a passed run is signed (free) and verified |
| Gallery (`gallery.html`) | The 60 agents with the 3D token art. Filter by class (try AX-1 Rover / Desk / Walker), faction, "Prime Constructs", rarity sort, search `42` |
| Agent page (`agent.html?id=1`) | Pause / resume, top up, withdraw, change mode, "Prepare for sale" lock. Agent #3 has a pending proposal to approve or reject |
| Robot Link (`robot.html`) | Demo run → Try the virtual arm → follow the steps ("Do it for me", wait for each animation) |
| The Codex (`codex.html`) | The 3D book: ←/→ keys, the "Try it" buttons |

## 4. Look at the token art

```bash
npm run art:preview
```

It draws 24 sample tokens into `art/out-preview/` (one Prime Construct, #7) and a `contact-sheet.png` of all of them. The demo's 60 tokens are in `art/out/images/`.

## 5. Tests

```bash
npx hardhat test
```

Admin flush of the verifier (optional): `POST http://localhost:8787/admin/flush` with the admin token printed in the terminal.
