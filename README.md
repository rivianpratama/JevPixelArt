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

## The protocol (no hints to the model)

- `state`: the expectation plus what X, Y and the channels mean. Nothing about
  what any pixel should look like.
- One **Score** question per channel per pixel. Instructions are just `X1 Y1 R`.
  Criteria are 10 anchors across 1–256 (TypeSafe's maximum levels).
- Rebuild a channel: `value = 1 + score * 255 / 9`.

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
