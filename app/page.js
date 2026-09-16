'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LEVELS, MODEL, PROMPTS, DECODES, BRIEF_QUESTIONS, channelsFor, briefFromAnswers, buildBriefText,
  buildState, buildQuestions, rebuild, requestJsonString,
} from '../lib/pixels';

const SIZES = [8, 12, 16, 24, 32, 48, 64];
const CHANNEL_COLOR = { R: 'var(--r)', G: 'var(--g)', B: 'var(--b)', A: 'var(--ink)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reveal: answered pixels queue up and pop in at a steady pace, in the order they were asked,
// so the picture sweeps in smoothly even though the API answers in bursts.
const REVEAL_RATE = 55;          // pixels per second
const REVEAL_MS = 420;           // one pixel's pop-in
const CAPTION_HOLD = 1500;       // ms a caption stays fully visible
const CAPTION_HOLD_BUSY = 800;   // shorter when more captions are waiting, so they catch up
const CAPTION_FADE = 320;        // ms for its fade in / out
const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Per-browser convenience state (which panels are open, whether the drawer is out).
function usePersisted(key, initial) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try { const raw = localStorage.getItem(key); if (raw != null) setValue(JSON.parse(raw)); } catch {}
  }, [key]);
  const set = useCallback((next) => {
    setValue((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
      return v;
    });
  }, [key]);
  return [value, set];
}

const Chevron = ({ open }) => (
  <svg className={`chev ${open ? 'open' : ''}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Seg({ value, onChange, options }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={value === o.id}
                className={value === o.id ? 'active' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A rail section that folds. When closed it shows a one-line summary so it still reads at a glance.
function Panel({ id, title, summary, open, onToggle, children }) {
  return (
    <section className={`panel ${open ? '' : 'closed'}`}>
      <button type="button" className="head toggle" onClick={() => onToggle(id)} aria-expanded={open} aria-controls={`${id}-body`}>
        <span className="eyebrow">{title}</span>
        {!open && summary && <span className="summary">{summary}</span>}
        <Chevron open={open} />
      </button>
      <div id={`${id}-body`} className="body" hidden={!open}>{children}</div>
    </section>
  );
}

export default function Page() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [expectation, setExpectation] = useState('a pixel art sunset over a beach');
  const [size, setSize] = useState(16);
  const [alpha, setAlpha] = useState(false);
  const [prompt, setPrompt] = useState('bold');
  const [briefFirst, setBriefFirst] = useState(true);
  const [decode, setDecode] = useState('sharp3');
  const [chunk, setChunk] = useState(200);
  const [brief, setBrief] = useState(null);        // { answers, brief, text } after phase 1
  const [answers, setAnswers] = useState({});
  const [running, setRunning] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [usage, setUsage] = useState({ input: 0, output: 0, requests: 0 });
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState('request');
  const [caption, setCaption] = useState(null);
  const [captionOn, setCaptionOn] = useState(false);
  const [panels, setPanels] = usePersisted('tp_panels', { key: true, picture: true, model: true });
  const [drawer, setDrawer] = usePersisted('tp_drawer', false);
  const stopRef = useRef(false);
  const canvasRef = useRef(null);

  // The key lives only in this browser.
  useEffect(() => {
    try { const k = localStorage.getItem('typesafe_api_key'); if (k) setApiKey(k); } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem('typesafe_api_key', apiKey); } catch {}
  }, [apiKey]);

  const togglePanel = useCallback((id) => setPanels((p) => ({ ...p, [id]: !p[id] })), [setPanels]);

  const chans = channelsFor(alpha);
  const state = useMemo(() => buildState(expectation, size, chans, prompt, brief?.text ?? null), [expectation, size, chans, prompt, brief]);
  const questions = useMemo(() => buildQuestions(size, chans, prompt), [size, chans, prompt]);
  const keys = useMemo(() => Object.keys(questions), [questions]);
  const requestJson = useMemo(() => requestJsonString(state, questions), [state, questions]);

  const answeredCount = useMemo(() => keys.reduce((n, k) => n + (answers[k] ? 1 : 0), 0), [keys, answers]);
  const complete = keys.length > 0 && answeredCount === keys.length;
  const pixels = useMemo(() => rebuild(answers, expectation, size, decode), [answers, expectation, size, decode]);
  const pixelJson = useMemo(() => JSON.stringify(pixels, null, 1), [pixels]);

  const addLog = useCallback((m) => {
    const t = new Date().toLocaleTimeString();
    setLog((l) => [...l.slice(-199), `[${t}] ${m}`]);
  }, []);

  function fmt(n) { return n.toLocaleString(); }

  // ---------- captions over the canvas: queued, each fades in, holds, fades out ----------
  const capQueue = useRef([]);
  const capBusy = useRef(false);
  const pumpRef = useRef(null);
  pumpRef.current = () => {
    if (capBusy.current || !capQueue.current.length) return;
    capBusy.current = true;
    setCaption(capQueue.current.shift());
    const hold = capQueue.current.length ? CAPTION_HOLD_BUSY : CAPTION_HOLD;
    requestAnimationFrame(() => setCaptionOn(true));
    setTimeout(() => setCaptionOn(false), CAPTION_FADE + hold);
    setTimeout(() => { setCaption(null); capBusy.current = false; pumpRef.current(); }, CAPTION_FADE * 2 + hold);
  };
  const say = useCallback((text) => { capQueue.current.push(text); pumpRef.current(); }, []);

  // "Done" waits for the last pixel to land, not for the last API response.
  const pendingDone = useRef(null);
  function flushDone() {
    if (pendingDone.current == null) return;
    const { secs, n } = pendingDone.current;
    pendingDone.current = null;
    say(`Done · ${fmt(n)} pixels in ${secs} s`);
  }

  // ---------- the reveal: draw loop over a queue of newly answered pixels ----------
  const latest = useRef({});
  latest.current = { pixels, answers, size, chans };
  // queue items are { k, at }: each pixel has an absolute reveal time, so a throttled tab catches up to the clock.
  const anim = useRef({ revealed: new Map(), queue: [], queued: new Set(), raf: 0, nextAt: 0 });

  const drawRef = useRef(null);
  drawRef.current = (now = performance.now()) => {
    const c = canvasRef.current;
    if (!c) return;
    const { pixels, size } = latest.current;
    const a = anim.current;
    const scale = Math.max(1, Math.floor(512 / size));
    if (c.width !== size * scale) { c.width = size * scale; c.height = size * scale; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    for (let y = 1; y <= size; y++) {
      for (let x = 1; x <= size; x++) {
        const px = (x - 1) * scale;
        const py = (y - 1) * scale;
        const g = (x + y) % 2 ? 224 : 236;
        ctx.fillStyle = `rgb(${g},${g + 1},${g + 3})`;
        ctx.fillRect(px, py, scale, scale);
        const t = a.revealed.get(`X${x} Y${y}`);
        if (t === undefined) continue;
        const q = pixels[`X${x} Y${y}`];
        const p = Math.min(1, (now - t) / REVEAL_MS);
        const e = 1 - Math.pow(1 - p, 3);
        const s = scale * (0.55 + 0.45 * e);
        const o = (scale - s) / 2;
        ctx.globalAlpha = e * ((q.A - 1) / 255);
        ctx.fillStyle = `rgb(${q.R - 1},${q.G - 1},${q.B - 1})`;
        ctx.fillRect(px + o, py + o, s, s);
        if (p < 0.4) {                                   // a brief flash as it lands
          ctx.globalAlpha = (0.4 - p) * 1.1;
          ctx.fillStyle = '#fff';
          ctx.fillRect(px + o, py + o, s, s);
        }
        ctx.globalAlpha = 1;
      }
    }
  };

  function loop(now) {
    const a = anim.current;
    while (a.queue.length && a.queue[0].at <= now) {       // reveal whatever is due on the wall clock
      const { k, at } = a.queue.shift();
      a.queued.delete(k);
      a.revealed.set(k, at);
    }
    drawRef.current(now);
    let animating = false;
    for (const t of a.revealed.values()) if (now - t < REVEAL_MS) { animating = true; break; }
    if (a.queue.length || animating) {
      a.raf = requestAnimationFrame(loop);
    } else {
      a.raf = 0;
      setRevealing(false);
      flushDone();
    }
  }
  function startLoop() {
    const a = anim.current;
    if (!a.raf) { setRevealing(true); a.raf = requestAnimationFrame(loop); }
  }
  function clearReveal() {
    const a = anim.current;
    a.revealed.clear(); a.queue = []; a.queued = new Set(); a.nextAt = 0;
    pendingDone.current = null;
  }
  function allRevealed() {
    const a = anim.current;
    for (let x = 1; x <= size; x++) for (let y = 1; y <= size; y++) if (!a.revealed.has(`X${x} Y${y}`)) return false;
    return true;
  }

  // Newly complete pixels join the queue in the order they were asked, each with its own reveal time,
  // spaced 1/REVEAL_RATE apart. Anything no longer complete is dropped.
  useEffect(() => {
    const a = anim.current;
    const isComplete = (k) => [...chans].every((ch) => answers[`${k} ${ch}`]);
    for (const k of [...a.revealed.keys()]) if (!isComplete(k)) a.revealed.delete(k);
    a.queue = a.queue.filter((item) => isComplete(item.k));
    a.queued = new Set(a.queue.map((item) => item.k));
    const instant = reduceMotion();
    const now = performance.now();
    a.nextAt = Math.max(a.nextAt, now);
    for (let x = 1; x <= size; x++) {
      for (let y = 1; y <= size; y++) {
        const k = `X${x} Y${y}`;
        if (isComplete(k) && !a.revealed.has(k) && !a.queued.has(k)) {
          if (instant) {
            a.revealed.set(k, 0);
          } else {
            a.nextAt += 1000 / REVEAL_RATE;
            a.queue.push({ k, at: a.nextAt });
            a.queued.add(k);
          }
        }
      }
    }
    if (a.queue.length) startLoop();
    else { drawRef.current(); if (!a.raf) flushDone(); }
  }, [answers, size, chans, pixels]);   // pixels too: a decoder switch recolours what is already revealed

  // Changing the picture, the grid, the prompt or the brief setting changes what every question means,
  // so answers and brief reset. Changing the decoder does not: it re-reads the answers you already paid for.
  useEffect(() => {
    clearReveal();
    setAnswers({}); setBrief(null); setUsage({ input: 0, output: 0, requests: 0 }); setStopped(false);
  }, [size, chans, expectation, prompt, briefFirst]);

  // Send a set of questions against one state, in chunks that hold whole columns. Returns what was answered.
  async function sendAll(stateText, qs, perCol, startChunk, have, isPaint) {
    let cur = Math.max(perCol, Math.floor(startChunk / perCol) * perCol);
    let local = { ...have };
    const ks = Object.keys(qs);
    const todo = ks.filter((k) => !local[k]);
    let i = 0;
    let delay = 2000;
    while (i < todo.length && !stopRef.current) {
      const batchKeys = todo.slice(i, i + cur);
      const batch = {};
      for (const k of batchKeys) batch[k] = qs[k];

      let res, text;
      try {
        res = await fetch('/api/systemone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-typesafe-key': apiKey.trim() },
          body: JSON.stringify({ state: stateText, model: MODEL, questions: batch }),
        });
        text = await res.text();
      } catch (e) {
        addLog(`Network error: ${e.message}. Retrying in ${delay / 1000}s.`);
        await sleep(delay); delay = Math.min(delay * 2, 60000);
        continue;
      }
      if (res.status === 429 || res.status === 529) {
        addLog(`${res.status} from TypeSafe. Backing off ${delay / 1000}s.`);
        await sleep(delay); delay = Math.min(delay * 2, 60000);
        continue;
      }
      if (res.status === 413 || (res.status === 400 && /token|too large|too long/i.test(text))) {
        if (cur <= perCol) { addLog('Still too big at one column per request. Stopping.'); return { local, ok: false }; }
        cur = Math.max(perCol, Math.floor(cur / 2 / perCol) * perCol);
        addLog(`Too big for the API. Halving to ${cur} questions per request.`);
        continue;
      }
      if (!res.ok) { addLog(`HTTP ${res.status}: ${text.slice(0, 300)}`); return { local, ok: false }; }

      let data;
      try { data = JSON.parse(text); } catch { addLog('Unreadable response from the API.'); return { local, ok: false }; }

      local = { ...local, ...(data.answers || {}) };
      i += batchKeys.length;
      delay = 2000;
      const u = data.usage || {};
      setUsage((s) => ({ input: s.input + (u.input_tokens || 0), output: s.output + (u.output_tokens || 0), requests: s.requests + 1 }));
      if (isPaint) {
        const n = ks.reduce((c, k) => c + (local[k] ? 1 : 0), 0);
        addLog(`${n}/${ks.length} answered · ${cur}/request · tokens in ${u.input_tokens ?? '?'} out ${u.output_tokens ?? '?'}`);
        setAnswers(local);
      }
    }
    return { local, ok: !stopRef.current || i >= todo.length };
  }

  async function run() {
    if (!apiKey.trim()) { addLog('Add your TypeSafe API key first.'); say('Add your TypeSafe API key first'); setTab('log'); setDrawer(true); return; }
    setRunning(true);
    setStopped(false);
    setTab('log');
    stopRef.current = false;
    const t0 = performance.now();
    if (!answeredCount) say(`“${expectation}”`);

    let planText = brief?.text ?? null;

    // Phase 1: the composition brief, once. Its ~60 tokens ride along in every paint request.
    if (briefFirst && !brief) {
      const pState = buildState(expectation, size, chans, prompt);
      addLog('Deciding the composition: five questions, one request.');
      say('Jev decides the composition');
      const n = Object.keys(BRIEF_QUESTIONS).length;
      const { local, ok } = await sendAll(pState, BRIEF_QUESTIONS, n, n, {}, false);
      if (!ok || Object.keys(BRIEF_QUESTIONS).some((k) => !local[k])) {
        if (stopRef.current) { setStopped(true); addLog('Stopped during the brief.'); say('Paused'); }
        setRunning(false); return;
      }
      const b = briefFromAnswers(local, size);
      planText = buildBriefText(b, size);
      setBrief({ answers: local, brief: b, text: planText });
      const where = b.focal ? ` · focal point at ${b.x1}–${b.x2} × ${b.y1}–${b.y2}` : ' · no single focal object';
      addLog(`Composition: main boundary at row ${b.boundary_row}${where}. About ${Math.round(planText.length / 4)} tokens added to each request.`);
      say(`Composition set · boundary at row ${b.boundary_row}${where}`);
    }

    // Phase 2: the picture.
    const fState = buildState(expectation, size, chans, prompt, planText);
    const todo = keys.filter((k) => !answers[k]);
    addLog(`Painting ${todo.length} questions (${size}×${size}, ${chans}, ${prompt}${planText ? ', with brief' : ''}).`);
    say(`Painting ${fmt(size * size)} pixels, one channel at a time`);
    const { local } = await sendAll(fState, questions, size * chans.length, Math.floor(Number(chunk)) || 200, answers, true);
    setAnswers(local);

    if (stopRef.current) { setStopped(true); addLog('Stopped. Run again to continue where you left off.'); say('Paused'); }
    else if (keys.every((k) => local[k])) {
      const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
      addLog('Done. Jev has answered every pixel.');
      pendingDone.current = { secs, n: size * size };
      if (!anim.current.raf && allRevealed()) flushDone();      // otherwise the reveal loop says it when the last pixel lands
    }
    setRunning(false);
  }

  const copy = async (s, what) => {
    try { await navigator.clipboard.writeText(s); addLog(`Copied ${what} to the clipboard.`); }
    catch { addLog('The browser blocked the clipboard. Use Download instead.'); }
  };
  const downloadPng = () => canvasRef.current?.toBlob((b) => b && download(`pixels_${size}x${size}_${decode}.png`, b));

  const preview = (s) => (s.length > 4000
    ? `${s.slice(0, 4000)}\n… ${(s.length / 1024).toFixed(0)} KB total. Use Copy or Download for the whole file.`
    : s);

  const perCol = size * chans.length;
  const effChunk = Math.max(perCol, Math.floor((Math.floor(Number(chunk)) || 200) / perCol) * perCol);
  const requests = Math.ceil(keys.length / effChunk) + (briefFirst ? 1 : 0);
  const pct = keys.length ? Math.round((answeredCount / keys.length) * 100) : 0;
  const decodeInfo = DECODES.find((d) => d.id === decode);
  const busy = running || revealing;
  const statusClass = busy ? 'painting' : complete ? 'complete' : '';
  const statusText = running && briefFirst && !brief ? 'deciding' : busy ? 'painting' : complete ? 'complete' : stopped ? 'paused' : answeredCount ? 'partial' : 'idle';
  const b = brief?.brief;

  return (
    <main className={`wrap ${drawer ? 'drawer-open' : ''}`}>
      <header className="masthead">
        <div className="wordmark">
          <h1>TypeSafe Pixels</h1>
          <p>Jev decides every channel of every pixel. Code only asks the questions and draws the answers.</p>
        </div>
        <div className="row">
          <span className={`status ${statusClass}`}><i /> {statusText}</span>
          <button type="button" className={`iconbtn ${drawer ? 'active' : ''}`} onClick={() => setDrawer((d) => !d)}
                  aria-pressed={drawer} aria-controls="drawer" title={drawer ? 'Hide inspector' : 'Show inspector'}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            Inspect{log.length ? <span className="badge">{log.length}</span> : null}
          </button>
        </div>
      </header>

      <div className={`grid ${drawer ? 'with-drawer' : ''}`}>
        {/* ---------------- controls rail ---------------- */}
        <div className="stack rail">
          <Panel id="key" title="Key" open={panels.key} onToggle={togglePanel}
                 summary={apiKey ? 'key set' : 'no key yet'}>
            <div className="field">
              <label htmlFor="key">TypeSafe API key</label>
              <div className="row">
                <input id="key" className="mono grow" type={showKey ? 'text' : 'password'} value={apiKey} disabled={running}
                       onChange={(e) => setApiKey(e.target.value)} placeholder="api…" autoComplete="off" />
                <button className="small ghost" type="button" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <span className="hint">Stays in this browser. Sent per request through this app's proxy, never stored on a server.</span>
            </div>
          </Panel>

          <Panel id="picture" title="Picture" open={panels.picture} onToggle={togglePanel}
                 summary={`${size} × ${size} · ${chans}`}>
            <div className="field">
              <label htmlFor="exp">Image expectation</label>
              <input id="exp" type="text" value={expectation} disabled={running}
                     onChange={(e) => setExpectation(e.target.value)} />
              <span className="hint">The only words the model gets about the picture. Name the features you want placed (a sun on the horizon, a strip of sand) and it has something to put where.</span>
            </div>

            <div className="field">
              <label htmlFor="size">Grid</label>
              <select id="size" value={size} disabled={running} onChange={(e) => setSize(Number(e.target.value))}>
                {SIZES.map((s) => (
                  <option key={s} value={s}>{s} × {s} · {fmt(s * s)} pixels · {fmt(s * s * chans.length)} questions</option>
                ))}
              </select>
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>Channels</label>
              <div className="chips">
                {['R', 'G', 'B', 'A'].map((ch) => (
                  <span key={ch} className={`chip ${chans.includes(ch) ? '' : 'off'}`}>
                    <i style={{ background: CHANNEL_COLOR[ch] }} />{ch}
                  </span>
                ))}
              </div>
              <label className="check" htmlFor="alpha" style={{ marginTop: 10 }}>
                <input id="alpha" type="checkbox" checked={alpha} disabled={running}
                       onChange={(e) => setAlpha(e.target.checked)} />
                <span>Ask for alpha (A) too<span className="hint">Pixel art is opaque; leaving it off saves a quarter of the questions.</span></span>
              </label>
            </div>
          </Panel>

          <Panel id="model" title="Model" open={panels.model} onToggle={togglePanel}
                 summary={`${prompt} · ${effChunk}/request${briefFirst ? ' · brief' : ''}`}>
            <div className="field">
              <label htmlFor="prompt">Prompt style</label>
              <select id="prompt" value={prompt} disabled={running} onChange={(e) => setPrompt(e.target.value)}>
                {PROMPTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>

            <label className="check" htmlFor="briefFirst">
              <input id="briefFirst" type="checkbox" checked={briefFirst} disabled={running}
                     onChange={(e) => setBriefFirst(e.target.checked)} />
              <span>Decide the composition first<span className="hint">
                Every question is scored on its own, so no pixel knows what another got. This asks Jev five quick
                questions once (where the main boundary falls; whether there's a focal object, where, how big) and puts
                the answers, about 60 tokens, into every request. Roughly +1% tokens; measured to make placement consistent.
              </span></span>
            </label>

            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="chunk">Questions per request</label>
              <input id="chunk" className="mono" type="number" min="1" max="2000" value={chunk} disabled={running}
                     onChange={(e) => setChunk(e.target.value)} />
              <span className="hint">Snaps to whole columns: {effChunk} = {effChunk / perCol} column{effChunk / perCol === 1 ? '' : 's'} of {perCol}. 200 measured safe (~20k tokens); halves automatically if a request is too big.</span>
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>Answer scale</label>
              <div className="ramp" aria-hidden="true">
                {LEVELS.map((v) => { const g = Math.round(((Number(v) - 1) / 255) * 255); return <span key={v} style={{ background: `rgb(${g},${g},${g})` }} />; })}
              </div>
              <div className="ramp-labels">{LEVELS.map((v) => <span key={v}>{v}</span>)}</div>
              <span className="hint">Ten Score anchors from 1 to 256, the most levels TypeSafe allows. Jev returns a probability over them per channel.</span>
            </div>

            <div className="divider" />

            <details className="state">
              <summary>What the model is told</summary>
              <div className="text">{state}</div>
            </details>
          </Panel>

          <div className="actions">
            {!running
              ? <button className="primary" onClick={run} disabled={!keys.length}>
                  {answeredCount > 0 && !complete ? 'Continue run' : complete ? 'Run again' : 'Run with TypeSafe'}
                </button>
              : <button className="primary" onClick={() => { stopRef.current = true; }}>Stop</button>}
            <button className="ghost" onClick={() => { clearReveal(); setAnswers({}); setBrief(null); setUsage({ input: 0, output: 0, requests: 0 }); setStopped(false); addLog('Cleared answers and brief.'); }} disabled={running || (!answeredCount && !brief)}>Reset</button>
          </div>
        </div>

        {/* ---------------- stage ---------------- */}
        <div className="stack work">
          <section className="panel drawing">
            <div className="head">
              <div className="row">
                <h2 className="eyebrow">Drawing · {size} × {size}</h2>
                {briefFirst && (
                  <span className="briefchips" title="The composition Jev decided first and is told in every request">
                    {b ? (
                      <>
                        <span className="chip"><i style={{ background: 'var(--ink)' }} />boundary · row {b.boundary_row}</span>
                        {b.focal
                          ? <span className="chip"><i style={{ background: 'var(--accent)' }} />focal · {b.x1}–{b.x2} × {b.y1}–{b.y2}</span>
                          : <span className="chip off"><i />no focal object</span>}
                      </>
                    ) : <span className="chip off"><i />composition · pending</span>}
                  </span>
                )}
              </div>
              <div className="row">
                <Seg value={decode} onChange={setDecode} options={DECODES.map((d) => ({ id: d.id, label: d.label.replace(/\s*\(.*\)$/, '') }))} />
                <button className="small" onClick={downloadPng} disabled={!answeredCount}>Download PNG</button>
              </div>
            </div>
            <div className="body stage">
              <div className="plate">
                <canvas ref={canvasRef} aria-label="Jev's pixels" />
                <div className="caption" aria-live="polite">
                  {caption && <span className={captionOn ? 'show' : ''}>{caption}</span>}
                </div>
              </div>
              <div className="row between" style={{ marginTop: 14, marginBottom: 6 }}>
                <span className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  <b style={{ color: 'var(--ink)', fontWeight: 500 }}>{decodeInfo?.label}.</b> {decodeInfo?.hint} Switching re-decodes the answers you already have; no new requests.
                </span>
                <span className="hint" style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{pct}%</span>
              </div>
              <div className="progress"><i style={{ width: `${pct}%` }} /></div>
            </div>
            <div className="stats">
              <div className="stat"><b>{fmt(size * size)}</b><span>pixels</span></div>
              <div className="stat"><b>{fmt(answeredCount)}<small> / {fmt(keys.length)}</small></b><span>channels answered</span></div>
              <div className="stat"><b>{usage.requests ? fmt(usage.requests) : fmt(requests)}</b><span>{usage.requests ? 'requests made' : 'requests planned'}</span></div>
              <div className="stat"><b>{usage.input ? fmt(usage.input) : '—'}</b><span>tokens in{usage.output ? ` · ${fmt(usage.output)} out` : ''}</span></div>
            </div>
          </section>
        </div>

        {/* ---------------- inspector drawer ---------------- */}
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
        <aside id="drawer" className={`drawer ${drawer ? 'open' : ''}`} aria-label="Inspector" aria-hidden={!drawer}>
          <section className="panel fill">
            <div className="head">
              <Seg value={tab} onChange={setTab} options={[
                { id: 'request', label: 'Request' },
                { id: 'pixels', label: 'Pixels' },
                { id: 'log', label: log.length ? `Log · ${log.length}` : 'Log' },
              ]} />
              <div className="row">
                {tab === 'request' && (
                  <>
                    <button className="small ghost" onClick={() => copy(requestJson, 'the request JSON')}>Copy</button>
                    <button className="small" onClick={() => download(`request_${size}x${size}.json`, requestJson, 'application/json')}>Download</button>
                  </>
                )}
                {tab === 'pixels' && (
                  <>
                    <button className="small ghost" onClick={() => copy(pixelJson, 'the pixel JSON')} disabled={!answeredCount}>Copy</button>
                    <button className="small" onClick={() => download(`pixels_${size}x${size}_${decode}.json`, pixelJson, 'application/json')} disabled={!answeredCount}>Download</button>
                  </>
                )}
                {tab === 'log' && (
                  <button className="small ghost" onClick={() => setLog([])} disabled={!log.length}>Clear</button>
                )}
                <button className="small ghost close" onClick={() => setDrawer(false)} aria-label="Hide inspector">✕</button>
              </div>
            </div>
            {tab !== 'log' && (
              <div className="note">
                {tab === 'request'
                  ? <>Exactly what gets sent for the picture, one question per line.{briefFirst && !brief ? ' The PLAN sentence joins the state after the brief.' : ''} Paste <code>state</code> and <code>questions</code> into the playground, or POST the whole body to <code>/v1/systemone</code>.</>
                  : answeredCount
                    ? <>Jev's values, 1–256, decoded with {decodeInfo?.label}.{complete ? '' : ' Partial: unanswered channels read 256 until the run finishes.'}</>
                    : <>Run first. This fills with <code>IMAGE EXPECTATION</code>, then <code>X1 Y1</code> → R, G, B, A, and so on.</>}
              </div>
            )}
            {tab === 'log'
              ? <div className="log">{log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>Nothing yet. Add a key and press Run.</div>}</div>
              : <pre>{tab === 'request' ? preview(requestJson) : answeredCount ? preview(pixelJson) : ' '}</pre>}
          </section>
        </aside>
      </div>
    </main>
  );
}
