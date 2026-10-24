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
  topic: store.get('topic', 'lang'),
};

// ประวัติและที่บันทึก เก็บในเครื่องนี้เท่านั้น
const db = {
  chat: store.get('h_chat', []),
  face: store.get('h_face', []),
  ask: store.get('h_ask', {}),
  saved: store.get('saved', []),
};
const HISTORY_MAX = 150;
function persist(k) {
  if (Array.isArray(db[k]) && k !== 'saved') db[k] = db[k].slice(-HISTORY_MAX);
  store.set(k === 'saved' ? 'saved' : 'h_' + k, db[k]);
}

const TONES = { casual: 'สบาย ๆ', friendly: 'เป็นกันเอง', polite: 'สุภาพ' };
const TONE_PROMPT = {
  casual: 'casual, relaxed, the way close friends text or talk',
  friendly: 'friendly and natural, neither slangy nor stiff',
  polite: 'polite and respectful, suitable for someone you do not know well or a professional setting',
};

/* ---------- OpenRouter ---------- */

// คืน { content, tool_calls } ; onDelta รับข้อความสะสมถึงปัจจุบัน
async function llm(messages, onDelta, { tools, signal } = {}) {
  if (!state.key) throw new Error('ยังไม่ได้ใส่ OpenRouter API key (ไปที่แท็บตั้งค่า)');
  const body = { model: state.model, messages, stream: true, temperature: 0.3 };
  if (tools?.length) body.tools = tools;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Authorization': 'Bearer ' + state.key,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin,
      'X-Title': 'HelpMePud',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const calls = [];
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
      const d = j.choices?.[0]?.delta;
      if (d?.content) { content += d.content; onDelta?.(content); }
      for (const tc of d?.tool_calls || []) {
        const c = (calls[tc.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
    }
  }
  const tool_calls = calls.filter(Boolean).map((c, n) => ({ ...c, id: c.id || 'call_' + n }));
  if (!content.trim() && !tool_calls.length) throw new Error('โมเดลไม่ตอบกลับ ลองเปลี่ยนโมเดลในตั้งค่า');
  return { content, tool_calls };
}

// วนเรียกเครื่องมือจนโมเดลตอบเป็นข้อความ
async function runAgent({ messages, tools, callTool, onText, onTool }) {
  const maxRounds = 6;
  for (let round = 0; round < maxRounds; round++) {
    const last = round === maxRounds - 1;
    const r = await llm(messages, onText, { tools: last ? undefined : tools });
    if (!r.tool_calls.length) return r.content;
    messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.tool_calls });
    for (const tc of r.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ส่ง {} */ }
      onTool?.(tc.function.name, args, 'start');
      let out;
      try { out = await callTool(tc.function.name, args); } catch (e) { out = 'ERROR: ' + e.message; }
      if (out.length > 12000) out = out.slice(0, 12000) + '\n…[ตัดข้อความที่ยาวเกิน]';
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
      onTool?.(tc.function.name, args, 'done');
    }
  }
  return '';
}

/* ---------- MCP client (Streamable HTTP) ---------- */

async function readSseFor(res, id) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (msg.id === id) return msg;
      }
    }
  } finally { reader.cancel().catch(() => {}); }
  throw new Error('MCP: ไม่ได้รับคำตอบ');
}

class McpClient {
  constructor(cfg) { this.cfg = cfg; this.reset(); }
  reset() { this.sid = null; this.proto = null; this.tools = []; this.instructions = ''; this.ready = null; this.nextId = 1; }

  async rpc(method, params, notify = false) {
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (this.sid) headers['Mcp-Session-Id'] = this.sid;
    if (this.proto) headers['MCP-Protocol-Version'] = this.proto;
    let res;
    try {
      res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      const e = new Error('เชื่อมต่อ MCP ไม่ได้ (เครือข่าย หรือเซิร์ฟเวอร์ยังไม่เปิด CORS ให้เว็บนี้เรียก)');
      e.network = true;
      throw e;
    }
    this.sid = res.headers.get('Mcp-Session-Id') || this.sid;
    if (!res.ok && res.status !== 202) {
      const e = new Error('MCP HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    if (notify) return null;
    const msg = (res.headers.get('content-type') || '').includes('text/event-stream')
      ? await readSseFor(res, body.id)
      : await res.json();
    if (msg.error) throw new Error(msg.error.message || 'MCP error');
    return msg.result;
  }

  connect() {
    this.ready ||= (async () => {
      const r = await this.rpc('initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'HelpMePud', version: '1.0' },
      });
      this.proto = r.protocolVersion;
      this.instructions = r.instructions || '';
      await this.rpc('notifications/initialized', {}, true);
      const tools = [];
      let cursor;
      do {
        const t = await this.rpc('tools/list', cursor ? { cursor } : {});
        tools.push(...(t.tools || []));
        cursor = t.nextCursor;
      } while (cursor);
      this.tools = tools.filter((t) => !/viewer/i.test(t.name)); // ตัวเปิด viewer ใช้ได้เฉพาะในแชทของ Claude
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async callTool(name, args) {
    await this.connect();
    let r;
    try {
      r = await this.rpc('tools/call', { name, arguments: args });
    } catch (e) {
      if (e.status === 404 && this.sid) { this.reset(); await this.connect(); r = await this.rpc('tools/call', { name, arguments: args }); }
      else throw e;
    }
    let text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (!text && r.structuredContent) text = JSON.stringify(r.structuredContent);
    return (r.isError ? 'ERROR: ' : '') + text;
  }

  // แปลงเป็นรูปแบบ tool ของ OpenAI/OpenRouter
  llmTools() {
    const clean = (s) => {
      if (Array.isArray(s)) return s.map(clean);
      if (s && typeof s === 'object') {
        const o = {};
        for (const [k, v] of Object.entries(s)) if (!['$schema', 'additionalProperties', 'title'].includes(k)) o[k] = clean(v);
        return o;
      }
      return s;
    };
    return this.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: (t.description || '').slice(0, 1000),
        parameters: clean(t.inputSchema || { type: 'object', properties: {} }),
      },
    }));
  }
}

const DEFAULT_MCP = [
  { id: 'tripitaka', name: 'ธรรมะ (Tripitaka)', url: 'https://mcp.tripitaka-mcp.com/mcp', enabled: true },
];
let mcpServers = store.get('mcp', DEFAULT_MCP);
const clients = new Map();
function clientFor(cfg) {
  const k = cfg.id + '|' + cfg.url;
  if (!clients.has(k)) clients.set(k, new McpClient(cfg));
  return clients.get(k);
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

function topicPrompt(name, instructions) {
  return `You are a research assistant for a Thai speaker. You can call tools from the "${name}" server.
When the question is about content those tools cover, call the tools instead of answering from memory, and base the answer on what they return.
Answer in Thai unless the user writes in another language. If the user wants to explain the idea to a foreign friend, also give a short, natural English version.
Keep answers short and practical. When tool results include links, keep them as markdown links.
${instructions ? '\nServer instructions:\n' + instructions.slice(0, 6000) : ''}`;
}

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

// คืน Promise ที่เสร็จเมื่ออ่านจบ (ใช้หยุดไมค์ไม่ให้ได้ยินเสียงตัวเอง)
function speak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = state.rate;
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang === 'en-US') || voices.find((x) => x.lang.startsWith('en'));
    if (v) u.voice = v;
    const t = setTimeout(resolve, 30000);
    u.onend = u.onerror = () => { clearTimeout(t); resolve(); };
    speechSynthesis.speak(u);
  });
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeRec = null;

function listen(lang, btn, onText) {
  if (cont.on) return;
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
  b.addEventListener('click', function () { fn.call(this); });
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

function emptyNote(log, text) { log.replaceChildren(el('p', 'empty', text)); }
function scrollDown(log) { log.scrollTop = log.scrollHeight; }

function errCard(log, e) {
  const c = addCard(log, 'err');
  c.textContent = 'เกิดข้อผิดพลาด: ' + (e.message || e);
  scrollDown(log);
}

// markdown แบบย่อ: escape ทุกอย่างก่อน แล้วเปิดเฉพาะลิงก์ http(s) กับตัวหนา
function md(text) {
  const h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return h
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

/* ---------- saved phrases ---------- */

const isSaved = (en) => db.saved.some((s) => s.en === en);

function toggleSaved(th, en) {
  const i = db.saved.findIndex((s) => s.en === en);
  if (i >= 0) db.saved.splice(i, 1);
  else db.saved.unshift({ id: Date.now(), th, en });
  persist('saved');
  renderSaved();
}

function renderSaved() {
  const q = $('#savedSearch').value.trim().toLowerCase();
  const list = db.saved.filter((s) => !q || (s.th + ' ' + s.en).toLowerCase().includes(q));
  const log = $('#savedLog');
  if (!list.length) {
    emptyNote(log, db.saved.length ? 'ไม่พบประโยคที่ค้นหา' : 'ยังไม่มีประโยคที่บันทึก กดดาวที่คำแปลในแท็บแชทหรือเจอหน้าเพื่อเก็บไว้ใช้ซ้ำ');
    return;
  }
  log.replaceChildren(...list.map((s) => {
    const c = el('div', 'card');
    const acts = el('div', 'acts');
    acts.append(
      actBtn('🔊 ฟัง', () => speak(s.en)),
      actBtn('คัดลอก', function () { copy(s.en, this); }),
      actBtn('แสดงเต็มจอ', () => showBig(s.en)),
      actBtn('ลบ', () => toggleSaved(s.th, s.en)),
    );
    c.append(el('div', 'main', s.en), el('div', 'sub', s.th), acts);
    return c;
  }));
}
$('#savedSearch').addEventListener('input', renderSaved);

/* ---------- translate flow (chat + face) ---------- */

function buildTransCard(log, entry) {
  const card = addCard(log, entry.dir === 'en-th' ? 'friend' : '');
  const main = el('div', 'main');
  const sub = el('div', 'sub');
  const acts = el('div', 'acts');
  card.append(el('div', 'src', entry.src), main, sub, acts);
  const view = () => {
    const p = parseLabeled(entry.raw || '');
    if (entry.dir === 'th-en') { main.textContent = p.EN || ''; sub.textContent = p.TH ? 'ไทย: ' + p.TH : ''; }
    else { main.textContent = p.TH || ''; sub.textContent = p.NOTE ? 'หมายเหตุ: ' + p.NOTE : ''; }
    return p;
  };
  const finish = () => {
    const p = view();
    acts.replaceChildren();
    if (entry.dir === 'th-en') {
      const star = actBtn(isSaved(p.EN) ? '★ เก็บแล้ว' : '☆ เก็บ', () => {
        toggleSaved(entry.src, p.EN);
        star.textContent = isSaved(p.EN) ? '★ เก็บแล้ว' : '☆ เก็บ';
      });
      acts.append(
        actBtn('🔊 ฟัง', () => speak(p.EN)),
        actBtn('คัดลอก', function () { copy(p.EN, this); }),
        actBtn('แสดงเต็มจอ', () => showBig(p.EN)),
        star,
      );
    } else {
      acts.append(actBtn('คัดลอก', function () { copy(p.TH, this); }));
    }
    return p;
  };
  return { card, view, finish };
}

function renderHistory(log, key, emptyText) {
  log.replaceChildren();
  if (!db[key].length) { emptyNote(log, emptyText); return; }
  for (const e of db[key]) buildTransCard(log, e).finish();
  scrollDown(log);
}

function contextFor(key) {
  return db[key].slice(-4).flatMap((e) => [
    { role: 'user', content: e.src },
    { role: 'assistant', content: e.raw },
  ]);
}

async function translate(log, key, src, dir, opts = {}) {
  const entry = { id: Date.now(), src, dir, raw: '' };
  const ui = buildTransCard(log, entry);
  scrollDown(log);
  const messages = [
    { role: 'system', content: translatePrompt(dir, state.tone) },
    ...contextFor(key).filter((m) => m.content),
    { role: 'user', content: src },
  ];
  try {
    const r = await llm(messages, (t) => { entry.raw = t; ui.view(); scrollDown(log); });
    entry.raw = r.content;
    const p = ui.finish();
    db[key].push(entry);
    persist(key);
    scrollDown(log);
    if (dir === 'th-en' && opts.autoSpeak && state.autoSpeak) {
      const done = speak(p.EN);
      if (opts.awaitSpeech) await done;
    }
  } catch (e) {
    ui.card.remove();
    errCard(log, e);
  }
}

/* ---------- tabs & tone ---------- */

function showTab(name) {
  if (name !== 'face') contStop();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'saved') renderSaved();
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

function autosubmit(input, form) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
}

function confirmClear(what, fn) { if (confirm('ล้าง' + what + 'ทั้งหมด?')) fn(); }

/* ---------- chat tab ---------- */

const CHAT_EMPTY = 'พิมพ์ไทยเพื่อแปลเป็นอังกฤษไปตอบเพื่อน หรือสลับเป็น "อังกฤษ → ไทย" แล้ววางข้อความของเพื่อนเพื่อให้แปลให้อ่าน';
const FACE_EMPTY = 'กดไมค์ พูดไทย แอปจะแปลเป็นอังกฤษและอ่านออกเสียงให้ หรือกด "ฟังต่อเนื่อง" เพื่อคุยโดยไม่ต้องกดทุกประโยค';
renderHistory($('#chatLog'), 'chat', CHAT_EMPTY);

$$('#chatDir button').forEach((b) => b.addEventListener('click', () => {
  state.dir = b.dataset.dir;
  $$('#chatDir button').forEach((x) => x.classList.toggle('on', x === b));
  $('#chatInput').placeholder = state.dir === 'th-en' ? 'พิมพ์ภาษาไทย...' : 'วางข้อความภาษาอังกฤษของเพื่อน...';
  $('.seg.tone-seg', $('#tab-chat')).style.visibility = state.dir === 'th-en' ? 'visible' : 'hidden';
}));

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
$('#chatClear').addEventListener('click', () => confirmClear('ประวัติแชท', () => {
  db.chat = []; persist('chat'); renderHistory($('#chatLog'), 'chat', CHAT_EMPTY);
}));

/* ---------- face-to-face tab ---------- */

const faceLog = $('#faceLog');
renderHistory(faceLog, 'face', FACE_EMPTY);

const faceSay = (text) => translate(faceLog, 'face', text, 'th-en', { autoSpeak: true });
const faceHear = (text) => translate(faceLog, 'face', text, 'en-th');

// โหมดฟังต่อเนื่อง: ฟังทีละประโยค แปล (และอ่านออกเสียง) แล้วกลับมาฟังเอง
const cont = { on: false, lang: 'th-TH', rec: null, wake: null };

function setContStatus(t) { $('#contStatus').textContent = t; }

function renderCont() {
  $('#contBtn').textContent = cont.on ? '■ หยุดฟัง' : '▶ ฟังต่อเนื่อง';
  $('#contBtn').classList.toggle('rec', cont.on);
  $$('#contLang button').forEach((b) => b.classList.toggle('on', b.dataset.lang === cont.lang));
  $('#micTh').disabled = $('#micEn').disabled = cont.on;
  if (!cont.on) setContStatus('');
}

// ตรวจภาษาจากตัวอักษรของข้อความที่ได้ยิน เพื่อเลือกทิศทางแปล
function dirOf(text) {
  const th = (text.match(/[฀-๿]/g) || []).length;
  const en = (text.match(/[A-Za-z]/g) || []).length;
  return th >= en ? 'th-en' : 'en-th';
}

async function contStart() {
  if (!SR || cont.on) return;
  if (activeRec) activeRec.abort();
  cont.on = true;
  try { cont.wake = await navigator.wakeLock?.request('screen'); } catch { /* ไม่รองรับ */ }
  renderCont();
  contLoop();
}

function contStop() {
  if (!cont.on) return;
  cont.on = false;
  try { cont.rec?.abort(); } catch { /* already stopped */ }
  cont.wake?.release?.().catch(() => {});
  cont.wake = null;
  renderCont();
}

function contLoop() {
  if (!cont.on) return;
  const rec = new SR();
  rec.lang = cont.lang;
  rec.interimResults = true;
  rec.continuous = false;
  let fin = '';
  let interim = '';
  let errored = false;
  rec.onresult = (e) => {
    fin = ''; interim = '';
    for (const r of e.results) (r.isFinal ? (fin += r[0].transcript) : (interim += r[0].transcript));
    setContStatus('🎙 ' + (fin + interim));
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      alert('ต้องอนุญาตการใช้ไมโครโฟนก่อน');
      contStop();
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') errored = true;
  };
  rec.onend = async () => {
    if (!cont.on) return;
    const text = (fin || interim).trim();
    if (text) {
      setContStatus('กำลังแปล...');
      await translate(faceLog, 'face', text, dirOf(text), { autoSpeak: true, awaitSpeech: true });
    }
    setTimeout(contLoop, errored ? 2000 : 150);
  };
  cont.rec = rec;
  setContStatus(cont.lang === 'th-TH' ? '🎙 กำลังฟังภาษาไทย' : '🎧 กำลังฟังภาษาอังกฤษ');
  try { rec.start(); } catch { setTimeout(contLoop, 800); }
}

if (!SR) {
  $('#micNote').hidden = false;
  $('.mics').hidden = true;
  $('#contBox').hidden = true;
} else {
  $('#micTh').addEventListener('click', function () { listen('th-TH', this, faceSay); });
  $('#micEn').addEventListener('click', function () { listen('en-US', this, faceHear); });
  $('#contBtn').addEventListener('click', () => (cont.on ? contStop() : contStart()));
  $$('#contLang button').forEach((b) => b.addEventListener('click', () => {
    cont.lang = b.dataset.lang;
    renderCont();
    if (cont.on) { try { cont.rec?.abort(); } catch { /* restart ใน onend */ } }
  }));
}

$('#faceForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#faceInput');
  const t = input.value.trim();
  if (!t) return;
  input.value = '';
  faceSay(t);
});
$('#faceClear').addEventListener('click', () => confirmClear('ประวัติเจอหน้า', () => {
  db.face = []; persist('face'); renderHistory(faceLog, 'face', FACE_EMPTY);
}));

/* ---------- ask tab (ภาษา + หัวข้อ MCP) ---------- */

const askLog = $('#askLog');
const topicList = () => [
  { id: 'lang', label: '💬 ภาษา' },
  ...mcpServers.filter((s) => s.enabled).map((s) => ({ id: s.id, label: '📚 ' + s.name })),
];
const currentServer = () => mcpServers.find((s) => s.id === state.topic && s.enabled);

function askEmptyText() {
  return state.topic === 'lang'
    ? 'ถามได้เลย เช่น "ถ้าอยากปฏิเสธคำชวนแบบสุภาพ พูดว่าอะไรดี" หรือ "คำว่า เกรงใจ ภาษาอังกฤษใช้คำไหน"'
    : `ถามเรื่อง "${currentServer()?.name}" ได้เลย โมเดลจะเรียกเครื่องมือของหัวข้อนี้ไปค้นให้ เช่น "สติปัฏฐาน 4 คืออะไร มีในพระสูตรไหน"`;
}

function renderTopics() {
  if (!topicList().some((t) => t.id === state.topic)) state.topic = 'lang';
  $('#topics').replaceChildren(...topicList().map((t) => {
    const b = el('button', 'chip' + (t.id === state.topic ? ' on' : ''), t.label);
    b.type = 'button';
    b.addEventListener('click', () => { state.topic = t.id; store.set('topic', t.id); renderTopics(); renderAsk(); });
    return b;
  }));
  $('#askInput').placeholder = state.topic === 'lang' ? 'ถามเรื่องคำหรือสำนวน...' : 'ถามเรื่อง' + (currentServer()?.name || '') + '...';
  prepareTopic();
}

async function prepareTopic() {
  const srv = currentServer();
  const s = $('#topicStatus');
  s.textContent = '';
  if (!srv) return;
  s.textContent = 'กำลังเชื่อมต่อ ' + srv.name + '...';
  try {
    await clientFor(srv).connect();
    if (currentServer() === srv) s.textContent = 'เชื่อมต่อแล้ว มี ' + clientFor(srv).tools.length + ' เครื่องมือ';
  } catch (e) {
    if (currentServer() === srv) s.textContent = e.message;
  }
}

function renderAsk() {
  askLog.replaceChildren();
  const list = db.ask[state.topic] || [];
  if (!list.length) { emptyNote(askLog, askEmptyText()); return; }
  for (const e of list) {
    const me = addCard(askLog, 'ask me');
    me.append(el('div', 'body', e.q));
    const ans = addCard(askLog, 'ask');
    if (e.tools?.length) ans.append(toolChips(e.tools));
    const body = el('div', 'body');
    body.innerHTML = md(e.a);
    ans.append(body, copyRow(e.a));
  }
  scrollDown(askLog);
}

function toolChips(names) {
  const box = el('div', 'tools');
  for (const n of names) box.append(el('span', 'tool', '🔧 ' + n));
  return box;
}

function copyRow(text) {
  const acts = el('div', 'acts');
  acts.append(actBtn('คัดลอก', function () { copy(text, this); }));
  return acts;
}

$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#askInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  const topic = state.topic;
  const srv = currentServer();
  const list = (db.ask[topic] ||= []);

  const me = addCard(askLog, 'ask me');
  me.append(el('div', 'body', q));
  const ans = addCard(askLog, 'ask');
  const chips = el('div', 'tools');
  const body = el('div', 'body', '...');
  ans.append(chips, body);
  scrollDown(askLog);

  const btn = $('#askForm .send');
  btn.disabled = true;
  const used = [];
  try {
    const history = list.slice(-6).flatMap((x) => [{ role: 'user', content: x.q }, { role: 'assistant', content: x.a }]);
    let answer;
    if (!srv) {
      const r = await llm([{ role: 'system', content: ASK_PROMPT }, ...history, { role: 'user', content: q }],
        (t) => { body.innerHTML = md(t); scrollDown(askLog); });
      answer = r.content;
    } else {
      const client = clientFor(srv);
      await client.connect();
      const messages = [
        { role: 'system', content: topicPrompt(srv.name, client.instructions) },
        ...history,
        { role: 'user', content: q },
      ];
      let chip;
      answer = await runAgent({
        messages,
        tools: client.llmTools(),
        callTool: (name, args) => client.callTool(name, args),
        onText: (t) => { body.innerHTML = md(t); scrollDown(askLog); },
        onTool: (name, args, phase) => {
          if (phase === 'start') {
            used.push(name);
            chip = el('span', 'tool', '🔧 ' + name + ' ...');
            chips.append(chip);
            body.textContent = '...';
          } else if (chip) chip.textContent = '🔧 ' + name;
          scrollDown(askLog);
        },
      });
      if (!answer.trim()) throw new Error('โมเดลไม่สรุปคำตอบ ลองถามใหม่ให้เฉพาะเจาะจงขึ้น');
    }
    body.innerHTML = md(answer);
    ans.append(copyRow(answer));
    list.push({ q, a: answer, tools: used, ts: Date.now() });
    db.ask[topic] = list.slice(-HISTORY_MAX);
    persist('ask');
  } catch (err) {
    me.remove();
    ans.remove();
    errCard(askLog, err);
  }
  btn.disabled = false;
});
autosubmit($('#askInput'), $('#askForm'));

$('#askClear').addEventListener('click', () => confirmClear('บทสนทนาของหัวข้อนี้', () => {
  db.ask[state.topic] = [];
  persist('ask');
  renderAsk();
}));

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
    out.textContent = 'เชื่อมต่อได้ โมเดลตอบ: ' + r.content.trim().slice(0, 40);
  } catch (e) {
    out.textContent = 'ไม่สำเร็จ: ' + e.message;
  }
});

function saveMcp() { store.set('mcp', mcpServers); renderMcp(); renderTopics(); renderAsk(); }

function renderMcp() {
  const box = $('#mcpList');
  if (!mcpServers.length) { box.replaceChildren(el('p', 'note', 'ยังไม่มี MCP server')); return; }
  box.replaceChildren(...mcpServers.map((s) => {
    const row = el('div', 'mcprow');
    const head = el('label', 'row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.addEventListener('change', () => { s.enabled = cb.checked; saveMcp(); });
    head.append(cb, document.createTextNode(' ' + s.name));
    const url = el('div', 'note', s.url);
    const status = el('div', 'note');
    const acts = el('div', 'acts');
    acts.append(
      actBtn('ทดสอบ', async () => {
        status.textContent = 'กำลังเชื่อมต่อ...';
        const c = clientFor(s);
        c.reset();
        try { await c.connect(); status.textContent = 'ใช้ได้ มี ' + c.tools.length + ' เครื่องมือ: ' + c.tools.map((t) => t.name).join(', '); }
        catch (e) { status.textContent = e.message; }
      }),
      actBtn('ลบ', () => { if (confirm('ลบ ' + s.name + '?')) { mcpServers = mcpServers.filter((x) => x !== s); saveMcp(); } }),
    );
    row.append(head, url, status, acts);
    return row;
  }));
}

$('#mcpForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#mcpName').value.trim();
  const url = $('#mcpUrl').value.trim();
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) { alert('URL ต้องขึ้นต้นด้วย https://'); return; }
  mcpServers.push({ id: 'mcp' + Date.now(), name, url, enabled: true });
  $('#mcpName').value = $('#mcpUrl').value = '';
  saveMcp();
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

renderMcp();
renderTopics();
renderAsk();
renderSaved();
renderCont();

if (!state.key) showTab('settings');

if ('speechSynthesis' in window) speechSynthesis.getVoices(); // โหลดรายการเสียงล่วงหน้า

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
