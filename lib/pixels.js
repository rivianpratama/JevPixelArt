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

export function buildState(expectation, size, chans, prompt = 'bold') {
  if (prompt === 'lean') {
    const short = [...chans].map((c) => (c === 'A' ? 'A (opacity)' : c));
    return (
      `IMAGE EXPECTATION: ${expectation}, ${size}x${size} pixels. ` +
      `Each question names one pixel by X (column, 1-${size}, left to right) and ` +
      `Y (row, 1-${size}, top to bottom) and one channel: ${join(short, 'or')}. ` +
      `Answer that channel's value on the 1-256 scale.`
    );
  }
  const channels = join([...chans].map((c) => `${c} = ${NAMES[c]}`), 'and');
  let text =
    `IMAGE EXPECTATION: ${expectation}, drawn as ${size}x${size} pixel art. ` +
    `Decide the whole picture first, then answer each question so that all ` +
    `${size * size} pixels together form that picture. ` +
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
  return text;
}

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
