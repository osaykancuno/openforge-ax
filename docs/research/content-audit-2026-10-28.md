# Content audit: repeated information and redundant sections (2026-10-28)

User direction: "avoid redundant sections and information that repeats; make things simple for the user". Navigation
decided the same day: no top bar of sections; the 3D lab is the only menu; every other page has "← Lab" + ⚙ settings +
Connect wallet only where needed. Audit by `ecc:marketing-agent` (read-only); line numbers are from before the cuts.

## Rule
One place per piece of information. Other places become nothing, one short line, or a link. Legally or ethically
required lines are deduplicated to one clear place per page context, never removed.

## Must keep (one clear place each)
- "No promise of returns" / not an investment: footer (every page), the FAQ, Market, the licence page.
- TWIN vs BUILD labels; "firmware experimental, untested on hardware"; "iPhone has no Web Bluetooth" where it matters.
- Mint only on OpenSea, never type your recovery phrase, we never DM first.
- Camera / microphone privacy beside each use (AR start card, Phone Brain senses card).
- STOP and ARM hints; third-party licences on license.html.

## Safe cuts (pure duplicates), applied 2026-10-28
- Home hero: the "Try the Phone Brain" / "Open the Workbench" buttons and "What is an agent (NFT)?" (stations and the
  Collection station do this); one "Guide & FAQ" entry stays.
- Guide panel: the 4-step list, the "perks" list and the agent section (they repeat the hero, "Why a phone?" and the
  Collection panel); the FAQ keeps only questions answered nowhere else.
- Collection ("lore") panel: the repeated "why hold" bullets and the notes that repeat the FAQ.
- Codex: the last chapter (the 4 steps, now the stations) and the end row of 5 menu buttons; chapter 7 trimmed.
- Phone Brain, Proving Grounds, agent page, 404: repeated guest / lab-sim / iPhone / agent-definition sentences and
  extra buttons to pages the lab already reaches.
- FIG. numbers on subpages where they were inconsistent.

## Structural proposals (NOT applied: they change behaviour, the user decides)
1. "My agents" station → a "Mine" filter in the Gallery (same grid).
2. Proving Grounds: one Pilot / Result / Leaderboard stack instead of two parallel ones.
3. Phone Brain: drop the twin / real radio (the Start buttons already choose).
4. AR: drop the "Look around" checkbox for the in-session button only. Caveat: WebXR must request `camera-access` when
   the session starts, so consent before Start is still needed in AR; the checkbox exists for that reason.
5. Hero stats (minted / supply / mint) → Market only, or one "Mint: soon" chip.
