// The protocol. Kept identical to the Python (generate_playground_json.py /
// run_typesafe_pixels.py) so the app sends exactly what the runner sends.
// Nothing here describes the scene; the only scene words are the user's
// image expectation.
//
//   state    = image expectation + what X, Y and the channels mean. `tuned` adds
//              what the numbers mean (1 = none, 256 = max, white/black anchors) and
//              a nudge to decide the whole picture first so independent per-pixel
//              answers cohere. `bold` adds a pixel-art style instruction.
//   question = one Score per channel per pixel; criteria are 10 anchors across
//              1-256, the most levels TypeSafe allows.
//   brief    = TypeSafe scores every question on its own against the state, so no
//              pixel ever knows what another pixel got, batched or not. The brief
//              gives them one shared decision: five scene-agnostic composition
//              questions asked once (where the main boundary between the two
//              largest areas falls; whether there is a focal object, where, how
//              big), whose answers go into every paint request's state as ~60
//              tokens of words with pixel ranges. Measured at 16x16: consistent
//              placement for +1.4% tokens. (A numeric colour sketch in the state
//              was measured to tile the picture at the block size, or to scramble
//              without block tags, so it is not used.)
//   decode   = how a Score's probability distribution becomes a channel value.
//              Jev's distributions here are flat (confidence ~0.1), so the plain
//              weighted mean collapses to midtones; sharpening restores contrast.

export const MODEL = 'jev-latest';
export const LEVELS = Array.from({ length: 10 }, (_, i) => String(Math.round(1 + (i * 255) / 9)));
export const ANCHORS = LEVELS.map(Number);

export const PROMPTS = [
  { id: 'bold',  label: 'Bold: pixel-art style, commit to values (recommended)' },
  { id: 'tuned', label: 'Tuned: explain what the numbers mean' },
  { id: 'lean',  label: 'Lean: bare protocol only' },
];

export const DECODES = [
  { id: 'sharp3', label: 'Pixel art (sharpen ³)',       hint: 'Bold, flat colours with smooth gradients. Default.' },
  { id: 'sharp5', label: 'Punchier (sharpen ⁵)',        hint: 'More contrast, still averaged.' },
  { id: 'argmax', label: 'Posterised (argmax)',         hint: 'The single most likely anchor. Maximum contrast, some coin-toss pixels.' },
  { id: 'mean',   label: 'Faithful (weighted mean)',    hint: "TypeSafe's own score. Honest, but muddy midtones." },
];

const NAMES = { R: 'red', G: 'green', B: 'blue', A: 'opacity' };
const join = (items, word) =>
  items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;

export function channelsFor(alpha) {
  return alpha ? 'RGBA' : 'RGB';
}

// ---------------------------------------------------------------------------
// composition brief
// ---------------------------------------------------------------------------

const HORIZ = ['near the left edge', 'left of centre', 'in the centre', 'right of centre', 'near the right edge'];
const VERT = ['near the top', 'in the upper part', 'in the middle', 'in the lower part', 'near the bottom'];
const SIZES = ['tiny, a few pixels', 'small, under a quarter of the width',
  'medium, about a third of the width', 'large, half the width or more'];
const SIZE_FRACTION = [0.08, 0.20, 0.33, 0.50];   // focal object's diameter as a fraction of the width, per level

export const BRIEF_QUESTIONS = {
  boundary: { type: 'score', criteria: VERT,
    instructions: "Where, top to bottom, does the main boundary between the picture's two largest areas fall?" },
  focal_present: { type: 'noul',
    instructions: 'Does the picture have one clear focal object that the eye goes to first (for example a sun, a moon, a face, a building)?' },
  focal_x: { type: 'score', criteria: HORIZ, instructions: 'Where is that focal object horizontally?' },
  focal_y: { type: 'score', criteria: VERT, instructions: 'Where is that focal object vertically?' },
  focal_size: { type: 'score', criteria: SIZES, instructions: 'How big is that focal object compared with the whole picture?' },
};

// Sharpened expected level index (same sharpening as the pixel decoder).
function sharpIndex(answer, k = 3) {
  const p = answer.probabilities;
  const n = Object.keys(p).length;
  let s = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(p[String(i)] ?? 0, k);
    s += w;
    acc += i * w;
  }
  return s ? acc / s : 0;
}

// Decode the five answers into pixel positions on a size x size grid.
export function briefFromAnswers(answers, size) {
  const toPx = (a) => Math.max(1, Math.min(size, Math.round(((sharpIndex(a) + 1) / 6) * size)));
  const s = sharpIndex(answers.focal_size);
  const lo = Math.min(Math.floor(s), SIZE_FRACTION.length - 1);
  const hi = Math.min(lo + 1, SIZE_FRACTION.length - 1);
  const t = s - lo;
  const half = Math.max(1, Math.round((((1 - t) * SIZE_FRACTION[lo] + t * SIZE_FRACTION[hi]) * size) / 2));
  const fx = toPx(answers.focal_x);
  const fy = toPx(answers.focal_y);
  const p = answers.focal_present.noul;
  return {
    boundary_row: toPx(answers.boundary), focal: p >= 0.5, focal_p: p,
    x1: Math.max(1, fx - half), x2: Math.min(size, fx + half), y1: Math.max(1, fy - half), y2: Math.min(size, fy + half),
  };
}

export function buildBriefText(brief, size) {
  const focal = brief.focal
    ? ` The focal object sits around columns ${brief.x1}-${brief.x2}, rows ${brief.y1}-${brief.y2}.`
    : ' There is no single focal object.';
  return (
    `PLAN (your own earlier decisions about this picture): the main boundary between its two largest ` +
    `areas runs at about row ${brief.boundary_row} of ${size}, counting from the top.${focal} ` +
    `Keep every pixel consistent with this.`
  );
}

// ---------------------------------------------------------------------------
// state and questions
// ---------------------------------------------------------------------------

export function buildState(expectation, size, chans, prompt = 'bold', planText = null) {
  if (prompt === 'lean') {
    const short = [...chans].map((c) => (c === 'A' ? 'A (opacity)' : c));
    const text =
      `IMAGE EXPECTATION: ${expectation}, ${size}x${size} pixels. ` +
      `Each question names one pixel by X (column, 1-${size}, left to right) and ` +
      `Y (row, 1-${size}, top to bottom) and one channel: ${join(short, 'or')}. ` +
      `Answer that channel's value on the 1-256 scale.`;
    return planText ? `${text}\n${planText}` : text;
  }
  const channels = join([...chans].map((c) => `${c} = ${NAMES[c]}`), 'and');
  const decide = planText
    ? "You already decided the picture's composition (see PLAN); answer each question so that all "
    : 'Decide the whole picture first, then answer each question so that all ';
  let text =
    `IMAGE EXPECTATION: ${expectation}, drawn as ${size}x${size} pixel art. ` +
    `${decide}${size * size} pixels together form that picture. ` +
    `Each question names one pixel by X (column: 1 is the left edge, ${size} is the right edge) ` +
    `and Y (row: 1 is the top edge, ${size} is the bottom edge), and one channel. ` +
    `Channels are the pixel's light components: ${channels}. ` +
    `1 means none of that component and 256 means the maximum. ` +
    `White is R, G and B all 256; black is all 1; a vivid colour has one or two channels high and the rest low. ` +
    `Answer with the named channel's value for the named pixel on the 1-256 scale.`;
  if (prompt === 'bold') {
    text +=
      ` This is pixel art: use flat, bold, saturated colours and the full 1-256 range. ` +
      `Commit to a definite value for each channel rather than a middle value; ` +
      `use middle values only where the colour is genuinely muted.`;
  }
  return planText ? `${text}\n${planText}` : text;
}

// One Score per channel per pixel.
export function buildQuestions(size, chans, prompt = 'bold') {
  const questions = {};
  for (let x = 1; x <= size; x++) {
    for (let y = 1; y <= size; y++) {
      for (const ch of chans) {
        const key = `X${x} Y${y} ${ch}`;
        const instructions = prompt === 'lean' ? key : `Pixel X${x} Y${y}, channel ${ch} (${NAMES[ch]})`;
        questions[key] = { type: 'score', instructions, criteria: LEVELS };
      }
    }
  }
  return questions;
}

export function toValue(score) {
  return 1 + (score * 255) / (LEVELS.length - 1);
}

// One Score answer -> a channel value on the 1-256 scale.
export function decodeValue(answer, mode = 'sharp3') {
  const p = answer.probabilities;
  if (mode === 'mean' || !p) return toValue(answer.score);
  if (mode === 'argmax') {
    let best = '0';
    for (const k in p) if (p[k] > p[best]) best = k;
    return ANCHORS[Number(best)];
  }
  const k = mode.startsWith('sharp') ? Number(mode.slice(5)) : 1;
  let sum = 0;
  let acc = 0;
  for (let i = 0; i < ANCHORS.length; i++) {
    const w = Math.pow(p[String(i)] ?? 0, k);
    sum += w;
    acc += ANCHORS[i] * w;
  }
  return sum ? acc / sum : toValue(answer.score);
}

// Answers -> the pixel JSON. A channel that was not asked (alpha off) is 256, fully opaque.
export function rebuild(answers, expectation, size, decode = 'sharp3') {
  const out = { 'IMAGE EXPECTATION': expectation };
  for (let x = 1; x <= size; x++) {
    for (let y = 1; y <= size; y++) {
      const px = {};
      for (const ch of 'RGBA') {
        const a = answers[`X${x} Y${y} ${ch}`];
        px[ch] = a ? Math.round(decodeValue(a, decode)) : 256;
      }
      out[`X${x} Y${y}`] = px;
    }
  }
  return out;
}

// The full request body, one question per line, ready for the playground or POST /v1/systemone.
export function requestJsonString(state, questions) {
  const lines = Object.entries(questions).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return (
    `{\n "state": ${JSON.stringify(state)},\n "model": ${JSON.stringify(MODEL)},\n` +
    ` "questions": {\n${lines.join(',\n')}\n }\n}`
  );
}
