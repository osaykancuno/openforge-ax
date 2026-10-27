# 19 · Hero video: "A robot with no brain"

The first launch film of AX-1. 15 s, vertical 9:16 (also cut 1:1 for X). Photoreal, made with AI video from our own
AX-1 design, then finished locally (titles, end card, sound) with the site's fonts and colours.

**Honesty rule:** there is no physical AX-1 yet. The film shows a concept, so it carries a small permanent label
**"Concept film · AI-generated · first build in progress"** and is never captioned as real footage (docs/17 §5,
docs/18). The hook works on curiosity, not on a fake claim.

## Story (15 s)

| Time | Shot | Source | Sound | On screen |
|---|---|---|---|---|
| 0.0–5.0 | **1. No brain.** Night, a wooden desk, one warm lamp. Macro, slow push-in on the AX-1 Rover body with an **empty** phone cradle. A hand enters and slides a phone into the cradle; a soft click. | Kling 3.0, start frame = keyframe A | Room tone, the click (local) | "A robot. No brain." (0.6–2.6 s) |
| 5.0–10.0 | **2. It wakes.** Same setup, the phone screen lights up with AX-1's face (two cream eyes, a terracotta mouth). It blinks, looks at the lens, the head tilts, the rover rolls a few centimetres forward. | Kling 3.0, start frame = keyframe B | A low synth swell (local) | "Good thing you own one." (5.4–7.8 s) |
| 10.0–15.0 | **3. End card.** Paper background, AX-1 mark, "Your phone is the brain." then "OpenForge AX · open robotics lab". | `npm run marketing` (local) | Soft UI chime (local) | Label stays bottom left all film |

Viral mechanics: a 1-second hook with an object everyone owns (a phone), a reveal (the face), a loopable ending (the end
card cuts back to the empty cradle), no voice-over, so it works muted with captions.

## Keyframes (GPT Image 2.5, 0.25 credits each, reference = `art/marketing/out/ref-ax1-rover-1080x1920.png`)

**A, empty cradle:**
> Photorealistic product photograph, 9:16. The small robot from the reference image, exact same design and proportions:
> a white rounded rectangular body with two large dark grey wheels, small terracotta-orange accents, a short grey neck,
> and a landscape phone cradle in dark grey with two side clamps. The cradle is EMPTY (no phone). It stands on a warm
> oak desk at night, lit by one warm desk lamp from the left, deep soft shadows, shallow depth of field, 85 mm macro
> lens, subtle dust in the light, premium tech-ad look, natural materials: matte 3D-printed PLA body, rubber tyres.
> No text, no logos, no people.

**B, awake:**
> Same scene, same camera and light as the previous image. Now a black smartphone sits in the cradle, landscape. Its
> screen glows and shows a minimal flat face: two cream oval eyes and a small terracotta horizontal mouth on pure black,
> exactly as in the reference. Faint screen glow on the desk. No text, no logos, no people.

## Motion prompts (Kling 3.0 std, 5 s, sound off, 9:16: 6.25 credits each)

**Shot 1 (start frame A):**
> Slow cinematic push-in toward the robot. At 1.5 s a human hand enters from the right holding a black smartphone and
> slides it into the empty cradle, landscape, with a small firm click; the hand leaves. The robot itself stays still.
> Warm lamp light, realistic physics, steady camera, no text.

**Shot 2 (start frame B):**
> The phone screen face blinks once, the eyes look up into the camera, the head tilts slightly to the side, then the
> robot rolls a few centimetres forward on its wheels and stops. Gentle camera drift, warm lamp light, realistic
> physics, no text.

## Budget (16 credits)

| Item | Credits |
|---|---|
| Keyframe A + B | 0.50 |
| Shot 1 + shot 2, Kling 3.0 std, 5 s, silent | 12.50 |
| Reserve: one keyframe redo + nothing else | 0.25–3.0 |
| **Total** | **≈ 13–16** |

Kling "pro" (7.50 per shot, 15 total) leaves no room for a redo: use std, judge the keyframes first, spend the video
credits only on approved frames. Seedance 2.5 costs 35 credits for 5 s: out of budget.

## Finishing (local, free)

`npm run marketing` renders the end card and titles; ffmpeg joins shot 1 + shot 2 + end card, burns the captions and
the concept label (JetBrains Mono, paper on 40 % ink), adds the sound bed, and exports
`art/marketing/out/ax1-hero-film-1080x1920.mp4` and a 1:1 cut.

## As made (2026-10-27)

Final: `art/marketing/out/ax1-hero-film-1080x1920.mp4` (14.3 s, with sound) and `ax1-hero-film-1080x1080.mp4`.
Rebuild the local parts any time with `node scripts/hero-film.mjs` (no credits).

| Time | What | Source |
|---|---|---|
| 0.0–2.6 | The digital twin on the lab grid turns into the keyframe's exact angle: "Your old phone is about to get a body." | local render (TWIN label) |
| 2.1–3.3 | Cross-fade from the twin to the real photo: "Designed in an open 3D lab." | keyframe A (`art/marketing/hero/keyframe-a.png`) |
| 3.3–6.3 | A hand slides a phone in; the face wakes: "Built for your desk." | Kling 3.0 std, 3 s, start A → end B (`shot1.mp4`) |
| 6.3–11.3 | AX-1 tilts its head, looks at you and rolls up to the lens: "Meet AX-1." | Kling 3.0 std, 5 s, start B (`shot2.mp4`) |
| 10.9–14.3 | End card: "Your phone is the brain. From the 3D lab to your desk." | local render |

Credits spent: 15.0 of 16.3 (two keyframes at high quality 1.5 each, shot 2 at 7.5, shot 1 at 4.5: the image-to-video
price was higher than the text-only preflight, so shot 1 was cut to 3 s). The concept label stays on every real-looking
frame. For TikTok/Reels, post it with a trending sound under the built-in bed.
