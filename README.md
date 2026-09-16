# TypeSafe Pixels

A small Next.js app where TypeSafe's Jev decides every channel of every pixel
in a pixel-art image. The code only builds the questions and draws the answers.

## What it does

1. **API key** – entered in the browser, kept in `localStorage`, forwarded per
   request through a tiny proxy function. Never stored server-side.
2. **Image expectation** – the one sentence the model gets about the picture.
3. **Grid size** and **alpha on/off**.
4. **Request JSON** – the exact `state` + `questions`, one question per line,
   with copy/download. Paste into `console.typesafe.ai/playground` or POST it.
5. **Drawing** – a canvas that fills in live as answers arrive, plus PNG export,
   and the **Pixel JSON** (`IMAGE EXPECTATION`, then `X1 Y1 → R, G, B, A`).
   Made to be screen-recorded: answered pixels pop in at a steady ~55 px/s in
   the order they were asked (a left-to-right sweep, smooth even though the API
   answers in bursts), and captions fade in and out over the canvas narrating
   the run: your prompt, "Jev decides the composition", the decision, painting
   progress, and "Done" when the last pixel lands. Respects reduced motion.

## The protocol (no hints to the model)

- `state`: the expectation plus what X, Y and the channels mean. Nothing about
  what any pixel should look like.
- One **Score** question per channel per pixel. Instructions are just `X1 Y1 R`.
  Criteria are 10 anchors across 1–256 (TypeSafe's maximum levels).
- Rebuild a channel from Jev's probability distribution. Default **sharpen³**:
  raise each anchor's probability to the 3rd power, renormalise, average.
  Measured at 16×16, Jev's distributions are flat (confidence ≈ 0.1, no anchor
  ever above 50%), so the plain weighted mean collapses to muddy midtones;
  sharpening restores bold, flat pixel-art colour without argmax's coin-toss
  pixels. Switch decoders live in the UI, no new requests.
- Three prompt styles, none describing the scene: `lean` (bare protocol),
  `tuned` (explains what the numbers mean, asks Jev to decide the whole picture
  first), `bold` (tuned + a pixel-art style instruction). Measured saturation at
  16×16, mean-decoded: 29 → 79 → 85; bold + sharpen³ ≈ 163. The scene features
  themselves (a sun, a sand strip) come from the **image expectation** field.
- **Shared context.** TypeSafe scores every question on its own, so no pixel
  knows what another got, batched or not. Measured: neighbours across a batch
  boundary are exactly as consistent as neighbours inside one, so batching is
  not the problem; the lack of any joint decision is. By default the app first
  asks Jev five scene-agnostic composition questions, once (where the main
  boundary between the two largest areas falls; whether there is a focal
  object, where, how big) and puts the answers into every request's state as
  about 60 tokens of words with pixel ranges. Measured: consistent placement
  (a crisp boundary on the agreed row, a centred focal region) for +0.6%
  tokens at 32×32 and +1.4% at 16×16. A numeric colour sketch in the state was
  tried first and rejected: with per-question block tags it tiles the picture
  at the block size (seam ratio 16–21×); without them the model mis-maps pixel
  rows onto sketch rows and scrambles.

## Why the browser loops instead of the server

A single request with thousands of questions exceeds TypeSafe's token limit,
and a Vercel function times out at about 60 s. So the page sends chunks (default
200 questions), one proxy call each. If TypeSafe rejects a request as too big
the chunk halves and retries; `429`/`529` back off exponentially; and a stopped
or failed run continues where it left off.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

Push this folder to a Git repo and import it at vercel.com, or:

```bash
npx vercel
```

Next.js is detected automatically. No environment variables are needed; the
key is supplied in the UI.

## Files

- `app/page.js` – the UI and the chunked run loop
- `app/api/systemone/route.js` – proxy to `https://api.typesafe.ai/v1/systemone`
- `lib/pixels.js` – state/question builders, 1–256 mapping, pixel JSON rebuild
