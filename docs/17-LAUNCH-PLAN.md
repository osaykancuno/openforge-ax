# 17 · Launch plan: positioning, editorial calendar, assets

How to present OpenForge AX to the community: a quiet, slightly mysterious build-up, then a plain and honest launch.
Every claim here is checked against [18-FEASIBILITY.md](18-FEASIBILITY.md). The rendered assets are in
`art/marketing/out/` (`npm run marketing` rebuilds them from the site's own 3D models; CC0).

**House rules for every post:** no component prices, no mint price in teasers, no "investment", "returns", "floor goes
up" or "guaranteed". Every future item says **Planned** or **In development**. Hardware status is said plainly: the
Phone Brain drives AX-1's 3D twin today; the bridge firmware is experimental until our first build.

---

## 1. Positioning

**One line:** OpenForge AX is the first open lab where a robot's brain is the phone you already own, and every skill it
learns becomes a verified on-chain record.

**Bio (all channels):** Your phone is the brain. The robot is the body. Open, CC0.

**Pillars**

1. **Why a phone? The brain is already in your pocket.** Cameras, microphone, speaker, motion sensors, GPS, a fast
   processor (with an AI chip on most recent phones), a screen for a face, Wi-Fi, Bluetooth and a battery: the hard parts
   of a robot, already owned and kept up to date. The body adds motors and a small ESP32 bridge designed to stop and hold
   if the phone goes quiet. *Proof today:* the Phone Brain drives AX-1's twin; its AI Pilot takes typed or spoken requests.
2. **Skill that can be checked.** Proving Grounds runs are replayed by a verifier; agent holders' passes and failures are
   written on-chain. *Proof today:* a public record of attempts, not a badge.
3. **An agent that is yours, and open.** 1,024 agents, each with its own wallet and limits you set. Models, firmware,
   app and docs are CC0. *Proof today:* anyone can fork all of it.

Say "the first lab where…", never "the first robotics NFT" or "the only". Run a competitor scan before using "first" in
press.

---

## 2. Assets (art/marketing/out/)

| File | Use | On-image text | Caption (≤ 220 chars) | Alt text |
|---|---|---|---|---|
| `ax1-signal-teaser-1080x1350.mp4` | Teaser, days 1–3. Dark, no logo | Something is waking up. | Something in the lab is waking up. Watch closely: every frame hides something. | Dark screen. Two robot eyes flicker on through glitches. |
| `ax1-turntable.gif` / `.mp4` | Reveal of AX-1 | FIG. 01 · AX-1 Rover | AX-1: a robot whose brain is your phone. Open, CC0, free to explore in 3D. | A small robot with a phone for a head turns on a turntable. |
| `ax1-wave.gif` / `.mp4` | Warmth, replies | FIG. 02 · Hello, pilot | AX-1 says hello. Next, you give it something to do. Explore the lab; hold an agent and your runs go on its record. | The AX-1 Desk robot waves one arm, smiling on its phone screen. |
| `ax1-reveal-1920x1080.mp4` | Reveal day, YouTube, Discord | Your phone is the brain. | Three bodies, one brain: the phone you already own. Meet AX-1. | Three AX-1 robots, then the OpenForge AX logo. |
| `why-a-phone-1080x1350.mp4` / `.png` | "Why a phone?" day | A robot needs a brain. You already own one. | Cameras, mic, motion sensors, an AI chip, a screen, a battery. AX-1 borrows the phone you own; the body adds motors. | A phone face, then the phone's built-in parts, then the AX-1 Rover. |
| `ax1-hero-1600x900.png` | X header posts, press, Discord | Your phone is the brain. | AX-1's brain is the phone you already own. Drive its 3D twin today. Real-robot control is in development. | Three AX-1 robots next to the title. |
| `ax1-portrait-1080x1350.png` | Instagram feed | Meet AX-1. | A mascot and a robot. Models, firmware, app and docs are CC0. Fork it, build it, improve it. | The AX-1 Desk robot, smiling and waving. |
| `ax1-story-1080x1920.png` | Stories, reels cover | Tap in. Drive AX-1. | Pick a robot, learn how it works in 3D, then pilot it. Your agent keeps the record. | The AX-1 Rover, large, under the title. |
| `class-lineup-1600x900.png` | Collection posts, FIG. drops | 11 robots. One lab. | Three AX-1 bodies and eight classes inspired by open platforms. Each one explained in 3D. | Eleven robots in a grid, each labelled with its FIG. number. |
| `lab-tour-1280x720.mp4` | Lab opening | (none) | The lab in 20 seconds: Workbench, Proving Grounds, Phone Brain, Market. Open to explore; agents keep the verified record. | Screens of the OpenForge lab, one after another. |
| `art/brand/x-header.png`, `banner.png`, `logo.png`, `og.png` | Profiles, OpenSea | Brand | `npm run brand` rebuilds them from the same models. | |

`ax1-ar-room-1080x1920.mp4` (Week 3, Day 17) is a real screen recording, not a render: see the Week 3 beat.

Cut the 8 s teaser to 6 s for TikTok if needed. Never add music with lyrics; the lab's own ambient tracks are CC0.

---

## 3. Calendar (6 weeks; Day 1 = the first teaser)

**Mystery mechanics**
- **FIG. numbers.** Every teaser carries a FIG. tag. Only FIG. 01 (AX-1) is explained at first; one class per Friday.
- **Codes.** Each teaser ends on a code (`AX-1 / 00:07:31`). The codes, collected, spell a fragment of a hidden Codex page
  (to build before Day 1; see the checklist). The first 100 finders get the Decoder role.
- **Countdown:** only with a fixed date. Never a fake one.
- **Discord roles:** Signal (joined in the teaser phase), Decoder, Pilot (one mission done), Allowlisted, Holder.

**Rituals:** Wednesday *Run of the week* · Friday *FIG. drop* · Sunday *Build log* (honest status, including what broke).

### Week 1: Signal, then AX-1
| Day | Channel | Format | Goal | Hook | Asset |
|---|---|---|---|---|---|
| 1 | X, Discord, IG/TikTok | Video | Curiosity | "Something is waking up." | signal teaser |
| 2 | X | Profile banner swap | The profile joins the mystery | "FIG. 01. Not yet." | x-header (blurred crop) |
| 2 | Discord | Puzzle | Decoders | "Each signal hides one piece. Compare notes." | none |
| 3 | X, IG story | Video / story | Second signal | "Listening." | teaser (alt cut), story |
| 4 | Discord | Hint | Reward decoders | "The Codex has a page that is not in the index." | none |
| 5 | X, IG/TikTok | GIF / video | **Reveal of AX-1** | "Meet AX-1. Its brain is the phone in your pocket." | turntable, reveal |
| 6 | X | Thread (6) | What AX-1 is | "What AX-1 is, in six posts." | hero, wave, lineup |
| 7 | X, Discord | GIF, build log 01 | Warmth, honesty | "It says hello." | wave |

### Week 2: the lab opens
| Day | Channel | Format | Goal | Hook | Asset |
|---|---|---|---|---|---|
| 8 | All | Video | **Lab opens** | "The lab is open. Explore it; your agent makes it count." | lab tour |
| 9 | X, IG | Image | Scale | "11 robots. Explained in 3D." | lineup |
| 10 | X, IG/TikTok | Video + thread (8) | **Why a phone?** | "Why is AX-1's brain a phone?" | why-a-phone |
| 11 | X | Thread (5) | The verified record | "Your run, replayed and written on-chain." | lab tour clip, hero |
| 12 | X | Image | FIG. drop | "FIG. 02." | lineup (crop) |
| 13 | X, Discord | Community runs | Social proof (real only) | "Best run so far, from you." | community screenshots |
| 14 | X, Discord | Build log 02 | Preview the allowlist | "Next week: how a spot is earned." | none |

**"Why a phone?" thread (Day 10):** 1) Why is AX-1's brain a phone? You already own one. 2) Cameras, motion sensors,
microphone, speaker, GPS. 3) A fast processor, an AI chip on most recent phones, a screen, Wi-Fi and Bluetooth. 4) And its
own battery: the hard parts of a robot. 5) The body adds motors and an ESP32 bridge designed to stop and hold if the phone
goes quiet (firmware experimental). 6) Today: the Phone Brain drives AX-1's twin; type or say "wave, then look left".
7) Planned: the same app driving a real AX-1 by touch, text or voice. 8) Try it, tell us what breaks.

### Weeks 3–6
| Week | Phase | Plan | Hooks |
|---|---|---|---|
| 3 | Allowlist | Pilot-ranking explainer, leaderboard pinned in Discord, two short videos of top runs, the AR clip (AX-1's twin on your floor, driven by voice, Day 17), build log 03 with real results from different phones | "Steady pilots earn a spot." |
| 4 | Allowlist closes | Leaderboard snapshot, mint date with a real countdown, how-to-mint guide, scam warning; "a reason a day" (eyes, ears, motion, brain, face) | "Mint is only on OpenSea. Nowhere else." |
| 5 | Mint | Live thread, daily status, Discord support channel staffed | "Your agent arrives dormant. The reveal comes after the sale." |
| 6 | Reveal | Publish the draw method first, then the result; class showcase; holder spotlights; first bounty-ideas poll | "The draw is public. Check it yourself." |

**KPIs:** Signal: Discord joins, teaser completion, Decoders. Reveal: profile visits, shares. Lab: unique visitors,
missions completed, Phone Brain sessions, AI Pilot requests. Allowlist: pilots with 3+ runs, return visits. Mint: page
visits, support response time, scam reports handled. Reveal: holders in Discord, holder missions, bounty ideas.
Set baselines in week 1; no invented targets.

### Week 3 beat: "AX-1 in your room" (AR twin, `web/ar.html`)
It follows the "Why a phone?" thread (Day 10, which ends on voice): the same voice, now with the twin in your room. It
comes before the mint run-up, so it stays a free lab feature, and Week 4's "a reason a day" reuses it for eyes and ears.

| Day | Channel | Format | Goal | Hook | Asset |
|---|---|---|---|---|---|
| 17 (Wed) | X, IG/TikTok, Discord | Vertical video 10–15 s + reply post | Try it on your own phone | "Say it. The twin moves." | `ax1-ar-room-1080x1920.mp4` |
| 18 | Discord `#phone-brain` | How-to post + device thread | Real device reports | "Which phone? What did it do?" | 3 screenshots |
| 20 | X | Thread (4), only with real user clips | Real proof | "Your room, your twin." | Community clips (real, with permission) |
| 21 (Sun) | X, Discord | Build log 03 | Honesty | "What worked on which phone. What broke." | — |

Rules for this beat:
- **TWIN** on every frame. The vision line ("Planned: the same voice commands for a real AX-1") appears once per post,
  never in the hook.
- No allowlist or Pilot credit for AR use: an AR drive is not a Proving Grounds run.
- Post Day 17 only after the clip is filmed on a real ARCore phone and the page is live.

**Hero asset `ax1-ar-room-1080x1920.mp4`** (about 14 s, one real screen recording on an Android ARCore phone with depth
sensing, plain floor, daylight, phone audio on, burned-in subtitles of the recognised words). Never stage the stop: if
the twin doesn't stop on the take, reshoot or cut it, and note the take count in the build log.

| Time | Visual | Voice | On-screen text |
|---|---|---|---|
| 0–2 s | The twin on the floor with its shadow | room tone | **TWIN** chip; "AX-1, on my floor. 23 cm." |
| 2–5 s | It rolls forward about 20 cm | "Forward one second." | *forward 1 second* |
| 5–8 s | It turns left, then spins | "Turn left. Spin." | *turn left · spin* |
| 8–12 s | A shoebox comes into frame; it rolls toward it and stops short | "Forward two seconds." | **"Something is in my way (about 30 cm ahead)."** |
| 12–15 s | Hold, then the charcoal end card with the smiling mark | — | "Free in the lab. Android Chrome + ARCore." / "Twin only. Real AX-1: planned." / "Your phone is the brain. Open for everything else." |

Alt text: "A phone camera view of a living-room floor. AX-1 Rover's twin stands with a shadow, drives forward, turns,
spins and stops in front of a shoebox." 6 s TikTok cut: shots 1, 2 and 4. Don't film the iPhone camera view or "what do
you see?" for the hero.

---

## 4. Your checklist

**Before Day 1**
1. Lock the handle on X, Discord, Instagram, TikTok, YouTube, GitHub (Telegram and Farcaster optional). Same name, logo and bio everywhere.
2. 2FA with a hardware key on every account; recovery codes offline.
3. Pinned post on each profile: official links (site, OpenSea, GitHub) and "we never DM first".
4. Discord: `#start-here`, `#rules`, `#announcements`, `#signal`, `#lab-help`, `#phone-brain`, `#runs`, `#build-log`, `#allowlist`, `#mint-support`, `#ideas`, `#holders` (locked). Roles as above. Verification gate; links off for new members; auto-warning on "mint link".
5. Brief 3–5 moderators: FAQ, this do/don't list, the price answer ("We don't comment on price").
6. Build the hidden Codex page and the code puzzle; test it with two people.
7. Schedule weeks 1–2. Render the kit (`npm run marketing`, `npm run brand`).
8. Press kit: one page, the three pillars, five screenshots, logo files, the CC0 note, a contact.
9. Outreach list of 20: LeRobot / Hugging Face community, SO-101 builders, OpenBot, maker forums, STEM educators,
   robotics creators. Personal messages offering something useful (the Workbench, CC0 assets, a demo), never a request
   to promote. Name other projects only as "inspired by", never as partners.
10. Legal review (section 6) before any mint announcement; terms of sale with "18+ to mint"; privacy notice.

**During the launch**
11. A moderator on shift for every announcement; daily impersonation sweep.
12. Sunday build log, delays admitted early.
13. Archive every post and approval in one document.
14. After the sale: publish the reveal-draw method, then the draw.

---

## 5. Do / don't

| Do | Don't |
|---|---|
| "agent", "pilot", "lab", "access", "record" | "invest", "returns", "passive income", "floor goes up" |
| "Planned" on every future item | "guaranteed", "soon", "will" for unreleased things |
| Real runs and real bugs | Fake countdowns, fake scarcity, fake testimonials |
| "Designed to stop and hold" | "Safe" without the qualifier; a real AX-1 driving today |
| Mint links only to OpenSea | Links in DMs; any other mint site |
| Agents are the heart of the lab (never "optional") | Component prices, cost comparisons, "cheap robot" |

---

## 6. Risks to brief your lawyer on

1. **Investment framing.** No profit, appreciation or revenue-share language; earning only through work (prizes, bounties, own kits), and only as planned items.
2. **MiCA / EU.** A 1,024-piece series with a treasury and holder votes: get an EU opinion on classification and sale disclosures; check prizes, AML and tax where the team and treasury sit.
3. **Minors and classrooms.** The lab is wallet-free; keep an education entry with no mint calls to action; "18+ to mint"; no student data collected.
4. **"Verified" claims.** Simulation runs, not real-robot certificates. Real-robot records come later.
5. **Hardware honesty.** Firmware untested on hardware until the first build: say it wherever Bluetooth control appears.
6. **Third-party names.** SO-101, OpenBot, LeRobot: "inspired by", never partnership, unless in writing.
7. **Royalty.** The 5% funds the treasury; marketplaces may not always enforce it.
