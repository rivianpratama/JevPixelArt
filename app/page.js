'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LEVELS, MODEL, channelsFor, buildState, buildQuestions, rebuild, requestJsonString,
} from '../lib/pixels';

const SIZES = [8, 12, 16, 24, 32, 48, 64];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Page() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [expectation, setExpectation] = useState('a pixel art sunset over a beach');
  const [size, setSize] = useState(16);
  const [alpha, setAlpha] = useState(true);
  const [chunk, setChunk] = useState(200);
  const [answers, setAnswers] = useState({});
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);
  const [tab, setTab] = useState('request');
  const stopRef = useRef(false);
  const canvasRef = useRef(null);

  // The key lives only in this browser.
  useEffect(() => {
    try { const k = localStorage.getItem('typesafe_api_key'); if (k) setApiKey(k); } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem('typesafe_api_key', apiKey); } catch {}
  }, [apiKey]);

  const chans = channelsFor(alpha);
  const state = useMemo(() => buildState(expectation, size, chans), [expectation, size, chans]);
  const questions = useMemo(() => buildQuestions(size, chans), [size, chans]);
  const keys = useMemo(() => Object.keys(questions), [questions]);
  const requestJson = useMemo(() => requestJsonString(state, questions), [state, questions]);

  // Changing the picture or the grid changes what every question means, so answers reset.
  useEffect(() => { setAnswers({}); }, [size, chans, expectation]);

  const answeredCount = useMemo(() => keys.reduce((n, k) => n + (answers[k] ? 1 : 0), 0), [keys, answers]);
  const complete = keys.length > 0 && answeredCount === keys.length;
  const pixels = useMemo(() => rebuild(answers, expectation, size), [answers, expectation, size]);
  const pixelJson = useMemo(() => JSON.stringify(pixels, null, 1), [pixels]);

  const addLog = useCallback((m) => {
    const t = new Date().toLocaleTimeString();
    setLog((l) => [...l.slice(-199), `[${t}] ${m}`]);
  }, []);

  // Draw whatever Jev has answered so far. Unanswered pixels show as a dark checker.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const scale = Math.max(1, Math.floor(512 / size));
    c.width = size * scale;
    c.height = size * scale;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 1; y <= size; y++) {
      for (let x = 1; x <= size; x++) {
        const i = ((y - 1) * size + (x - 1)) * 4;
        const done = [...chans].every((ch) => answers[`X${x} Y${y} ${ch}`]);
        if (done) {
          const p = pixels[`X${x} Y${y}`];
          img.data[i] = p.R - 1; img.data[i + 1] = p.G - 1; img.data[i + 2] = p.B - 1; img.data[i + 3] = p.A - 1;
        } else {
          const g = (x + y) % 2 ? 62 : 82;
          img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
        }
      }
    }
    const off = document.createElement('canvas');
    off.width = size; off.height = size;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(off, 0, 0, c.width, c.height);
  }, [answers, pixels, size, chans]);

  async function run() {
    if (!apiKey.trim()) { addLog('Add your TypeSafe API key first.'); return; }
    setRunning(true);
    stopRef.current = false;

    let cur = Math.max(1, Math.floor(Number(chunk)) || 200);
    let local = { ...answers };
    const todo = keys.filter((k) => !local[k]);
    addLog(`Sending ${todo.length} questions (${size}x${size}, ${chans}) in chunks of ${cur}.`);

    let i = 0;
    let delay = 2000;
    while (i < todo.length && !stopRef.current) {
      const batchKeys = todo.slice(i, i + cur);
      const batch = {};
      for (const k of batchKeys) batch[k] = questions[k];

      let res, text;
      try {
        res = await fetch('/api/systemone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-typesafe-key': apiKey.trim() },
          body: JSON.stringify({ state, model: MODEL, questions: batch }),
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
        if (cur <= 8) { addLog('Still too big at a chunk of 8. Stopping.'); break; }
        cur = Math.floor(cur / 2);
        addLog(`Too big for the API. Halving chunk to ${cur}.`);
        continue;
      }
      if (!res.ok) { addLog(`HTTP ${res.status}: ${text.slice(0, 300)}`); break; }

      let data;
      try { data = JSON.parse(text); } catch { addLog('Unreadable response from the API.'); break; }

      local = { ...local, ...(data.answers || {}) };
      setAnswers(local);
      i += batchKeys.length;
      delay = 2000;
      const u = data.usage || {};
      const n = keys.reduce((c, k) => c + (local[k] ? 1 : 0), 0);
      addLog(`${n}/${keys.length} answered · chunk ${cur} · tokens in ${u.input_tokens ?? '?'} out ${u.output_tokens ?? '?'}`);
    }

    if (stopRef.current) addLog('Stopped. Run again to continue where you left off.');
    else if (keys.every((k) => local[k])) addLog('Done. Jev has answered every pixel.');
    setRunning(false);
  }

  const copy = async (s, what) => {
    try { await navigator.clipboard.writeText(s); addLog(`Copied ${what} to the clipboard.`); }
    catch { addLog('The browser blocked the clipboard. Use Download instead.'); }
  };
  const downloadPng = () => canvasRef.current?.toBlob((b) => b && download(`pixels_${size}x${size}.png`, b));

  const preview = (s) => (s.length > 4000
    ? `${s.slice(0, 4000)}\n… ${(s.length / 1024).toFixed(0)} KB total. Use Copy or Download for the whole file.`
    : s);

  const requests = Math.ceil(keys.length / Math.max(1, Math.floor(Number(chunk)) || 1));
  const pct = keys.length ? Math.round((answeredCount / keys.length) * 100) : 0;

  return (
    <main className="wrap">
      <header>
        <h1>TypeSafe Pixels</h1>
        <p>Jev decides every channel of every pixel. Code only asks the questions and draws the answers.</p>
      </header>

      <div className="grid">
        <div className="stack">
          <section className="card">
            <h2>Setup</h2>

            <label htmlFor="key">TypeSafe API key</label>
            <div className="row">
              <input id="key" type={showKey ? 'text' : 'password'} value={apiKey} disabled={running}
                     onChange={(e) => setApiKey(e.target.value)} placeholder="ts_…" style={{ flex: 1 }}
                     autoComplete="off" />
              <button className="small" type="button" onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="hint">Kept only in this browser. Sent per request through this app's proxy, never stored server-side.</div>

            <label htmlFor="exp">Image expectation</label>
            <input id="exp" type="text" value={expectation} disabled={running}
                   onChange={(e) => setExpectation(e.target.value)} />

            <label htmlFor="size">Grid size</label>
            <select id="size" value={size} disabled={running} onChange={(e) => setSize(Number(e.target.value))}>
              {SIZES.map((s) => (
                <option key={s} value={s}>{s} × {s} — {s * s} pixels, {s * s * chans.length} questions</option>
              ))}
            </select>

            <div className="check">
              <input id="alpha" type="checkbox" checked={alpha} disabled={running}
                     onChange={(e) => setAlpha(e.target.checked)} />
              <label htmlFor="alpha" style={{ margin: 0 }}>Include alpha (A). Off = fully opaque, a quarter fewer questions.</label>
            </div>

            <label htmlFor="chunk">Questions per request</label>
            <input id="chunk" type="number" min="1" max="2000" value={chunk} disabled={running}
                   onChange={(e) => setChunk(e.target.value)} />
            <div className="hint">Halves automatically if TypeSafe says a request is too big.</div>

            <div className="stats">
              <b>{size} × {size}</b> = {size * size} pixels · <b>{keys.length}</b> questions · about <b>{requests}</b> requests<br />
              Levels: {LEVELS.join(' · ')}
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              {!running
                ? <button className="primary" onClick={run} disabled={!keys.length}>
                    {answeredCount > 0 && !complete ? 'Continue run' : complete ? 'Run again' : 'Run with TypeSafe'}
                  </button>
                : <button className="primary" onClick={() => { stopRef.current = true; }}>Stop</button>}
              <button onClick={() => { setAnswers({}); addLog('Cleared answers.'); }} disabled={running || !answeredCount}>Reset</button>
            </div>
          </section>

          <section className="card">
            <h2>What the model is told (state)</h2>
            <div className="state">{state}</div>
            <div className="hint">Nothing about what any pixel should look like. Each question is only its coordinate and channel, e.g. <code>X1 Y1 R</code>.</div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="row between">
              <h2 style={{ margin: 0 }}>Drawing</h2>
              <button className="small" onClick={downloadPng} disabled={!answeredCount}>Download PNG</button>
            </div>
            <div className="progress"><div style={{ width: `${pct}%` }} /></div>
            <div className="hint" style={{ marginBottom: 10 }}>
              {answeredCount}/{keys.length} channels answered ({pct}%){complete ? ' · complete' : running ? ' · painting…' : ''}
            </div>
            <div className="canvasWrap"><canvas ref={canvasRef} /></div>
          </section>

          <section className="card">
            <div className="row between">
              <div className="tabs">
                <button className={tab === 'request' ? 'active' : ''} onClick={() => setTab('request')}>Request JSON</button>
                <button className={tab === 'pixels' ? 'active' : ''} onClick={() => setTab('pixels')}>Pixel JSON</button>
              </div>
              <div className="row">
                {tab === 'request' ? (
                  <>
                    <button className="small" onClick={() => copy(requestJson, 'the request JSON')}>Copy</button>
                    <button className="small" onClick={() => download(`request_${size}x${size}.json`, requestJson, 'application/json')}>Download</button>
                  </>
                ) : (
                  <>
                    <button className="small" onClick={() => copy(pixelJson, 'the pixel JSON')} disabled={!answeredCount}>Copy</button>
                    <button className="small" onClick={() => download(`pixels_${size}x${size}.json`, pixelJson, 'application/json')} disabled={!answeredCount}>Download</button>
                  </>
                )}
              </div>
            </div>
            {tab === 'request' ? (
              <>
                <div className="hint" style={{ marginTop: 8 }}>
                  Exactly what gets sent, one question per line. Paste the <code>state</code> and <code>questions</code> into the playground, or POST the whole thing to <code>/v1/systemone</code>.
                </div>
                <pre>{preview(requestJson)}</pre>
              </>
            ) : (
              <>
                <div className="hint" style={{ marginTop: 8 }}>
                  {answeredCount
                    ? `Jev's values, 1-256. ${complete ? '' : 'Partial: unanswered channels read 256 until the run finishes.'}`
                    : 'Run first. This fills with IMAGE EXPECTATION, then X1 Y1 → R, G, B, A, and so on.'}
                </div>
                <pre>{answeredCount ? preview(pixelJson) : ''}</pre>
              </>
            )}
          </section>

          <section className="card">
            <h2>Log</h2>
            <div className="log">
              {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>Nothing yet.</div>}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
