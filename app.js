'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('hmp_' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('hmp_' + k, JSON.stringify(v)); } catch { /* private mode */ }
  },
};

const state = {
  key: store.get('key', ''),
  model: store.get('model', 'google/gemini-2.5-flash'),
  tone: store.get('tone', 'friendly'),
  autoSpeak: store.get('autoSpeak', true),
  rate: store.get('rate', 0.95),
  dir: 'th-en',
};

const TONES = { casual: 'สบาย ๆ', friendly: 'เป็นกันเอง', polite: 'สุภาพ' };
const TONE_PROMPT = {
  casual: 'casual, relaxed, the way close friends text or talk',
  friendly: 'friendly and natural, neither slangy nor stiff',
  polite: 'polite and respectful, suitable for someone you do not know well or a professional setting',
};

/* ---------- OpenRouter ---------- */

async function llm(messages, onDelta, signal) {
  if (!state.key) throw new Error('ยังไม่ได้ใส่ OpenRouter API key (ไปที่แท็บตั้งค่า)');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': 'Bearer ' + state.key,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'HelpMePud',
    },
    body: JSON.stringify({ model: state.model, messages, stream: true, temperature: 0.3 }),
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue; // รวม keep-alive comment ": OPENROUTER PROCESSING"
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(j.error.message || 'model error');
      const d = j.choices?.[0]?.delta?.content;
      if (d) { full += d; onDelta?.(full); }
    }
  }
  if (!full.trim()) throw new Error('โมเดลไม่ตอบกลับ ลองเปลี่ยนโมเดลในตั้งค่า');
  return full;
}

/* ---------- prompts ---------- */

function translatePrompt(dir, tone) {
  if (dir === 'th-en') {
    return `You help a Thai speaker who is not fluent in English talk with international friends.
Translate the user's Thai into natural English that a native speaker would actually say. Tone: ${TONE_PROMPT[tone]}.
Keep the meaning, do not add new information, do not explain. If the Thai is ambiguous, choose the most likely meaning in context.
Reply in exactly this format and nothing else:
EN: <the English>
TH: <a short Thai back-translation of your English, so the user can check it says what they meant>`;
  }
  return `You help a Thai speaker understand English messages from international friends.
Translate the user's English into natural Thai (spoken style, not textbook).
Reply in exactly this format and nothing else:
TH: <the Thai translation>
NOTE: <only if there is slang, an idiom, sarcasm or a tone the Thai reader might miss, one short Thai sentence explaining it; otherwise leave this line out>`;
}

const ASK_PROMPT = `You are an English coach for a Thai speaker who talks with international friends but is not fluent.
Answer in Thai. When the user asks how to say something, give 2 to 4 English options. For each: the English phrase, when it fits (tone, how close you are to the person), and one short example sentence.
Name the option you would pick first. If a literal translation of the Thai would sound odd or rude in English, say so.
Keep it short and practical. Use plain text, a "- " bullet per option, no tables.`;

function parseLabeled(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*(EN|TH|NOTE)\s*:\s*(.*)$/i);
    if (m) { cur = m[1].toUpperCase(); out[cur] = m[2]; }
    else if (cur && raw.trim()) out[cur] += '\n' + raw.trim();
  }
  if (!out.EN && !out.TH) out.TH = text.trim(); // โมเดลไม่ทำตามรูปแบบ แสดงข้อความดิบ
  return out;
}

/* ---------- speech ---------- */

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = state.rate;
  const v = speechSynthesis.getVoices().find((x) => x.lang === 'en-US') ||
            speechSynthesis.getVoices().find((x) => x.lang.startsWith('en'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRec = null;

function listen(lang, btn, onText) {
  if (activeRec) { activeRec.stop(); return; }
  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  const label = btn.textContent;
  let finalText = '';
  let interim = '';
  rec.onresult = (e) => {
    finalText = ''; interim = '';
    for (const r of e.results) (r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript));
    btn.textContent = '… ' + (finalText + interim).slice(-40);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') alert('ต้องอนุญาตการใช้ไมโครโฟนก่อน');
  };
  rec.onend = () => {
    activeRec = null;
    btn.classList.remove('rec');
    btn.textContent = label;
    const t = (finalText || interim).trim();
    if (t) onText(t);
  };
  activeRec = rec;
  btn.classList.add('rec');
  btn.textContent = '● กำลังฟัง (กดเพื่อหยุด)';
  try { rec.start(); } catch { activeRec = null; btn.classList.remove('rec'); btn.textContent = label; }
}

/* ---------- UI helpers ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function actBtn(label, fn) {
  const b = el('button', '', label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const old = btn.textContent;
  btn.textContent = 'คัดลอกแล้ว';
  setTimeout(() => (btn.textContent = old), 1200);
}

function showBig(text) {
  const big = $('#big');
  big.textContent = text;
  big.hidden = false;
  big.onclick = () => (big.hidden = true);
}

function addCard(log, cls) {
  $('.empty', log)?.remove();
  const c = el('div', 'card ' + (cls || ''));
  log.appendChild(c);
  return c;
}

function scrollDown(log) { log.scrollTop = log.scrollHeight; }

function errCard(log, e) {
  const c = addCard(log, 'err');
  c.textContent = 'เกิดข้อผิดพลาด: ' + (e.message || e);
  scrollDown(log);
}

/* ---------- translate flow (chat + face) ---------- */

const hist = { chat: [], face: [] };

async function translate(log, histKey, src, dir, opts = {}) {
  const card = addCard(log, dir === 'en-th' ? 'friend' : '');
  const srcEl = el('div', 'src', src);
  const main = el('div', 'main');
  const sub = el('div', 'sub');
  const acts = el('div', 'acts');
  card.append(srcEl, main, sub, acts);
  scrollDown(log);

  const h = hist[histKey].slice(-8);
  const messages = [
    { role: 'system', content: translatePrompt(dir, state.tone) },
    ...h,
    { role: 'user', content: src },
  ];
  const render = (text) => {
    const p = parseLabeled(text);
    if (dir === 'th-en') { main.textContent = p.EN || ''; sub.textContent = p.TH ? 'ไทย: ' + p.TH : ''; }
    else { main.textContent = p.TH || ''; sub.textContent = p.NOTE ? 'หมายเหตุ: ' + p.NOTE : ''; }
    scrollDown(log);
    return p;
  };

  try {
    const full = await llm(messages, render);
    const p = render(full);
    hist[histKey].push({ role: 'user', content: src }, { role: 'assistant', content: full });
    const result = dir === 'th-en' ? p.EN : p.TH;
    if (dir === 'th-en') {
      acts.append(
        actBtn('🔊 ฟัง', () => speak(p.EN)),
        actBtn('คัดลอก', function () { copy(p.EN, this); }),
        actBtn('แสดงเต็มจอ', () => showBig(p.EN)),
      );
      if (opts.autoSpeak && state.autoSpeak) speak(p.EN);
    } else {
      acts.append(actBtn('คัดลอก', function () { copy(result, this); }));
    }
    return result;
  } catch (e) {
    card.remove();
    errCard(log, e);
  }
}

/* ---------- tabs & tone ---------- */

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function renderTones() {
  $$('.tone-seg').forEach((seg) => {
    seg.replaceChildren(...Object.entries(TONES).map(([k, label]) => {
      const b = el('button', k === state.tone ? 'on' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => { state.tone = k; store.set('tone', k); renderTones(); });
      return b;
    }));
  });
}
renderTones();

function renderBadge() { $('#modelBadge').textContent = state.model; }
renderBadge();

/* ---------- chat tab ---------- */

$$('#chatDir button').forEach((b) => b.addEventListener('click', () => {
  state.dir = b.dataset.dir;
  $$('#chatDir button').forEach((x) => x.classList.toggle('on', x === b));
  $('#chatInput').placeholder = state.dir === 'th-en' ? 'พิมพ์ภาษาไทย...' : 'วางข้อความภาษาอังกฤษของเพื่อน...';
  $('.seg.tone-seg', $('#tab-chat')).style.visibility = state.dir === 'th-en' ? 'visible' : 'hidden';
}));

function autosubmit(input, form) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
}

$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const btn = $('#chatForm .send');
  btn.disabled = true;
  await translate($('#chatLog'), 'chat', text, state.dir);
  btn.disabled = false;
});
autosubmit($('#chatInput'), $('#chatForm'));

/* ---------- face-to-face tab ---------- */

const faceLog = $('#faceLog');

async function faceSay(text) {
  await translate(faceLog, 'face', text, 'th-en', { autoSpeak: true });
}
async function faceHear(text) {
  await translate(faceLog, 'face', text, 'en-th');
}

if (!SR) {
  $('#micNote').hidden = false;
  $('.mics').hidden = true;
} else {
  $('#micTh').addEventListener('click', function () { listen('th-TH', this, faceSay); });
  $('#micEn').addEventListener('click', function () { listen('en-US', this, faceHear); });
}

$('#faceForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#faceInput');
  const t = input.value.trim();
  if (!t) return;
  input.value = '';
  faceSay(t);
});

/* ---------- ask tab ---------- */

let askHist = [];

$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#askInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  const log = $('#askLog');
  const me = addCard(log, 'ask me');
  me.append(el('div', 'body', q));
  const ans = addCard(log, 'ask');
  const body = el('div', 'body', '…');
  ans.append(body);
  scrollDown(log);
  const btn = $('#askForm .send');
  btn.disabled = true;
  try {
    const messages = [{ role: 'system', content: ASK_PROMPT }, ...askHist.slice(-10), { role: 'user', content: q }];
    const full = await llm(messages, (t) => { body.textContent = t; scrollDown(log); });
    askHist.push({ role: 'user', content: q }, { role: 'assistant', content: full });
    const acts = el('div', 'acts');
    acts.append(actBtn('คัดลอก', function () { copy(full, this); }));
    ans.append(acts);
  } catch (err) {
    ans.remove();
    errCard(log, err);
  }
  btn.disabled = false;
});
autosubmit($('#askInput'), $('#askForm'));

$('#askClear').addEventListener('click', () => {
  askHist = [];
  $('#askLog').replaceChildren(el('p', 'empty', 'เริ่มบทสนทนาใหม่แล้ว ถามได้เลย'));
});

/* ---------- settings ---------- */

$('#apiKey').value = state.key;
$('#model').value = state.model;
$('#autoSpeak').checked = state.autoSpeak;
$('#rate').value = state.rate;
$('#rateVal').textContent = state.rate;

$('#apiKey').addEventListener('input', (e) => { state.key = e.target.value.trim(); store.set('key', state.key); });
$('#model').addEventListener('input', (e) => {
  state.model = e.target.value.trim() || 'google/gemini-2.5-flash';
  store.set('model', state.model);
  renderBadge();
});
$('#autoSpeak').addEventListener('change', (e) => { state.autoSpeak = e.target.checked; store.set('autoSpeak', state.autoSpeak); });
$('#rate').addEventListener('input', (e) => {
  state.rate = Number(e.target.value);
  $('#rateVal').textContent = state.rate;
  store.set('rate', state.rate);
});

$('#testBtn').addEventListener('click', async () => {
  const out = $('#testResult');
  out.textContent = 'กำลังทดสอบ...';
  try {
    const r = await llm([{ role: 'user', content: 'Reply with the single word: OK' }]);
    out.textContent = 'เชื่อมต่อได้ โมเดลตอบ: ' + r.trim().slice(0, 40);
  } catch (e) {
    out.textContent = 'ไม่สำเร็จ: ' + e.message;
  }
});

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#installBtn').hidden = false;
});
$('#installBtn').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('#installBtn').hidden = true;
});

if (!state.key) showTab('settings');

if ('speechSynthesis' in window) speechSynthesis.getVoices(); // โหลดรายการเสียงล่วงหน้า

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
