// The lean protocol. Same as the Python generator, so the app sends exactly
// what you would paste into the TypeSafe playground.
//
//   state    = image expectation + what X, Y and the channels mean. No scene hints.
//   question = one Score per channel per pixel, instructions are just "X1 Y1 R",
//              criteria are 10 anchors across 1-256 (the most levels TypeSafe allows).
//   rebuild  = value = 1 + score * 255 / 9

export const MODEL = 'jev-latest';
export const LEVELS = Array.from({ length: 10 }, (_, i) => String(Math.round(1 + (i * 255) / 9)));

const NAMES = { R: 'R', G: 'G', B: 'B', A: 'A (opacity)' };

export function channelsFor(alpha) {
  return alpha ? 'RGBA' : 'RGB';
}

export function buildState(expectation, size, chans) {
  const names = [...chans].map((c) => NAMES[c]);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return (
    `IMAGE EXPECTATION: ${expectation}, ${size}x${size} pixels. ` +
    `Each question names one pixel by X (column, 1-${size}, left to right) and ` +
    `Y (row, 1-${size}, top to bottom) and one channel: ${list}. ` +
    `Answer that channel's value on the 1-256 scale.`
  );
}

export function buildQuestions(size, chans) {
  const questions = {};
  for (let x = 1; x <= size; x++) {
    for (let y = 1; y <= size; y++) {
      for (const ch of chans) {
        const key = `X${x} Y${y} ${ch}`;
        questions[key] = { type: 'score', instructions: key, criteria: LEVELS };
      }
    }
  }
  return questions;
}

export function toValue(score) {
  return 1 + (score * 255) / (LEVELS.length - 1);
}

// Answers -> your pixel JSON. A channel that was not asked (alpha disabled) is 256, fully opaque.
export function rebuild(answers, expectation, size) {
  const out = { 'IMAGE EXPECTATION': expectation };
  for (let x = 1; x <= size; x++) {
    for (let y = 1; y <= size; y++) {
      const px = {};
      for (const ch of 'RGBA') {
        const a = answers[`X${x} Y${y} ${ch}`];
        px[ch] = a ? Math.round(toValue(a.score)) : 256;
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
