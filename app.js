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
  tone: store.get('tone', 'friendly'),
  autoSpeak: store.get('autoSpeak', true),
  rate: store.get('rate', 0.95),
  pitch: store.get('pitch', 1),
  autoSend: store.get('autoSend', false),
  voice: store.get('voice', ''), // voiceURI ของเสียงที่เลือก ว่าง = เลือกให้อัตโนมัติ
  dir: 'th-en',
  topic: store.get('topic', 'lang'),
};

// โมเดลแยกตามงาน: translate = แท็บแชท/เจอหน้า, ask = ถามคำ (ภาษา), topic = หัวข้อ MCP
const ROLES = { translate: 'แปล', ask: 'ถามคำ', topic: 'หัวข้อ MCP', web: 'ค้นเว็บ' };
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
{
  const legacy = store.get('model', DEFAULT_MODEL);
  const saved = store.get('models', {});
  state.models = { translate: legacy, ask: legacy, topic: legacy, web: legacy, ...saved };
  state.noteLang = store.get('noteLang', 'th-TH');
  state.noteAuto = store.get('noteAuto', false);
  state.favs = store.get('favs', []);
  state.tts = { engine: 'device', model: '', voice: '', instructions: '', ...store.get('tts', {}) };
}

// ประวัติและที่บันทึก เก็บในเครื่องนี้เท่านั้น
const db = {
  chat: store.get('h_chat', []),
  face: store.get('h_face', []),
  ask: store.get('h_ask', {}),
  web: store.get('h_web', []),
  saved: store.get('saved', []),
  notes: store.get('notes', []),
};
const HISTORY_MAX = 150;
const KEEP_ALL = ['saved', 'notes']; // ประวัติสนทนาตัดเหลือล่าสุด ส่วนโน้ตกับประโยคที่บันทึกเก็บทั้งหมด
function persist(k) {
  if (Array.isArray(db[k]) && !KEEP_ALL.includes(k)) db[k] = db[k].slice(-HISTORY_MAX);
  store.set(KEEP_ALL.includes(k) ? k : 'h_' + k, db[k]);
}

const TONES = { casual: 'สบาย ๆ', friendly: 'เป็นกันเอง', polite: 'สุภาพ' };
const TONE_PROMPT = {
  casual: 'casual, relaxed, the way close friends text or talk',
  friendly: 'friendly and natural, neither slangy nor stiff',
  polite: 'polite and respectful, suitable for someone you do not know well or a professional setting',
};

/* ---------- OpenRouter ---------- */

// คืน { content, tool_calls, annotations } ; onDelta รับข้อความสะสมถึงปัจจุบัน
// stream: false ใช้กับการค้นเว็บ เพราะรูปแบบ citation แบบไม่สตรีมมีเอกสารยืนยัน
async function llm(messages, onDelta, { tools, signal, role = 'translate', stream = true, plugins } = {}) {
  if (!state.key) throw new Error('ยังไม่ได้ใส่ OpenRouter API key (ไปที่แท็บตั้งค่า)');
  const body = { model: state.models[role], messages, stream, temperature: 0.3 };
  if (tools?.length) body.tools = tools;
  if (plugins) body.plugins = plugins;
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
  if (!stream) {
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'model error');
    const msg = j.choices?.[0]?.message || {};
    const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map((p) => p.text || '').join('');
    if (!text.trim()) throw new Error('โมเดลไม่ตอบกลับ ลองเปลี่ยนโมเดลในตั้งค่า');
    return { content: text, tool_calls: msg.tool_calls || [], annotations: msg.annotations || [] };
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
    const r = await llm(messages, onText, { tools: last ? undefined : tools, role: 'topic' });
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
const enVoices = () => speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));

function pickVoice() {
  const list = enVoices();
  return list.find((v) => v.voiceURI === state.voice) ||
    list.find((v) => v.lang === 'en-US') || list[0];
}

// เสียง AI ผ่าน OpenRouter (POST /audio/speech) ใช้ element เดียวกันตลอด
// เพื่อให้ iOS ยอมเล่นเสียงที่เริ่มหลัง await (ปลดล็อกด้วยการแตะครั้งแรก)
const player = new Audio();
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let playResolve = null;
let speakSeq = 0;
const ttsCache = new Map(); // key -> object URL ของเสียงที่เคยสร้างแล้ว เล่นซ้ำไม่เสียเงิน

document.addEventListener('pointerdown', () => {
  player.src = SILENT_WAV;
  player.play().then(() => { if (player.src === SILENT_WAV) player.pause(); }).catch(() => {});
}, { once: true });

function stopSpeech() {
  speakSeq++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  player.pause();
  playResolve?.();
  playResolve = null;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

async function speakAI(text, seq) {
  const t = state.tts;
  const key = [t.model, t.voice, t.instructions, text].join('\u0001');
  let url = ttsCache.get(key);
  if (!url) {
    const body = { model: t.model, input: text, response_format: 'mp3' };
    if (t.voice) body.voice = t.voice;
    if (t.instructions.trim()) body.instructions = t.instructions.trim();
    const res = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
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
    const blob = await res.blob();
    url = URL.createObjectURL(blob);
    ttsCache.set(key, url);
    if (ttsCache.size > 30) {
      const oldest = ttsCache.keys().next().value;
      URL.revokeObjectURL(ttsCache.get(oldest));
      ttsCache.delete(oldest);
    }
  }
  if (seq !== speakSeq) return; // มีคำสั่งอ่านใหม่แทรกระหว่างรอเสียง
  await new Promise((resolve, reject) => {
    playResolve = resolve;
    player.onended = resolve;
    player.onerror = () => reject(new Error('เล่นเสียงไม่ได้'));
    player.src = url;
    player.playbackRate = 1;
    player.play().catch(reject);
  });
}

// คืน Promise ที่เสร็จเมื่ออ่านจบ (ใช้หยุดไมค์ไม่ให้ได้ยินเสียงตัวเอง)
function speak(text) {
  stopSpeech();
  if (!text) return Promise.resolve();
  const seq = speakSeq;
  if (state.tts.engine === 'openrouter' && state.key && state.tts.model) {
    return speakAI(text, seq).catch((e) => {
      toast('เสียง AI ใช้ไม่ได้ (' + e.message + ') ใช้เสียงของเครื่องแทน');
      return seq === speakSeq ? speakDevice(text) : undefined;
    });
  }
  return speakDevice(text);
}

function speakDevice(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = state.rate;
    u.pitch = state.pitch;
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
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

// พูดแทนการพิมพ์: ข้อความที่ได้ยินลงในช่องพิมพ์ ต่อท้ายข้อความเดิม ให้แก้ก่อนส่งได้
function makeDictation({ input, btn, lang, onDone }) {
  let rec = null;
  const reset = () => { rec = null; btn.classList.remove('rec'); btn.textContent = '🎤'; };
  const stop = () => { try { rec?.stop(); } catch { /* stopped */ } };
  const toggle = () => {
    if (rec) { stop(); return; }
    if (activeRec) activeRec.abort();
    const base = input.value.trim();
    const r = new SR();
    r.lang = lang();
    r.interimResults = true;
    r.continuous = false;
    let heard = '';
    r.onresult = (e) => {
      heard = '';
      for (const x of e.results) heard += x[0].transcript;
      input.value = (base ? base + ' ' : '') + heard.trim();
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') alert('ต้องอนุญาตการใช้ไมโครโฟนก่อน');
    };
    r.onend = () => {
      reset();
      input.focus({ preventScroll: true });
      if (heard.trim()) onDone?.();
    };
    rec = r;
    btn.classList.add('rec');
    btn.textContent = '■';
    try { r.start(); } catch { reset(); }
  };
  return { toggle, stop };
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

// markdown ที่โมเดลมักใช้: หัวข้อ รายการ (ซ้อนได้) ตาราง โค้ด คำพูดอ้างอิง ตัวหนา/เอียง ลิงก์
// escape ข้อความทุกส่วนก่อนสร้าง HTML และเปิดลิงก์เฉพาะ http(s)
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mdInline(raw) {
  const codes = [];
  let s = escHtml(raw).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g, (m, label, url, bare) => {
    if (bare) {
      const tail = bare.match(/[.,;:!?)]+$/)?.[0] || '';
      const u = bare.slice(0, bare.length - tail.length);
      return `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>${tail}`;
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^A-Za-z0-9_])__([^_\n]+?)__(?![A-Za-z0-9_])/g, '$1<strong>$2</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function mdList(lines) {
  let html = '';
  const stack = []; // { indent, tag }
  const close = () => { html += `</li></${stack.pop().tag}>`; };
  for (const l of lines) {
    const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    const indent = m[1].replace(/\t/g, '    ').length;
    const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
    while (stack.length && indent < stack[stack.length - 1].indent) close();
    const top = stack[stack.length - 1];
    if (top && indent === top.indent) html += '</li>';
    else if (!top || indent > top.indent) { html += `<${tag}>`; stack.push({ indent, tag }); }
    html += `<li>${mdInline(m[3])}`;
  }
  while (stack.length) close();
  return html;
}

function mdTable(lines) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return '<div class="tbl"><table><thead><tr>' + head.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
}

function md(text) {
  const blocks = [];
  // โค้ดบล็อกแยกออกก่อน เพื่อไม่ให้ตีความ markdown ข้างใน (รวมบล็อกที่ยังไม่ปิดตอนสตรีม)
  const src = text.replace(/\r\n/g, '\n').replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_, code) => {
    blocks.push(`<pre><code>${escHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return '\n\u0001' + (blocks.length - 1) + '\u0001\n';
  });
  const lines = src.split('\n');
  const out = [];
  const isItem = (l) => /^\s*([-*+]|\d+[.)])\s+\S/.test(l);
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if ((m = l.match(/^\u0001(\d+)\u0001$/))) { out.push(blocks[m[1]]); i++; continue; }
    if ((m = l.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      const n = Math.min(m[1].length + 2, 6); // # ใหญ่สุดที่ h3 ให้พอดีกับการ์ด
      out.push(`<h${n}>${mdInline(m[2].replace(/\s#+\s*$/, ''))}</h${n}>`); i++; continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${q.map(mdInline).join('<br>')}</blockquote>`); continue;
    }
    if (isRow(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const t = [];
      while (i < lines.length && isRow(lines[i])) t.push(lines[i++]);
      out.push(mdTable(t)); continue;
    }
    if (isItem(l)) {
      const li = [];
      while (i < lines.length && lines[i].trim() && (isItem(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (isItem(lines[i])) li.push(lines[i]);
        else li[li.length - 1] += ' ' + lines[i].trim(); // บรรทัดต่อของข้อความในรายการ
        i++;
      }
      out.push(mdList(li)); continue;
    }
    const p = [];
    while (i < lines.length && lines[i].trim() && !/^\u0001\d+\u0001$/.test(lines[i]) && !isItem(lines[i]) &&
           !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !/^\s*>/.test(lines[i])) p.push(lines[i++]);
    if (!p.length) { p.push(lines[i++]); }
    out.push(`<p>${p.map(mdInline).join('<br>')}</p>`);
  }
  return out.join('');
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
  currentTab = name;
  renderBadge();
  if (name !== 'face') contStop();
  if (name !== 'chat') chatDictateStop();
  if (name !== 'ask') askDictation.stop();
  if (name !== 'web') webDictation.stop();
  if (name !== 'notes') noteDictation.stop();
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'notes') { renderNotes(); renderSaved(); }
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

/* ---------- รายการโมเดล + หน้าต่างสลับโมเดล ---------- */

let currentTab = 'chat';
const activeRole = () => (currentTab === 'ask' ? (state.topic === 'lang' ? 'ask' : 'topic')
  : currentTab === 'web' ? 'web' : 'translate');
const shortName = (id) => id.split('/').slice(1).join('/') || id;

function renderBadge() {
  const role = activeRole();
  $('#modelBadge').textContent = ROLES[role] + ' · ' + shortName(state.models[role]) + ' ▾';
}

const catalog = { text: null, tts: null };
// โมเดลเสียงที่ส่งกลับเฉพาะ PCM แอปยังเล่นไม่ได้ จึงซ่อนไว้
const PCM_ONLY = /^(google|heygen)\//;

async function loadCatalog(kind, force = false) {
  const key = 'cat_' + kind;
  const cached = store.get(key, null);
  if (!force && cached && Date.now() - cached.t < 12 * 3600e3) return (catalog[kind] = cached.data);
  const url = 'https://openrouter.ai/api/v1/models' + (kind === 'tts' ? '?output_modalities=speech' : '');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const price = (v) => (Number(v) >= 0 ? Number(v) : null); // -1 = ราคาไม่คงที่
    const data = (await r.json()).data
      .filter((m) => kind === 'tts'
        ? !PCM_ONLY.test(m.id)
        : (m.architecture?.output_modalities || []).includes('text') && (m.architecture?.input_modalities || []).includes('text'))
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        ctx: m.context_length || 0,
        pin: price(m.pricing?.prompt),
        pout: price(m.pricing?.completion),
        tools: (m.supported_parameters || []).includes('tools'),
        voices: m.supported_voices || null,
      }));
    store.set(key, { t: Date.now(), data });
    return (catalog[kind] = data);
  } catch (e) {
    if (cached) return (catalog[kind] = cached.data);
    throw e;
  }
}

const money = (perToken) => {
  const v = perToken * 1e6;
  return '$' + (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));
};

function priceText(m, kind) {
  if (m.pin === null || m.pout === null) return 'ราคาไม่คงที่';
  if (kind === 'tts') {
    if (m.pin > 0) return money(m.pin) + ' ต่อ 1M ตัวอักษร';
    if (m.pout > 0) return '$' + m.pout + ' ต่อวินาที';
    return 'ฟรี';
  }
  return m.pin === 0 && m.pout === 0 ? 'ฟรี' : money(m.pin) + ' เข้า / ' + money(m.pout) + ' ออก ต่อ 1M โทเคน';
}

const sheet = { kind: 'text', filter: 'all', current: '', onPick: null };

function openSheet({ kind, title, current, filter = 'all', onPick }) {
  Object.assign(sheet, { kind, filter, current, onPick });
  $('#sheetTitle').textContent = title;
  $('#sheetSearch').value = '';
  $('#sheet').hidden = false;
  renderSheet();
  if (!catalog[kind]) {
    $('#sheetList').replaceChildren(el('p', 'note', 'กำลังโหลดรายชื่อโมเดล...'));
    loadCatalog(kind).then(renderSheet).catch((e) => {
      $('#sheetList').replaceChildren(el('p', 'note', 'โหลดรายชื่อไม่ได้ (' + e.message + ') พิมพ์ id ของโมเดลในช่องค้นหาแล้วเลือกได้เลย'));
      renderSheet(true);
    });
  }
}

function closeSheet() { $('#sheet').hidden = true; }

function renderSheet(keepList) {
  const { kind } = sheet;
  const chips = kind === 'text'
    ? [['all', 'ทั้งหมด'], ['fav', '★ ที่ชอบ'], ['tools', '🔧 รองรับเครื่องมือ'], ['free', 'ฟรี']]
    : [['all', 'ทั้งหมด'], ['fav', '★ ที่ชอบ'], ['free', 'ฟรี']];
  $('#sheetChips').replaceChildren(...chips.map(([k, label]) => {
    const b = el('button', 'chip' + (sheet.filter === k ? ' on' : ''), label);
    b.type = 'button';
    b.addEventListener('click', () => { sheet.filter = k; renderSheet(); });
    return b;
  }));
  if (keepList === true) { appendTypedRow(); return; }
  const q = $('#sheetSearch').value.trim().toLowerCase();
  let list = (catalog[kind] || []).filter((m) => {
    if (q && !(m.id + ' ' + m.name).toLowerCase().includes(q)) return false;
    if (sheet.filter === 'fav') return state.favs.includes(m.id);
    if (sheet.filter === 'tools') return m.tools;
    if (sheet.filter === 'free') return m.pin === 0 && m.pout === 0;
    return true;
  });
  list.sort((a, b) => (state.favs.includes(b.id) - state.favs.includes(a.id)) || a.name.localeCompare(b.name));
  const total = list.length;
  list = list.slice(0, 80);
  const rows = list.map((m) => {
    const row = el('div', 'modelrow' + (m.id === sheet.current ? ' cur' : ''));
    const info = el('button', 'info');
    info.type = 'button';
    info.append(
      el('div', 'mname', m.name),
      el('div', 'mid', m.id + (m.tools && kind === 'text' ? '  🔧' : '')),
      el('div', 'mprice', priceText(m, kind) + (kind === 'text' && m.ctx ? ' · ' + Math.round(m.ctx / 1000) + 'K ctx' : '')),
    );
    info.addEventListener('click', () => pickModelId(m.id));
    const star = el('button', 'star', state.favs.includes(m.id) ? '★' : '☆');
    star.type = 'button';
    star.setAttribute('aria-label', 'ที่ชอบ');
    star.addEventListener('click', () => {
      const i = state.favs.indexOf(m.id);
      if (i >= 0) state.favs.splice(i, 1); else state.favs.push(m.id);
      store.set('favs', state.favs);
      renderSheet();
    });
    row.append(info, star);
    return row;
  });
  $('#sheetList').replaceChildren(...rows);
  if (!rows.length) $('#sheetList').append(el('p', 'note', catalog[kind] ? 'ไม่พบโมเดลที่ตรงกับตัวกรอง' : ''));
  if (total > list.length) $('#sheetList').append(el('p', 'note', `แสดง ${list.length} จาก ${total} รายการ พิมพ์ค้นหาเพื่อกรองเพิ่ม`));
  appendTypedRow();
}

// พิมพ์ id เองได้ (กรณีโมเดลใหม่ที่ยังไม่อยู่ในรายการ)
function appendTypedRow() {
  const q = $('#sheetSearch').value.trim();
  if (!/^[\w.-]+\/[\w.:-]+$/.test(q) || (catalog[sheet.kind] || []).some((m) => m.id === q)) return;
  const b = el('button', 'typed', 'ใช้ id ที่พิมพ์: ' + q);
  b.type = 'button';
  b.addEventListener('click', () => pickModelId(q));
  $('#sheetList').append(b);
}

function pickModelId(id) { closeSheet(); sheet.onPick?.(id); }

$('#sheetSearch').addEventListener('input', () => renderSheet());
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

function pickTextModel(role) {
  openSheet({
    kind: 'text',
    title: 'เลือกโมเดล: ' + ROLES[role],
    current: state.models[role],
    filter: role === 'topic' ? 'tools' : 'all',
    onPick: (id) => {
      state.models[role] = id;
      store.set('models', state.models);
      renderBadge();
      renderModelRows?.();
    },
  });
}
$('#modelBadge').addEventListener('click', () => pickTextModel(activeRole()));
renderBadge();
loadCatalog('text').catch(() => {}); // โหลดล่วงหน้า ให้หน้าต่างเลือกโมเดลเปิดเร็ว

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
  $('#chatInput').placeholder = state.dir === 'th-en'
    ? 'พิมพ์หรือกดไมค์เพื่อพูดไทย...'
    : 'วางข้อความของเพื่อน หรือกดไมค์ให้เพื่อนพูด (อังกฤษ)...';
  chatDictateStop();
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

// พูดแทนการพิมพ์: ข้อความที่ได้ยินลงในช่องพิมพ์ ให้แก้ก่อนส่งได้ (หรือเปิดส่งอัตโนมัติ)
const chatDictation = makeDictation({
  input: $('#chatInput'),
  btn: $('#chatMic'),
  lang: () => (state.dir === 'th-en' ? 'th-TH' : 'en-US'),
  onDone: () => { if (state.autoSend) $('#chatForm').requestSubmit(); },
});
function chatDictateStop() { chatDictation.stop(); }

if (SR) {
  $('#chatMic').addEventListener('click', chatDictation.toggle);
  $('#autoSend').checked = state.autoSend;
  $('#autoSend').addEventListener('change', (e) => { state.autoSend = e.target.checked; store.set('autoSend', state.autoSend); });
} else {
  $('#chatMic').hidden = true;
  $('#autoSendRow').hidden = true;
}

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
    b.addEventListener('click', () => { state.topic = t.id; store.set('topic', t.id); renderBadge(); renderTopics(); renderAsk(); });
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
        (t) => { body.innerHTML = md(t); scrollDown(askLog); }, { role: 'ask' });
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

const askDictation = makeDictation({ input: $('#askInput'), btn: $('#askMic'), lang: () => 'th-TH' });
if (SR) $('#askMic').addEventListener('click', askDictation.toggle);
else $('#askMic').hidden = true;

$('#askClear').addEventListener('click', () => confirmClear('บทสนทนาของหัวข้อนี้', () => {
  db.ask[state.topic] = [];
  persist('ask');
  renderAsk();
}));

/* ---------- settings ---------- */

$('#apiKey').value = state.key;
$('#autoSpeak').checked = state.autoSpeak;
$('#rate').value = state.rate;
$('#rateVal').textContent = state.rate;

$('#apiKey').addEventListener('input', (e) => { state.key = e.target.value.trim(); store.set('key', state.key); });
function renderModelRows() {
  $('#modelRows').replaceChildren(...Object.entries(ROLES).map(([role, label]) => {
    const row = el('div', 'modelsel');
    const b = el('button', 'pick');
    b.type = 'button';
    b.append(el('span', 'rolename', label), el('span', 'rolemodel', state.models[role]));
    b.addEventListener('click', () => pickTextModel(role));
    row.append(b);
    return row;
  }));
}
renderModelRows();
$('#autoSpeak').addEventListener('change', (e) => { state.autoSpeak = e.target.checked; store.set('autoSpeak', state.autoSpeak); });
$('#rate').addEventListener('input', (e) => {
  state.rate = Number(e.target.value);
  $('#rateVal').textContent = state.rate;
  store.set('rate', state.rate);
});

function renderVoices() {
  const sel = $('#voice');
  const list = enVoices();
  sel.replaceChildren(el('option', '', 'อัตโนมัติ'));
  sel.firstChild.value = '';
  for (const v of list) {
    const o = el('option', '', v.name + ' (' + v.lang + ')');
    o.value = v.voiceURI;
    sel.append(o);
  }
  sel.value = list.some((v) => v.voiceURI === state.voice) ? state.voice : '';
}
if ('speechSynthesis' in window) {
  renderVoices();
  speechSynthesis.addEventListener?.('voiceschanged', renderVoices); // รายการเสียงโหลดทีหลังในบางเบราว์เซอร์
}
$('#voice').addEventListener('change', (e) => { state.voice = e.target.value; store.set('voice', state.voice); speak('Nice to meet you.'); });
$('#pitch').value = state.pitch;
$('#pitchVal').textContent = state.pitch;
$('#pitch').addEventListener('input', (e) => {
  state.pitch = Number(e.target.value);
  $('#pitchVal').textContent = state.pitch;
  store.set('pitch', state.pitch);
});
$('#voiceTest').addEventListener('click', () => speak('Hi, nice to meet you. How is your day going?'));

/* ---------- เสียง AI (OpenRouter TTS) ---------- */

const TTS_DEFAULT = 'hexgrad/kokoro-82m';
const KOKORO_GROUP = { af: 'หญิง US', am: 'ชาย US', bf: 'หญิง UK', bm: 'ชาย UK' };

// ตัดเสียงภาษาอื่นออก ให้เหลือเสียงอังกฤษ (บางโมเดลมีเป็นร้อยเสียง)
function voiceFilter(modelId) {
  if (modelId.startsWith('hexgrad/kokoro')) return (v) => /^[ab][fm]_/.test(v);
  if (modelId.startsWith('mistralai/')) return (v) => /^en_/.test(v);
  if (modelId.startsWith('minimax/')) return (v) => /^English/i.test(v);
  if (modelId.startsWith('microsoft/')) return (v) => /^en-/.test(v);
  return () => true;
}

function voiceLabel(modelId, v) {
  if (modelId.startsWith('hexgrad/kokoro')) {
    const g = KOKORO_GROUP[v.slice(0, 2)];
    return g ? `${v.slice(3)} (${g})` : v;
  }
  return v.replace(/:MAI-Voice.*$/, '');
}

function saveTts() { store.set('tts', state.tts); }

async function renderTts() {
  const ai = state.tts.engine === 'openrouter';
  $('#ttsEngine').value = state.tts.engine;
  $('#deviceVoice').hidden = ai;
  $('#aiVoice').hidden = !ai;
  if (!ai) return;
  $('#ttsModelBtn').textContent = state.tts.model || 'เลือกโมเดลเสียง';
  $('#ttsInstr').value = state.tts.instructions;
  const sel = $('#ttsVoice');
  const note = $('#ttsNote');
  note.textContent = state.key ? '' : 'ยังไม่ได้ใส่ OpenRouter API key เสียงจะใช้เสียงของเครื่องแทน';
  try { await loadCatalog('tts'); } catch { /* ใช้โมเดลที่พิมพ์เองได้ */ }
  const m = (catalog.tts || []).find((x) => x.id === state.tts.model);
  if (m?.voices?.length) {
    let voices = m.voices.filter(voiceFilter(m.id));
    if (!voices.length) voices = m.voices;
    sel.replaceChildren(...voices.map((v) => { const o = el('option', '', voiceLabel(m.id, v)); o.value = v; return o; }));
    if (!voices.includes(state.tts.voice)) { state.tts.voice = voices[0]; saveTts(); }
    sel.value = state.tts.voice;
    sel.hidden = false;
  } else {
    sel.hidden = true;
    state.tts.voice = '';
    saveTts();
  }
  note.textContent += (m ? priceText(m, 'tts') + ' คิดตามจำนวนตัวอักษรที่อ่าน ' : '') +
    (m?.id.startsWith('hexgrad/kokoro') ? 'ชื่อเสียงมีกลุ่มเพศ/สำเนียงกำกับ ' : 'ระบบไม่ระบุเพศของเสียง ให้กดฟังตัวอย่างเอง ') +
    'ผมซ่อนโมเดลที่ส่งเสียงแบบ PCM เพราะแอปยังเล่นไม่ได้';
}

$('#ttsEngine').addEventListener('change', (e) => {
  state.tts.engine = e.target.value;
  if (state.tts.engine === 'openrouter' && !state.tts.model) state.tts.model = TTS_DEFAULT;
  saveTts();
  renderTts();
});
$('#ttsModelBtn').addEventListener('click', () => openSheet({
  kind: 'tts',
  title: 'เลือกโมเดลเสียง',
  current: state.tts.model,
  onPick: (id) => { state.tts.model = id; state.tts.voice = ''; saveTts(); renderTts(); },
}));
$('#ttsVoice').addEventListener('change', (e) => { state.tts.voice = e.target.value; saveTts(); speak('Nice to meet you.'); });
$('#ttsInstr').addEventListener('input', (e) => { state.tts.instructions = e.target.value; saveTts(); });
renderTts();

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

/* ---------- ค้นเว็บ (ถามทั่วไป + web search ของ OpenRouter) ---------- */

const webLog = $('#webLog');
const WEB_EMPTY = 'ถามอะไรก็ได้ เช่น "ข่าวล่าสุดเรื่อง...", "ร้านอาหารไทยในลอนดอน", "เปรียบเทียบ iPad กับ MacBook สำหรับเรียน"';

const webPrompt = () => `You are a helpful assistant with live web search. Today is ${new Date().toISOString().slice(0, 10)}.
Answer in the language the user writes in (Thai by default). Use the search results for anything recent or factual, and cite sources as markdown links.
Be concise and practical. If the results disagree or do not answer the question, say so instead of guessing.`;

// รวม citation จาก annotations และตัดลิงก์ซ้ำ รับเฉพาะ http(s)
function sourcesOf(annotations) {
  const seen = new Set();
  const out = [];
  for (const a of annotations || []) {
    const c = a.url_citation || (a.type === 'url_citation' ? a : null);
    const url = c?.url;
    if (!url || !/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep url */ }
    out.push({ url, title: (c.title || host).slice(0, 120) });
  }
  return out;
}

function sourcesBox(list) {
  const box = el('div', 'sources');
  if (!list?.length) return box;
  box.append(el('div', 'srclabel', 'แหล่งข้อมูล'));
  for (const s of list) {
    const a = el('a', '', s.title);
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(a);
  }
  return box;
}

function drawWeb(e) {
  const me = addCard(webLog, 'ask me');
  me.append(el('div', 'body', e.q));
  const ans = addCard(webLog, 'ask');
  const body = el('div', 'body');
  body.innerHTML = md(e.a);
  ans.append(body, sourcesBox(e.sources), copyRow(e.a));
}

function renderWeb() {
  webLog.replaceChildren();
  if (!db.web.length) { emptyNote(webLog, WEB_EMPTY); return; }
  db.web.forEach(drawWeb);
  scrollDown(webLog);
}

$('#webForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#webInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  const me = addCard(webLog, 'ask me');
  me.append(el('div', 'body', q));
  const ans = addCard(webLog, 'ask');
  ans.append(el('div', 'body', 'กำลังค้นหาและเรียบเรียง...'));
  scrollDown(webLog);
  const btn = $('#webForm .send');
  btn.disabled = true;
  try {
    const history = db.web.slice(-6).flatMap((x) => [{ role: 'user', content: x.q }, { role: 'assistant', content: x.a }]);
    const r = await llm(
      [{ role: 'system', content: webPrompt() }, ...history, { role: 'user', content: q }],
      null,
      { role: 'web', stream: false, plugins: [{ id: 'web', max_results: 5 }] },
    );
    const entry = { q, a: r.content, sources: sourcesOf(r.annotations), ts: Date.now() };
    me.remove();
    ans.remove();
    db.web.push(entry);
    persist('web');
    drawWeb(entry);
    scrollDown(webLog);
  } catch (err) {
    me.remove();
    ans.remove();
    errCard(webLog, err);
  }
  btn.disabled = false;
});
autosubmit($('#webInput'), $('#webForm'));

const webDictation = makeDictation({ input: $('#webInput'), btn: $('#webMic'), lang: () => 'th-TH' });
if (SR) $('#webMic').addEventListener('click', webDictation.toggle);
else $('#webMic').hidden = true;

$('#webClear').addEventListener('click', () => confirmClear('บทสนทนาค้นเว็บ', () => {
  db.web = []; persist('web'); renderWeb();
}));

/* ---------- โน้ต ---------- */

const noteFmt = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

function addNote(text) {
  db.notes.unshift({ id: Date.now(), text, ts: Date.now(), pin: false });
  persist('notes');
  renderNotes();
}

function renderNotes() {
  const q = $('#noteSearch').value.trim().toLowerCase();
  const list = db.notes
    .filter((n) => !q || n.text.toLowerCase().includes(q))
    .sort((a, b) => (b.pin - a.pin) || (b.ts - a.ts));
  const log = $('#noteLog');
  if (!list.length) {
    emptyNote(log, db.notes.length ? 'ไม่พบโน้ตที่ค้นหา' : 'ยังไม่มีโน้ต พิมพ์หรือกดไมค์แล้วพูดเพื่อจดได้เลย');
    return;
  }
  log.replaceChildren(...list.map((n) => {
    const c = el('div', 'card note' + (n.pin ? ' pinned' : ''));
    const body = el('div', 'notetext', n.text);
    const meta = el('div', 'sub', (n.pin ? '📌 ' : '') + noteFmt.format(n.ts));
    const acts = el('div', 'acts');
    acts.append(
      actBtn('แก้ไข', () => editNote(c, n)),
      actBtn(n.pin ? 'เลิกปักหมุด' : 'ปักหมุด', () => { n.pin = !n.pin; persist('notes'); renderNotes(); }),
      actBtn('คัดลอก', function () { copy(n.text, this); }),
      actBtn('ลบ', () => { if (confirm('ลบโน้ตนี้?')) { db.notes = db.notes.filter((x) => x !== n); persist('notes'); renderNotes(); } }),
    );
    c.append(body, meta, acts);
    return c;
  }));
}

function editNote(card, n) {
  const ta = el('textarea', 'noteedit');
  ta.value = n.text;
  ta.rows = Math.min(10, Math.max(3, n.text.split('\n').length + 1));
  const acts = el('div', 'acts');
  acts.append(
    actBtn('บันทึก', () => {
      const t = ta.value.trim();
      if (t) { n.text = t; persist('notes'); }
      renderNotes();
    }),
    actBtn('ยกเลิก', renderNotes),
  );
  card.replaceChildren(ta, acts);
  ta.focus();
}

$('#noteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#noteInput');
  const t = input.value.trim();
  if (!t) return;
  input.value = '';
  addNote(t);
});
autosubmit($('#noteInput'), $('#noteForm'));
$('#noteSearch').addEventListener('input', renderNotes);

const noteDictation = makeDictation({
  input: $('#noteInput'),
  btn: $('#noteMic'),
  lang: () => state.noteLang,
  onDone: () => { if (state.noteAuto) $('#noteForm').requestSubmit(); },
});
function renderNoteLang() { $('#noteLang').textContent = state.noteLang === 'th-TH' ? 'ไทย' : 'EN'; }
renderNoteLang();
if (SR) {
  $('#noteMic').addEventListener('click', noteDictation.toggle);
  $('#noteLang').addEventListener('click', () => {
    state.noteLang = state.noteLang === 'th-TH' ? 'en-US' : 'th-TH';
    store.set('noteLang', state.noteLang);
    renderNoteLang();
  });
  $('#noteAuto').checked = state.noteAuto;
  $('#noteAuto').addEventListener('change', (e) => { state.noteAuto = e.target.checked; store.set('noteAuto', state.noteAuto); });
} else {
  $('#noteMic').hidden = $('#noteLang').hidden = $('#noteAutoRow').hidden = true;
}

$$('#notesSeg button').forEach((b) => b.addEventListener('click', () => {
  $$('#notesSeg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#notesPane').hidden = b.dataset.pane !== 'notes';
  $('#savedPane').hidden = b.dataset.pane !== 'saved';
}));

/* ---------- ส่งออก / นำเข้า ---------- */

const SETTING_KEYS = ['models', 'favs', 'tts', 'tone', 'autoSpeak', 'rate', 'pitch', 'autoSend', 'topic', 'mcp', 'noteLang', 'noteAuto'];

function buildExport(withKey) {
  const settings = {
    models: state.models, favs: state.favs, tts: state.tts, tone: state.tone, autoSpeak: state.autoSpeak,
    rate: state.rate, pitch: state.pitch, autoSend: state.autoSend, topic: state.topic, mcp: mcpServers,
    noteLang: state.noteLang, noteAuto: state.noteAuto,
  };
  if (withKey) settings.key = state.key;
  return {
    app: 'helpmepud', version: 1, exportedAt: new Date().toISOString(), settings,
    data: { chat: db.chat, face: db.face, ask: db.ask, web: db.web, saved: db.saved, notes: db.notes },
  };
}

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(buildExport($('#exportKey').checked), null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'helpmepud-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

let pendingImport = null;

// ตรวจชนิดข้อมูลจากไฟล์ที่ผู้ใช้เลือก ไม่เชื่อรูปแบบโดยไม่ตรวจ
function cleanImport(obj) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
  const s = isObj(obj.settings) ? obj.settings : {};
  const d = isObj(obj.data) ? obj.data : {};
  const okUrl = (u) => typeof u === 'string' && (/^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)/.test(u));
  const settings = {};
  if (isObj(s.models)) settings.models = Object.fromEntries(Object.entries(s.models).filter(([k, v]) => k in ROLES && typeof v === 'string'));
  if (Array.isArray(s.favs)) settings.favs = s.favs.filter((x) => typeof x === 'string');
  if (isObj(s.tts)) settings.tts = { engine: s.tts.engine === 'openrouter' ? 'openrouter' : 'device', model: String(s.tts.model || ''), voice: String(s.tts.voice || ''), instructions: String(s.tts.instructions || '') };
  if (s.tone in TONES) settings.tone = s.tone;
  for (const k of ['autoSpeak', 'autoSend', 'noteAuto']) if (typeof s[k] === 'boolean') settings[k] = s[k];
  for (const k of ['rate', 'pitch']) if (typeof s[k] === 'number' && s[k] > 0 && s[k] < 3) settings[k] = s[k];
  if (typeof s.topic === 'string') settings.topic = s.topic;
  if (s.noteLang === 'th-TH' || s.noteLang === 'en-US') settings.noteLang = s.noteLang;
  if (Array.isArray(s.mcp)) {
    settings.mcp = s.mcp.filter((m) => isObj(m) && okUrl(m.url) && m.name)
      .map((m) => ({ id: String(m.id || 'mcp' + Date.now()), name: String(m.name), url: m.url, enabled: m.enabled !== false }));
  }
  if (typeof s.key === 'string' && s.key) settings.key = s.key;
  const ask = {};
  if (isObj(d.ask)) for (const [k, v] of Object.entries(d.ask)) ask[k] = arr(v);
  return { settings, data: { chat: arr(d.chat), face: arr(d.face), web: arr(d.web), saved: arr(d.saved), notes: arr(d.notes), ask } };
}

function applyImport(clean, mode) {
  for (const [k, v] of Object.entries(clean.settings)) store.set(k, v);
  const idOf = (x) => x.id ?? x.ts ?? 0;
  const merge = (cur, inc, keyFn) => {
    const seen = new Set(cur.map(keyFn));
    return cur.concat(inc.filter((x) => !seen.has(keyFn(x))));
  };
  const lists = {
    h_chat: ['chat', (x) => idOf(x) + '|' + x.src, 1],
    h_face: ['face', (x) => idOf(x) + '|' + x.src, 1],
    h_web: ['web', (x) => idOf(x) + '|' + x.q, 1],
    saved: ['saved', (x) => x.en, -1],
    notes: ['notes', (x) => idOf(x) + '|' + x.text, -1],
  };
  for (const [key, [name, keyFn, dir]] of Object.entries(lists)) {
    const inc = clean.data[name];
    const next = mode === 'replace' ? inc : merge(db[name], inc, keyFn);
    next.sort((a, b) => dir * (idOf(a) - idOf(b)));
    store.set(key, next);
  }
  const ask = mode === 'replace' ? {} : { ...db.ask };
  for (const [topic, inc] of Object.entries(clean.data.ask)) {
    ask[topic] = merge(ask[topic] || [], inc, (x) => x.ts + '|' + x.q).sort((a, b) => a.ts - b.ts);
  }
  store.set('h_ask', ask);
  location.reload();
}

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (obj?.app !== 'helpmepud') throw new Error('ไม่ใช่ไฟล์สำรองของแอปนี้');
    pendingImport = cleanImport(obj);
    const c = pendingImport.data;
    const asks = Object.values(c.ask).reduce((n, l) => n + l.length, 0);
    $('#importInfo').textContent = `พบ: แชท ${c.chat.length}, เจอหน้า ${c.face.length}, ถามคำ ${asks}, ค้นเว็บ ${c.web.length}, ` +
      `ประโยคที่บันทึก ${c.saved.length}, โน้ต ${c.notes.length}` +
      (pendingImport.settings.key ? ', รวม API key' : '') +
      '. ค่าตั้งค่าในไฟล์จะทับค่าบนเครื่องนี้ ส่วนข้อมูลเลือกได้ว่าจะรวมหรือแทนที่';
    $('#importBox').hidden = false;
  } catch (err) {
    pendingImport = null;
    $('#importBox').hidden = true;
    alert('นำเข้าไม่ได้: ' + err.message);
  }
});
$('#importMerge').addEventListener('click', () => pendingImport && applyImport(pendingImport, 'merge'));
$('#importReplace').addEventListener('click', () => {
  if (pendingImport && confirm('แทนที่ประวัติ โน้ต และประโยคที่บันทึกบนเครื่องนี้ด้วยข้อมูลในไฟล์ทั้งหมด?')) applyImport(pendingImport, 'replace');
});
$('#importCancel').addEventListener('click', () => { pendingImport = null; $('#importBox').hidden = true; });

renderMcp();
renderTopics();
renderAsk();
renderWeb();
renderNotes();
renderSaved();
renderCont();

if (!state.key) showTab('settings');

if ('speechSynthesis' in window) speechSynthesis.getVoices(); // โหลดรายการเสียงล่วงหน้า

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
