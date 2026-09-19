'use strict';
// =============================================================
//  CbC Tools — hub
//  Node 標準ライブラリのみ（package.json なし・npm install 不要）。
//  別の常駐サーバと同じ流儀に揃えてある。
//
//  役割は3つ:
//    1) 監督   … ツールの起動/停止/自動起動フラグ
//    2) 状態バス … ツール → POST /api/state/<id> → SSE で窓へ
//    3) 窓      … 127.0.0.1:47821 を msedge --app で開く
// =============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ★受け継いだ「Claude の子プロセス」の印を、起動した時点で捨てる。
//   Claude Code は自分が起動した子に CLAUDE_CODE_CHILD_SESSION=1 を渡す。
//   ハブを Claude のセッション内から立て直すと、ハブが起動する全部
//   （wt → powershell → cc.ps1 → claude）がそれを受け継ぎ、
//   **会話ログの保存が丸ごと off になる**（画面に小さく出るだけなので気づかない）。
//   2026-08-17 にこれで 52 分ぶんの作業が保存されず、resume も出来なくなった。
for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_PID']) {
  delete process.env[k];
}

const HOST = '127.0.0.1';
// 待受ポート。既定 47821。
// 環境変数 CBC_PORT で変えられる（他のものと衝突したとき／検証で本番と並走したいとき）。
// 変えた場合は tray/*.ps1 と tools/_shared/cbc.py も同じ値を見るので、
// CbC起動.bat から起動する限りは揃う。
const PORT = Number(process.env.CBC_PORT) || 47821;

const HUB_DIR = __dirname;
const ROOT = path.join(HUB_DIR, '..');
const PUBLIC_DIR = path.join(HUB_DIR, 'public');
const REGISTRY_FILE = path.join(HUB_DIR, 'registry.json');
const STATE_FILE = path.join(HUB_DIR, 'state.json');
const LOG_DIR = path.join(ROOT, 'logs');
const PROBE_PS = path.join(ROOT, 'adapters', 'probe.ps1');
const HUB_LOG = path.join(LOG_DIR, 'hub.log');
// 「全部止める」の意思表示。トレイはこれを見つけたらハブを蘇生させず、
// 自分も畳む。これが無いと窓から止めてもトレイが3秒後に復活させてしまう。
const STOP_FLAG = path.join(LOG_DIR, 'shutdown.flag');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

// =============================================================
//  小道具
// =============================================================
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(HUB_LOG, line, 'utf8'); } catch (_) {}
  process.stdout.write(line);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { log('state 保存に失敗: ' + e.message); }
}

// ファイル末尾の n 行だけを読む（巨大ログでも軽い）
function tailLines(file, n) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, size, st.size - size); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split(/\r?\n/).filter(s => s.length > 0);
    return lines.slice(-n);
  } catch (_) { return []; }
}

// PS 5.1 の標準出力は既定でコンソールのコードページ（このPCでは CP932）で出る。
// Node は utf8 として読むので、日本語が混じると壊れる（実際に踏んだ）。
// 先に UTF-8 を宣言してから走らせる。
const PS_UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';

function runPs(psCommand) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8 + psCommand],
      { windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

function tcpOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { s.destroy(); } catch (_) {} resolve(v); } };
    s.setTimeout(500);
    s.on('connect', () => finish(true));
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
  });
}

// =============================================================
//  registry / 永続状態
// =============================================================
// ── 登録簿の中のパスを、このPCの実際の場所に直す ─────────────
// 以前は registry.json に C:\Users\<名前>\... と直書きしていたため、
// **作った本人のPCでしか動かなかった**（32か所）。
// 下の目印を書いておけば、どのPCでも同じ登録簿がそのまま使える。
//
//   {CBC}   … CbC Tools を置いた場所            （このファイルの1つ上）
//   {HOME}  … ログインしている人のフォルダ        （C:\Users\<名前>）
//   {TOOLS} … {CBC}\tools
//   {LOGS}  … {CBC}\logs
//   %VAR%   … 環境変数（見つからなければそのまま残す）
//
// 文字列のどこに現れても置き換える（launch.exe / args / log / dir / cwd …）。
const PATH_TOKENS = {
  '{CBC}': ROOT,
  '{HOME}': os.homedir(),
  '{TOOLS}': path.join(ROOT, 'tools'),
  '{LOGS}': LOG_DIR,
};

function expandPathTokens(value) {
  if (typeof value === 'string') {
    let s = value;
    for (const [k, v] of Object.entries(PATH_TOKENS)) s = s.split(k).join(v);
    s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) =>
      process.env[name] !== undefined ? process.env[name] : m);
    return s;
  }
  if (Array.isArray(value)) return value.map(expandPathTokens);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandPathTokens(v);
    return out;
  }
  return value;
}

// 初回起動のとき、見本から自分用の登録簿を作る。
// registry.json は「その人のPCの設定」なので、更新のたびに配布物で上書きされては困る。
// 見本(registry.sample.json)は配布物に入っていて、registry.json は入っていない。
const REGISTRY_SAMPLE = path.join(HUB_DIR, 'registry.sample.json');
if (!fs.existsSync(REGISTRY_FILE) && fs.existsSync(REGISTRY_SAMPLE)) {
  try {
    fs.copyFileSync(REGISTRY_SAMPLE, REGISTRY_FILE);
    console.log('registry.json が無かったので、見本から作りました。');
  } catch (e) {
    console.error('registry.json を作れませんでした: ' + e.message);
  }
}

let registry = expandPathTokens(readJson(REGISTRY_FILE, { tools: [] }));
let persist = readJson(STATE_FILE, { autostart: {}, startedByHub: {}, acknowledged: {} });
if (!persist.autostart) persist.autostart = {};
if (!persist.startedByHub) persist.startedByHub = {};
if (!persist.acknowledged) persist.acknowledged = {};

function toolById(id) { return (registry.tools || []).find(t => t.id === id); }

// ツール側の config.json。ツールはこれを見張っていて、書き換えると拾う。
function toolConfigPath(tool) { return path.join(tool.dir, 'config.json'); }

function readToolConfig(tool) {
  const out = Object.assign({}, tool.configurable || {});
  try {
    // BOM を剥がす。PowerShell や一部エディタが付けてくる
    const j = JSON.parse(fs.readFileSync(toolConfigPath(tool), 'utf8').replace(/^﻿/, ''));
    for (const k of Object.keys(out)) if (k in j) out[k] = j[k];
  } catch (_) {}
  return out;
}

function writeToolConfig(tool, patch) {
  const file = toolConfigPath(tool);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) || {}; } catch (_) {}
  const next = Object.assign({}, cur, patch);
  // BOM を付けない。付けると Python 側が素の utf-8 で読めず既定値に戻る
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmp, file);
  return next;
}

// =============================================================
//  プローブ（長寿命の PowerShell が JSON を1行ずつ吐く）
// =============================================================
let snapshot = { ts: null, procs: [], tasks: [] };
let probeChild = null;
let probeAlive = false;

// 登録簿から、見張るべき Windows タスクの名前を集める。
// CbC 自身のタスクは常に含める。
function watchedTaskNames() {
  const names = new Set(['CbC-Hub']);
  for (const t of registry.tools || []) {
    if (t.elevatedTask) names.add(t.elevatedTask);
    if (t.autostart && t.autostart.type === 'task' && t.autostart.task) names.add(t.autostart.task);
    if (t.launch && t.launch.type === 'task-run' && t.launch.task) names.add(t.launch.task);
    if (t.probe && t.probe.type === 'task' && t.probe.task) names.add(t.probe.task);
  }
  return [...names];
}

function startProbe() {
  try {
    probeChild = spawn('powershell.exe',
      // 見張る Windows タスクの名前は、登録簿に書かれているものから組み立てる。
      // 以前は probe.ps1 の中に作者自身のタスク名が直書きされていて、
      // そのPCでしか意味がなかった。
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE_PS,
       '-IntervalSec', '2', '-TaskNames', watchedTaskNames().join(',')],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  } catch (e) {
    log('probe 起動に失敗: ' + e.message);
    return setTimeout(startProbe, 5000);
  }
  probeAlive = true;
  let buf = '';
  probeChild.stdout.setEncoding('utf8');
  probeChild.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        snapshot = {
          ts: o.ts,
          procs: Array.isArray(o.procs) ? o.procs : (o.procs ? [o.procs] : []),
          tasks: Array.isArray(o.tasks) ? o.tasks : (o.tasks ? [o.tasks] : []),
        };
      } catch (_) { /* 壊れた行は捨てる */ }
    }
  });
  probeChild.stderr.on('data', () => {});
  probeChild.on('close', () => {
    probeAlive = false;
    log('probe が落ちた。5秒後に再起動する');
    setTimeout(startProbe, 5000);
  });
}

// ポートは Node 側で見る（PowerShell を挟まない）
let portState = {};
async function refreshPorts() {
  for (const t of registry.tools || []) {
    if (t.probe && t.probe.type === 'port') portState[t.id] = await tcpOpen(t.probe.port);
  }
}

// =============================================================
//  プロセス照合
//  罠(2回踏んでいる): 自分の実行シェルのコマンド文字列にツール名が
//  含まれるため素直に照合すると誤マッチする。-File だけの絞り込みでは
//  不十分で、-Command を含むものを除外する条件が必ず要る。
// =============================================================
function findProcs(needle) {
  if (!needle) return [];
  const nl = needle.toLowerCase();
  return (snapshot.procs || []).filter(p => {
    const cmd = String(p.cmd || '');
    if (!cmd) return false;
    const cl = cmd.toLowerCase();
    if (cl.indexOf(nl) < 0) return false;
    if (cl.indexOf('-command') >= 0) return false;   // ← これが無いと偽陽性
    if (cl.indexOf('probe.ps1') >= 0) return false;  // 自分のプローブも除外
    return true;
  });
}

function taskByName(name) {
  return (snapshot.tasks || []).find(t => t.name === name) || null;
}

// =============================================================
//  anchor 専用のログ解釈
//  LastTaskResult=0 は「成功」を意味しない（実際に11日間空打ちしていた）。
//  本文の OK / FAIL / SKIP でしか本当のことは分からない。
// =============================================================
const ANCHOR_LINE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+\[(\S+)[^\]]*\]\s+(OK|FAIL|SKIP|SETUP|WRONG)\b(.*)$/;

// v4 は機械可読な anchor-status.json を書く。ログの正規表現より確実なので
// あればこちらを使い、無ければ従来のログ解釈に落ちる。
const ANCHOR_STATE_LABEL = {
  OK:    { level: 'ok',    text: '正常' },
  READY: { level: 'ok',    text: 'ログイン済み（次の8時に確かめられます）' },
  SETUP: { level: 'alert', text: 'ログインしていません' },
  MISSING: { level: 'alert', text: 'このアカウントが打てていません' },
  FAIL:  { level: 'alert', text: '失敗しています' },
};

// status.json は朝に1回しか更新されない。ログインした直後は「未ログイン」の
// ままになり、窓が嘘をつく。プロファイルは今この瞬間の事実なので、そちらを
// 見て status.json を補正する。取り違えも朝を待たずにここで分かる。
// -------------------------------------------------------------
//  アカウント名簿を読む。場所は registry.json の accounts.rosterFile で指定する
//  （この機能は任意。registry.json に accounts が無ければ、窓にも出ない）
// -------------------------------------------------------------
//  ★"enabled": false は【一時無効化】。名簿から消さずに休ませる印で、
//    休んでいる間は窓にも出さないし、朝8時アンカーの判定からも外す。
//    資格情報(profiles\<key>)は残っているので、名簿を戻せば復帰する。
function readRosterFile() {
  const f = ACC && ACC.rosterFile;
  if (!f) return null;
  try {
    let raw = fs.readFileSync(f, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const list = (JSON.parse(raw).accounts || []).filter(a => a && a.key);
    if (!list.length) return null;
    const off = list.filter(a => a.enabled === false);
    return {
      enabled: list.filter(a => a.enabled !== false).map(a => String(a.key)),
      disabled: off.map(a => String(a.key)),
      disabledMails: new Set(off.filter(a => a.email).map(a => String(a.email).toLowerCase())),
    };
  } catch (_) { return null; }   // 読めなければ registry.json の予備に落ちる
}

// 休止中のアカウントのメール（記録に残った古い行を落とすのに使う）
function restingMails() {
  const r = readRosterFile();
  return (r && r.disabledMails) || new Set();
}

// 朝8時アンカーが相手にするアカウント。名簿が正で、registry.json は予備。
function anchorKeys(tool) {
  const r = readRosterFile();
  if (r && r.enabled.length) return r.enabled;
  return (tool.logRule && tool.logRule.accounts) || [];
}

function anchorProfiles(tool) {
  const root = (tool.logRule && tool.logRule.profilesDir) || null;
  if (!root) return {};
  const out = {};
  for (const key of anchorKeys(tool)) {
    const dir = path.join(root, key);
    let email = null, hasToken = false;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8').replace(/^﻿/, ''));
      if (j && j.oauthAccount) email = j.oauthAccount.emailAddress || null;
    } catch (_) {}
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8').replace(/^﻿/, ''));
      hasToken = !!(c && c.claudeAiOauth && c.claudeAiOauth.accessToken);
    } catch (_) {}
    out[key] = { email, hasToken };
  }
  return out;
}

// 実行結果(status.json) と 現在のログイン状態(プロファイル) を突き合わせる
function reconcileAnchorRows(rows, profs) {
  for (const r of rows) {
    const p = profs[r.account];
    if (!p) continue;

    // ★枠の名前と中身が違っても異常にしない。
    //   走行中に /login でアカウントを乗り換えるのは普通の操作で、枠は入れ物にすぎない
    //   （accounts.json の注記どおり）。中身は参考情報として持つだけ。
    if (p.hasToken && p.email) r.actual = p.email;
    // 旧版が書いた 'WRONG'（枠名と中身が違う＝打たずにスキップ）は、今の意味では異常ではない。
    // 記録は8時に1回しか更新されないので、読み替えないとログイン済みでもボタンが消えない。
    if (r.result === 'WRONG') { r.result = p.hasToken ? 'READY' : 'SETUP'; continue; }
    // 未ログイン扱いだが、実際にはもうログインしている（＝まだ朝が来ていないだけ）
    if (r.result === 'SETUP' && p.hasToken) { r.result = 'READY'; continue; }
    // ログイン済み扱いだが、資格情報が消えている
    if (r.result === 'OK' && !p.hasToken) { r.result = 'SETUP'; }
  }
  return rows;
}

function anchorStatusFromJson(tool) {
  const f = (tool.logRule && tool.logRule.statusJson) || null;
  if (!f) return null;
  let s;
  try {
    // PS の Set-Content -Encoding UTF8 は BOM を付ける。剥がさないと JSON.parse が落ちる
    s = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  } catch (_) { return null; }
  if (!s || !Array.isArray(s.accounts)) return null;

  // 休止中のアカウントの行は落とす。記録には前回までの結果が残っているので、
  // そのまま見せると「休ませたのに未ログインだと言われる」ことになる。
  const keys = anchorKeys(tool);
  let rows = s.accounts.map(a => ({
    account: a.key, email: a.email, result: a.state, actual: a.actual || null, msg: a.msg || '',
  })).filter(r => keys.includes(r.account));
  const profs = anchorProfiles(tool);
  rows = reconcileAnchorRows(rows, profs);

  // ★見るのは「枠」ではなく「アカウント」。
  //   枠の中身は /login で入れ替わるので、枠名との一致は意味を持たない。
  //   知りたいのは「名簿の各アカウントの5時間枠が朝8時に始まったか」だけ。
  //   anchor.ps1 が coverage を書く。無い場合（古い status.json）は
  //   今のプロファイルの中身から同じことを組み立てる。
  const roster = anchorKeys(tool);
  let coverage = Array.isArray(s.coverage) ? s.coverage.slice() : null;
  if (!coverage) {
    const firedNow = new Set(rows.filter(r => r.result === 'OK' && r.actual).map(r => r.actual));
    const live = new Set(Object.values(profs).filter(p => p.hasToken && p.email).map(p => p.email));
    coverage = roster.map((k) => {
      const row = rows.find(r => r.account === k);
      const email = (row && row.email) || null;
      return { email, label: null, anchored: !!(email && firedNow.has(email)), live: !!(email && live.has(email)) };
    });
  }
  // 休止中のアカウントは coverage にも残っている（記録は朝に1回しか書き換わらない）。
  // 打たないと決めたものを「打てていない」と言わせない。
  const offMails = restingMails();
  coverage = coverage.filter(c => !(c.email && offMails.has(String(c.email).toLowerCase())));
  const missing = coverage.filter(c => !c.anchored);

  // どの枠にも入っていない＝ログインし直さないと永久に打てない
  const liveEmails = new Set(Object.values(profs).filter(p => p.hasToken && p.email).map(p => p.email));
  const unreachable = missing.filter(c => c.email && !liveEmails.has(c.email));
  const notYet = missing.filter(c => c.email && liveEmails.has(c.email));

  let level = 'ok';
  let detail;
  if (unreachable.length) {
    level = 'alert';
    detail = `${unreachable.map(c => c.email).join(' / ')} が朝8時に打てていません`
           + '（どれか1つの枠でそのアカウントにログインすると直ります）';
  } else if (rows.some(r => r.result === 'FAIL')) {
    level = 'alert';
    const f = rows.filter(r => r.result === 'FAIL');
    detail = `失敗しています — ${f.map(r => `${r.actual || r.email}: ${r.msg}`).join(' / ')}`;
  } else if (notYet.length) {
    detail = `ログイン済み。次の8時に実際に打てるか分かります（${notYet.map(c => c.email).join(' / ')}）`;
  } else {
    const ageH = (Date.now() - (s.ranAtMs || 0)) / 3600000;
    if (ageH > 96) { level = 'warn'; detail = `4日以上動いていません（最後は ${s.ranAt}）`; }
    else detail = `正常（最後は ${s.ranAt}）`;
  }
  return { level, detail, rows, coverage, unreachable, ranAt: s.ranAt || null, source: 'status.json' };
}

function anchorStatus(tool) {
  const fromJson = anchorStatusFromJson(tool);
  if (fromJson) return fromJson;
  return anchorStatusFromLog(tool);
}

function anchorStatusFromLog(tool) {
  const rule = tool.logRule || {};
  const accounts = rule.accounts || [];
  const lines = tailLines(tool.log, 200);
  const latest = {};
  for (const ln of lines) {
    const m = ANCHOR_LINE.exec(ln.trim());
    if (!m) continue;
    latest[m[3]] = { date: m[1], time: m[2], result: m[4], rest: (m[5] || '').trim() };
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dow = now.getDay();                    // 0=日
  const isWeekday = dow >= 1 && dow <= 5;      // 現行トリガは月〜金
  const past0810 = now.getHours() > 8 || (now.getHours() === 8 && now.getMinutes() >= 10);

  const rows = accounts.map(a => ({ account: a, ...(latest[a] || { result: 'NONE' }) }));
  const bad = rows.filter(r => r.result !== 'OK');
  const ranToday = rows.some(r => r.date === today);

  let level = 'ok';
  let detail;
  if (rows.length === 0 || rows.every(r => r.result === 'NONE')) {
    level = 'warn'; detail = 'ログに発火記録がありません';
  } else if (bad.length > 0) {
    level = 'alert';
    const kinds = Array.from(new Set(bad.map(r => r.result)));
    detail = (kinds.includes('SKIP') || kinds.includes('SETUP'))
      ? `ログインしていません — ${bad.map(r => r.account).join(' / ')}`
      : `失敗しています — ${bad.map(r => `${r.account}:${r.result}`).join(' / ')}`;
  } else if (isWeekday && past0810 && !ranToday) {
    level = 'warn'; detail = '今日の発火記録がまだありません';
  } else {
    const when = rows[0] && rows[0].date ? `${rows[0].date} ${rows[0].time}` : '';
    detail = `直近OK（${when}）`;
  }
  return { level, detail, rows };
}

// =============================================================
//  ツール状態の算出
// =============================================================
function autostartInfo(tool) {
  const a = tool.autostart || { type: 'none' };
  if (a.type === 'task') {
    const t = taskByName(a.task);
    if (!t || t.state === 'Missing') return { supported: true, on: false, source: 'task', note: 'タスク未登録', task: a.task };
    return { supported: true, on: t.state !== 'Disabled', source: 'task', task: a.task, state: t.state };
  }
  if (a.type === 'hub') {
    const on = Object.prototype.hasOwnProperty.call(persist.autostart, tool.id)
      ? !!persist.autostart[tool.id] : !!a.enabled;
    return { supported: true, on, source: 'hub' };
  }
  return { supported: false, on: false, source: 'none' };
}

let pushedState = {};   // ツールが POST /api/state/<id> で投げてきたもの

// 押した直後の空白を埋める。プローブが実態を確認するまで「〜しています」と
// 出し、確認できたら消える。確認できないまま時間切れなら、そう言う。
const PENDING_MS = 15000;
let pendingOps = {};    // id -> { want:'running'|'stopped', at, label }

// 穏やかな停止。ツールは2秒ごとに状態を投げてくるので、その返事に
// 「畳んでくれ」と書いて返す。ツールは後始末（ミュート解除・位置保存）を
// してから自分で終わる。いきなり kill すると後始末が走らない。
let quitRequests = new Set();

function applyPending(out) {
  const pend = pendingOps[out.id];
  if (!pend) return out;
  if (out.state === pend.want) { delete pendingOps[out.id]; return out; }
  const age = Date.now() - pend.at;
  if (age > PENDING_MS) {
    delete pendingOps[out.id];
    out.state = 'warn';
    out.detail = `${pend.label}が効きませんでした（${Math.round(age / 1000)}秒待って変化なし）`;
    return out;
  }
  out.pending = pend.want;
  out.detail = `${pend.label}しています…`;
  out.canStart = false;
  out.canStop = false;
  return out;
}

function computeTool(tool) {
  const out = {
    id: tool.id,
    name: tool.name,
    desc: tool.desc,
    mode: tool.mode,
    implemented: !!tool.implemented,
    plannedIn: tool.plannedIn || null,
    protected: tool.protected || null,
    dir: tool.dir,
    open: tool.open || null,
    hasLog: !!tool.log,
    // 窓から変えられる設定（今の値）
    configurable: tool.configurable ? readToolConfig(tool) : null,
    // 直せるもの。押せば直る場所だけを出す（困っている対象だけ）
    fixes: [],
    // 警報の同一性。窓の「確認」はこれを覚える。
    // detail をそのまま鍵にすると、こちらが文言を直しただけで
    // 警報が鳴り直してしまうので、異常の種類を鍵にする。
    alertKey: null,
    canStart: false,
    canStop: false,
    state: 'unknown',
    detail: '',
    pid: null,
    owner: null,
    autostart: autostartInfo(tool),
    extra: null,
  };

  if (!tool.implemented) {
    out.state = 'planned';
    out.detail = `未実装（${tool.plannedIn || '別タスク'} で作る）`;
    return out;
  }
  out.pending = null;

  const probe = tool.probe || { type: 'none' };

  if (probe.type === 'process') {
    const ps = findProcs(probe.match);
    if (ps.length > 0) {
      out.state = 'running';
      out.pid = ps[0].pid;
      out.owner = persist.startedByHub[tool.id] ? 'hub' : 'external';
      out.canStop = true;
      const last = tool.log ? tailLines(tool.log, 1)[0] : null;
      out.detail = last ? last.trim() : `稼働中 (PID ${out.pid})`;
    } else {
      out.state = 'stopped';
      out.detail = '停止中';
      out.canStart = !!tool.launch;
    }
  } else if (probe.type === 'port') {
    const up = !!portState[tool.id];
    if (up) {
      out.state = 'running';
      out.owner = persist.startedByHub[tool.id] ? 'hub' : 'external';
      out.canStop = out.owner === 'hub';
      out.detail = out.owner === 'hub'
        ? `稼働中（CbC が起動・ポート ${probe.port}）`
        : `稼働中（外部起動なので CbC からは止めない・ポート ${probe.port}）`;
    } else {
      out.state = 'stopped';
      out.detail = '停止中';
      out.canStart = !!tool.launch;
      // 起動直後は「まだポートが開いていないだけ」なので所有権を手放さない。
      // ここで消すと、立ち上がった後に外部起動と誤認して停止ボタンが死ぬ。
      const started = persist.startedByHub[tool.id];
      if (started && (Date.now() - started) > 60000) {
        delete persist.startedByHub[tool.id]; savePersist();
      }
    }
  } else if (probe.type === 'task+logtail') {
    const t = taskByName(probe.task);
    const st = anchorStatus(tool);
    out.extra = { task: t, rows: st.rows };
    // ★ボタンは「8時の記録」ではなく「今この瞬間の枠の中身」から出す。
    //   記録は1日1回しか更新されないので、そちらを見ているとログイン直後に
    //   ボタンが消えない（実際にそうなった）。
    const profsNow = anchorProfiles(tool);
    const rosterKeys = anchorKeys(tool);
    const emailOf = {};
    for (const r of (st.rows || [])) emailOf[r.account] = r.email;

    const needLogin = [];
    // (a) 中身が空の枠 → そこにログインすれば埋まる
    for (const k of rosterKeys) {
      const p = profsNow[k];
      if (!p || !p.hasToken) needLogin.push(k);
    }
    // (b) どの枠にも入っていないアカウント → その名前の枠に入れてもらう
    const liveEmails = new Set(Object.values(profsNow).filter(x => x.hasToken && x.email).map(x => x.email));
    for (const k of rosterKeys) {
      if (needLogin.includes(k)) continue;
      const want = emailOf[k];
      if (want && !liveEmails.has(want)) needLogin.push(k);
    }

    const broken = (st.rows || []).filter(r => r.result !== 'OK' && r.result !== 'READY');
    const kinds = Array.from(new Set(broken.map(r => `${r.account}:${r.result}`))).sort();
    out.alertKey = needLogin.length ? ('login:' + needLogin.sort().join(','))
                 : (kinds.length ? kinds.join(',') : null);

    if (tool.fix) {
      out.fixes = needLogin.map(k => ({ key: k, label: `${k} でログイン` }));
    }
    out.canStart = !!tool.launch;           // 手動発火
    if (!t || t.state === 'Missing') {
      out.state = 'stopped';
      out.detail = 'タスクが登録されていません';
    } else if (st.level === 'alert') {
      out.state = 'alert';
      out.detail = st.detail;
    } else if (st.level === 'warn') {
      out.state = 'warn';
      out.detail = st.detail;
    } else {
      out.state = t.state === 'Disabled' ? 'stopped' : 'running';
      out.detail = t.state === 'Disabled' ? `無効（${st.detail}）` : st.detail;
    }
  } else if (probe.type === 'heartbeat') {
    const hb = pushedState[tool.id];
    const maxAge = (probe.maxAgeSec || 8) * 1000;
    if (hb && (Date.now() - hb.at) < maxAge) {
      out.state = hb.level === 'alert' ? 'alert' : 'running';
      out.detail = hb.detail || '稼働中';
      out.pid = hb.pid || null;
      out.owner = 'hub';
      out.canStop = true;
      out.extra = hb.extra || null;
    } else {
      out.state = 'stopped';
      out.detail = '停止中';
      out.canStart = !!tool.launch;
    }
  }

  return applyPending(out);
}

function computeAll() {
  return (registry.tools || []).map(computeTool);
}

function overall(tools) {
  const live = tools.filter(t => t.implemented);
  if (live.some(t => t.state === 'alert')) return 'alert';
  if (live.some(t => t.state === 'warn')) return 'warn';
  // 都度起動のものは、止まっているのが普通の状態。全体判定から外す
  const expected = live.filter(t => t.mode !== 'ondemand');
  if (expected.every(t => t.state === 'running')) return 'ok';
  return 'partial';
}

function savePersist() { writeJsonAtomic(STATE_FILE, persist); }

// =============================================================
//  操作
// =============================================================
function launchDetached(exe, args) {
  const p = spawn(exe, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
  p.unref();
  return p;
}

// 直し方の案内は「見えないと意味がない」ので、ここだけ窓を出す。
// 対話（/login の入力・ブラウザ承認）が要るため windowsHide は false。
function launchVisible(exe, args) {
  const p = spawn(exe, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: false });
  p.unref();
  return p;
}

async function startTool(id) {
  const tool = toolById(id);
  if (!tool) return { ok: false, error: 'unknown tool' };
  if (!tool.implemented) return { ok: false, error: '未実装です' };
  if (!tool.launch) return { ok: false, error: '起動方法が定義されていません' };

  if (tool.launch.type === 'task-run') {
    const r = await runPs(`Start-ScheduledTask -TaskName '${tool.launch.task.replace(/'/g, "''")}'`);
    log(`start ${id} via task: ${r.ok ? 'ok' : r.err}`);
    return r.ok ? { ok: true, via: 'task' } : { ok: false, error: r.err.trim() || 'タスク起動に失敗' };
  }

  // 昇格が要るもの（keyboard フックはゲーム/VR が前面だと非昇格で取りこぼす）。
  // RunLevel Highest のタスクを schtasks /Run で叩くと UAC が出ない。
  // タスクが無ければ普通に起動する（効きが弱いだけで動きはする）。
  if (tool.elevated && tool.elevatedTask) {
    const t = taskByName(tool.elevatedTask);
    if (t && t.state !== 'Missing' && t.state !== 'Disabled') {
      const r = await runPs(`Start-ScheduledTask -TaskName '${tool.elevatedTask.replace(/'/g, "''")}'`);
      if (r.ok) {
        persist.startedByHub[id] = Date.now();
        savePersist();
        pendingOps[id] = { want: 'running', at: Date.now(), label: '起動' };
        log(`start ${id} via elevated task`);
        return { ok: true, via: 'task' };
      }
      log(`elevated task 失敗、素で起動する: ${r.err}`);
    }
  }

  try {
    launchDetached(tool.launch.exe, tool.launch.args || []);
    persist.startedByHub[id] = Date.now();
    savePersist();
    pendingOps[id] = { want: 'running', at: Date.now(), label: '起動' };
    log(`start ${id}: ${tool.launch.exe}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function stopTool(id) {
  const tool = toolById(id);
  if (!tool) return { ok: false, error: 'unknown tool' };
  const cur = computeTool(tool);

  if (tool.mode === 'external' && cur.owner === 'external') {
    return { ok: false, error: '外部起動なので CbC からは止めません' };
  }
  if (tool.mode === 'scheduled') {
    return { ok: false, error: 'スケジュール実行なので停止対象ではありません（自動起動トグルで無効化してください）' };
  }

  // 昇格して動いているものは、非昇格のハブからは kill できない（アクセス拒否）。
  // 起こしたのがタスクなら、タスクに止めさせる。
  if (tool.elevated && tool.elevatedTask) {
    const t = taskByName(tool.elevatedTask);
    if (t && t.state === 'Running') {
      const r = await runPs(`Stop-ScheduledTask -TaskName '${tool.elevatedTask.replace(/'/g, "''")}'`);
      if (r.ok) {
        delete persist.startedByHub[id];
        savePersist();
        pendingOps[id] = { want: 'stopped', at: Date.now(), label: '停止' };
        log(`stop ${id} via elevated task`);
        return { ok: true, via: 'task' };
      }
      log(`elevated task の停止に失敗、kill を試す: ${r.err}`);
    }
  }

  // 心拍で生きているツールには、まず自分で畳んでもらう。
  // 後始末（ミュート解除・位置保存）はツール側にしかできない。
  if (tool.probe && tool.probe.type === 'heartbeat') {
    quitRequests.add(id);
    log(`stop ${id}: 畳むよう頼んだ`);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400));
      const hb = pushedState[id];
      // 心拍が途切れた＝自分で終わった
      if (!hb || (Date.now() - hb.at) > 5000) {
        quitRequests.delete(id);
        delete pushedState[id];
        delete persist.startedByHub[id];
        savePersist();
        pendingOps[id] = { want: 'stopped', at: Date.now(), label: '停止' };
        log(`stop ${id}: 自分で畳んだ`);
        return { ok: true, via: 'graceful' };
      }
    }
    quitRequests.delete(id);
    log(`stop ${id}: 畳まなかったので kill する`);
  }

  let pids = [];
  if (tool.probe && tool.probe.type === 'process') {
    pids = findProcs(tool.probe.match).map(p => p.pid);
  } else if (tool.probe && tool.probe.type === 'port') {
    // ポート待受のプロセスを PID で特定する
    const r = await runPs(`(Get-NetTCPConnection -LocalPort ${tool.probe.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
    const pid = parseInt(r.out.trim(), 10);
    if (pid) pids = [pid];
  } else if (tool.probe && tool.probe.type === 'heartbeat') {
    if (cur.pid) pids = [cur.pid];
  }

  if (pids.length === 0) return { ok: false, error: '対象プロセスが見つかりません' };

  let killed = 0;
  for (const pid of pids) {
    try { process.kill(pid); killed++; } catch (e) { log(`kill ${pid} 失敗: ${e.message}`); }
  }
  delete persist.startedByHub[id];
  savePersist();
  if (killed > 0) pendingOps[id] = { want: 'stopped', at: Date.now(), label: '停止' };
  log(`stop ${id}: killed ${killed}/${pids.length}`);
  return killed > 0 ? { ok: true, killed } : { ok: false, error: '停止できませんでした' };
}

async function setAutostart(id, on) {
  const tool = toolById(id);
  if (!tool) return { ok: false, error: 'unknown tool' };
  const a = tool.autostart || { type: 'none' };

  if (a.type === 'hub') {
    persist.autostart[id] = !!on;
    savePersist();
    return { ok: true };
  }
  if (a.type === 'task') {
    const name = a.task.replace(/'/g, "''");
    const cmd = on ? `Enable-ScheduledTask -TaskName '${name}'` : `Disable-ScheduledTask -TaskName '${name}'`;
    const r = await runPs(cmd);
    if (!r.ok) return { ok: false, error: (r.err || '').trim() || 'タスクの切替に失敗（管理者権限が要るかもしれません）' };
    log(`autostart ${id} -> ${on}`);
    return { ok: true };
  }
  return { ok: false, error: 'このツールは自動起動に対応していません' };
}

function findEdge() {
  for (const p of EDGE_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return null;
}

function openWindow(url, w, h) {
  const edge = findEdge();
  try {
    if (edge) {
      launchDetached(edge, [`--app=${url}`, `--window-size=${w || 1040},${h || 800}`]);
    } else {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, shell: false }).unref();
    }
    return { ok: true, via: edge ? 'edge-app' : 'default-browser' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 全停止＋復元。stopOrder の小さい順（復元ハンドラを持つものを先に）
async function shutdownAll() {
  const tools = (registry.tools || [])
    .filter(t => t.implemented && (t.mode === 'daemon' || t.mode === 'ondemand'))
    .sort((a, b) => (a.stopOrder || 999) - (b.stopOrder || 999));
  const results = [];
  for (const t of tools) {
    const cur = computeTool(t);
    if (cur.state === 'running' && cur.canStop) {
      const r = await stopTool(t.id);
      results.push({ id: t.id, ...r });
    }
  }
  return results;
}

// =============================================================
//  HTTP
// =============================================================
// =============================================================
//  Claude アカウント（2つを使い分ける）
// -------------------------------------------------------------
//  中身は registry.json の accounts に書かれた切替スクリプトを呼ぶだけ。使用量の取得も
//  資格情報の扱いも向こうの仕事で、CbC 側では複製しない。
//  （名簿は読むだけ・書き換え禁止。ここでも一切書かない）
//
//  ★走っているセッションのアカウントは変えられない。資格情報はプロセス
//    起動時に決まるため。ここで出来るのは「次を選んで開く」ことまでで、
//    窓の文言もそう書く。出来ないことが出来るように見える盤にしない。
// =============================================================
const ACC = registry.accounts || null;
const ACC_REFRESH_MS = Math.max(30, (ACC && ACC.refreshSec) || 120) * 1000;

// triedAt = 最後に取りに行った時刻 / dataAt = 今出ている数字を読めた時刻。
// 分けないと、取得に失敗した瞬間に「たった今の数字」だと嘘をつくことになる
// （古い list を出したまま時刻だけ新しくなる）。
let accounts = { triedAt: 0, dataAt: 0, ok: false, error: null, pick: null, reason: '', list: [], backoffUntil: 0 };
let accountsBusy = false;

// PS 5.1 の ConvertTo-Json は DateTime を "/Date(1786939200196)/" で書く。
// JSON.parse からはただの文字列に見えるので、ここでミリ秒に直す。
function psDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^\/Date\((-?\d+)\)\/$/.exec(v);
  if (m) return Number(m[1]);
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

// ★ -File ではなく -Command で呼ぶ。-File だと出力が CP932 のままで
//   日本語が壊れる（switch.ps1 の reason が読めなくなった）。
//   args は呼び出し側が決める定数だけを渡すこと（ここでは '-Json'）。
//   利用者の入力をそのまま混ぜない——コマンド文字列に入るため。
function runPsFile(file, args, timeoutMs) {
  const cmd = `${PS_UTF8}& '${String(file).replace(/'/g, "''")}' ${(args || []).join(' ')}`;
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, timeout: timeoutMs || 25000, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

// =============================================================
//  使用量は【セッション盤面から貰う】— 自分では API を叩かない
// -------------------------------------------------------------
//  以前は switch.ps1 -Json を実行して、ここでも /api/oauth/usage を叩いていた。
//  盤面・見張り・ここの3箇所が同じ API を叩くので 429 を踏み、窓の数字が
//  ときどき「読み取れませんでした」になっていた（不安定の正体）。
//  取りに行く箱を盤面ひとつに絞り、ここは結果を読むだけにする。
//  ★ 資格情報もアカウント名簿も CbC 側では持たない（盤面と anchor が持つ）。
// =============================================================
function fetchBoardStatus(force) {
  return new Promise((resolve) => {
    if (!ACC || !ACC.boardUrl) return resolve({ ok: false, error: 'boardUrl が設定されていません' });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = new URL(force ? '/api/status/refresh' : '/api/status', ACC.boardUrl);
    const opt = {
      hostname: u.hostname, port: u.port, path: u.pathname, method: force ? 'POST' : 'GET',
      headers: force ? { 'Content-Type': 'application/json', 'Content-Length': 2 } : {},
    };
    const req = http.request(opt, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish({ ok: false, error: `盤面が ${res.statusCode} を返しました` }); }
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
      res.on('end', () => {
        try { finish({ ok: true, data: JSON.parse(b) }); }
        catch (_) { finish({ ok: false, error: '盤面の返事を読めませんでした' }); }
      });
    });
    req.on('error', () => finish({ ok: false, boardDown: true, error: 'セッション盤面が動いていません（4788）' }));
    req.setTimeout(force ? 25000 : 8000, () => { req.destroy(); finish({ ok: false, error: '盤面の応答が遅すぎます' }); });
    if (force) req.write('{}');
    req.end();
  });
}

// 盤面の形 → 窓がこれまで使ってきた形。UI を作り直さずに中身だけ入れ替える。
function mapBoardAccounts(d) {
  const pick = (a, kind) => (a.limits || []).find((l) => l.kind === kind) || null;
  return (d.accounts || []).map((a) => {
    const five = pick(a, 'session'), week = pick(a, 'weekly_all');
    const hasData = !!(a.limits && a.limits.length);
    // リセット時刻を過ぎた枠の扱いは盤面と同じ規則にする。
    //   新鮮なライブ値のときだけ「もう新しい窓＝0%」と言い切り、
    //   古い値のときは 0% と断定しない（分からないものを分かった顔で出さない）。
    const modeOf = (l) => (!l.expired ? 'ok' : ((a.source === 'live' && a.freshness === 'fresh') ? 'reset' : 'unknown'));
    const pv = (l) => (l ? (modeOf(l) === 'reset' ? 0 : l.percent) : null);
    const stale = [five, week].some((l) => l && modeOf(l) === 'unknown');
    const notes = [];
    if (a.plan) notes.push(a.plan);
    if (a.active) notes.push('いま開く先');
    if (a.source === 'unauth') notes.push('未ログイン');
    else if (stale) notes.push('リセット時刻は過ぎたが未確認');
    else if (a.freshness === 'stale' && a.fetchedAtMs) notes.push('古い値');
    else if (a.source === 'cache') notes.push('Claude Code のキャッシュ');
    return {
      key: a.rosterKey || a.key,
      mail: a.email || a.rosterKey || a.key,
      state: hasData ? 'ok' : (a.source === 'unauth' ? 'unauth' : 'nodata'),
      fiveHour: pv(five), fiveReset: five ? five.resetsAt : null,
      weekly: pv(week), weekReset: week ? week.resetsAt : null,
      plan: a.plan || null, active: !!a.active, primary: !!a.primary,
      note: notes.join('・'),
    };
  });
}

// どれで開くのが良いか。名簿の主アカウントを優先し、詰まっていれば空いている方へ。
function pickFrom(list) {
  const usable = list.filter((a) => a.state === 'ok' && a.fiveHour != null && a.fiveHour < 92);
  if (!usable.length) return { pick: null, reason: 'どのアカウントも5時間枠が埋まっています。' };
  const primary = usable.find((a) => a.primary);
  const best = primary || usable.slice().sort((a, b) => a.fiveHour - b.fiveHour)[0];
  return {
    pick: best.key,
    reason: primary ? `主アカウント ${best.key} が使えます（5時間 ${best.fiveHour}%）。`
                    : `${best.key} が一番空いています（5時間 ${best.fiveHour}%）。`,
  };
}

async function refreshAccounts(force) {
  if (!ACC || !ACC.boardUrl) return;
  if (accountsBusy) return;
  if (!force && accounts.backoffUntil && Date.now() < accounts.backoffUntil) return;
  if (!force && Date.now() - accounts.triedAt < ACC_REFRESH_MS) return;

  accountsBusy = true;
  const r = await fetchBoardStatus(!!force);
  accountsBusy = false;
  accounts.triedAt = Date.now();

  if (!r.ok) {
    accounts.ok = false;
    accounts.error = r.error || '盤面から使用量を読めませんでした';
    // 盤面が止まっているだけならそのうち立ち上がる。少し待ってから聞き直す
    accounts.backoffUntil = r.boardDown ? Date.now() + 60 * 1000 : 0;
    log(`accounts 取得に失敗: ${accounts.error}`);
    broadcast();
    return;
  }

  const list = mapBoardAccounts(r.data);
  // ★1つも読めていないなら「読めた」と言わない（窓が嘘をつくのを防ぐ）
  if (!list.some((a) => a.state === 'ok')) {
    accounts.ok = false;
    accounts.error = 'まだどのアカウントの使用量も取れていません';
    accounts.list = list;
    broadcast();
    return;
  }

  const p = pickFrom(list);
  const act = (r.data.accounts || []).find((a) => a.active);
  accounts.ok = true;
  accounts.error = null;
  accounts.backoffUntil = 0;
  accounts.dataAt = (act && act.fetchedAtMs)
    || Math.max(0, ...(r.data.accounts || []).map((a) => a.fetchedAtMs || 0))
    || accounts.triedAt;
  accounts.pick = p.pick;
  accounts.reason = p.reason;
  accounts.list = list;
  broadcast();
}

function accountsPayload() {
  if (!ACC) return null;
  return {
    ok: accounts.ok,
    // ★「まだ取りに行っていない」と「取りに行って読めなかった」は別。
    //   窓を見ている間しか取りに行かないので、起動直後は必ず未取得になる。
    //   ここを一緒にすると、正常なのに「読み取れませんでした」と出る。
    tried: accounts.triedAt > 0,
    error: accounts.error,
    pick: accounts.pick,
    reason: accounts.reason,
    // 古い数字を灰色で殺さない。「何時時点か」を文章で言うために持たせる
    dataAt: accounts.dataAt || null,
    ageSec: accounts.dataAt ? Math.round((Date.now() - accounts.dataAt) / 1000) : null,
    busy: accountsBusy,
    list: accounts.list,
  };
}

// wt があればタブで、無ければ普通の窓で開く。
// ★wt.exe は自分のコマンド行を自分で解釈するので `;` を渡さない。
//   渡すとサブコマンド区切りとして食われ、そこから先が落ちる（実際に踏んだ）。
function launchTerminal(title, exe, args) {
  let p;
  try {
    p = spawn('wt.exe', ['new-tab', '--title', title, exe, ...args],
      { stdio: 'ignore', detached: true, shell: false, windowsHide: false });
  } catch (_) {
    return launchVisible(exe, args);
  }
  p.on('error', () => { try { launchVisible(exe, args); } catch (_) {} });
  p.unref();
  return p;
}

// -------------------------------------------------------------
//  セッション一覧は session-board から借りる（作り直さない）
// -------------------------------------------------------------
//  board は既にこの登録簿にある常駐ツールで、全件返す GET を持っている。
//  走査ロジック(server.js の deepExtract)を写すと同じものを2箇所で
//  保守することになり、片方だけ古くなる。CbC は登録簿と起動係。
//  ★board 配下のファイルには触らない。HTTP GET だけ。
function fetchBoardSessions() {
  return new Promise((resolve) => {
    if (!ACC || !ACC.boardUrl) return resolve({ ok: false, error: 'boardUrl が設定されていません' });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(`${ACC.boardUrl}/api/sessions`, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish({ ok: false, error: `盤面が ${res.statusCode} を返しました` }); }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; if (b.length > 32e6) req.destroy(); });
      res.on('end', () => {
        try { finish({ ok: true, data: JSON.parse(b) }); }
        catch (_) { finish({ ok: false, error: '盤面の返事を読めませんでした' }); }
      });
    });
    req.on('error', () => finish({ ok: false, boardDown: true, error: 'セッション盤面が動いていません' }));
    req.setTimeout(20000, () => { req.destroy(); finish({ ok: false, error: '盤面の応答が遅すぎます' }); });
  });
}

// sessionId → 最後に開いたアカウント。cc.ps1 / switch.ps1 が追記する JSONL を読むだけ。
// ★transcript にはアカウントが一切残らない（2026-08-17 実測）ので、これが唯一の対応表。
let sessionAcc = { mtimeMs: -1, map: {} };
function readSessionAccounts() {
  const f = ACC && ACC.sessionLog;
  if (!f) return {};
  let st;
  try { st = fs.statSync(f); } catch (_) { return {}; }
  if (st.mtimeMs === sessionAcc.mtimeMs) return sessionAcc.map;   // 変わっていなければ読み直さない
  const map = {};
  // 同じ sessionId が複数回出たら最後の1行が真＝乗り換えの履歴がそのまま残る
  for (const line of tailLines(f, 4000)) {
    try {
      const o = JSON.parse(line);
      if (o && o.sessionId && o.account) map[o.sessionId] = { account: o.account, email: o.email || null, at: o.at || null };
    } catch (_) {}
  }
  sessionAcc = { mtimeMs: st.mtimeMs, map };
  return map;
}

// 直近に窓へ渡した一覧。open のときに sessionId と cwd をここから引き直すために持つ
let lastSessions = [];

// 一覧は「選ぶのに要るもの」だけに絞って返す。board の指標行やファイルチップは持ち込まない。
async function sessionsPayload() {
  const r = await fetchBoardSessions();
  if (!r.ok) return { ok: false, boardDown: !!r.boardDown, error: r.error, boardToolId: (ACC && ACC.boardToolId) || null, list: [] };

  const accMap = readSessionAccounts();
  const list = (r.data.sessions || []).map(s => {
    const a = accMap[s.sessionId] || null;
    return {
      sessionId: s.sessionId,
      title: s.title || s.displayName || s.sessionId.slice(0, 8),
      project: s.projectName || '',
      cwd: s.launchCwd || '',
      lastTs: s.lastTs || null,
      mtimeMs: s.mtimeMs || null,
      snippet: s.snippet || '',
      files: Array.isArray(s.files) ? s.files : [],
      pinned: !!s.pinned,
      // 開けないものは押させない（board と同じ判定）
      openable: !s.missing && !!s.launchCwd && s.cwdExists !== false,
      // 分からないものは null のまま。推測しない
      account: a ? a.account : null,
      accountAt: a ? a.at : null,
    };
  });
  // ★盤面は並べ替えずに返す（あちらはフロントで並べている）。
  //   窓は「新しい順」を前提に日付見出しを差し込むので、ここで揃えておく。
  //   基準は lastTs。mtime は ai-title の追記でも動くので会話の新しさとズレる。
  list.sort((a, b) => new Date(b.lastTs || 0) - new Date(a.lastTs || 0));

  lastSessions = list;
  return { ok: true, list, hasAccountRecords: list.some(x => x.account) };
}

// 開いてよいアカウントの許可リスト。外部の名簿ファイルが正で、
// 増減はあちらだけ直せば済む。名簿が読めない時だけ registry.json の keys に落ちる。
function allowedKeys() {
  const r = readRosterFile();
  if (r) return r.enabled;                 // 休止中(enabled:false)は開かない
  return Array.isArray(ACC && ACC.keys) ? ACC.keys : [];   // 名簿が読めない時の予備
}

function openAccount(key, resumeId) {
  if (!ACC || !ACC.ccPs1) return { ok: false, error: 'アカウント切り替えが設定されていません' };
  // 許可リストで照合する。正規表現だけに頼らない
  if (!allowedKeys().includes(key)) return { ok: false, error: '知らないアカウントです' };

  const args = ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ACC.ccPs1, '-Account', key];
  let title = `claude-${key}`;

  if (resumeId) {
    // ★ここは呼び出し側(sessionId と cwd)を信用しない。
    //   sessionId は「盤面が実在すると言った一覧」に在るものだけ通し、
    //   cwd はクライアントから受け取らず**ハブが一覧から引き直す**（詐称させない）。
    const hit = (lastSessions || []).find(s => s.sessionId === resumeId);
    if (!hit) return { ok: false, error: '知らないセッションです（一覧を読み直してください）' };
    if (!hit.openable) return { ok: false, error: 'このセッションは開けません（作業フォルダが見つかりません）' };
    args.push('-Resume', resumeId, '-WorkDir', hit.cwd);
    title = `claude-${key}-${hit.title}`.slice(0, 60);
  } else {
    args.push('-WorkDir', ACC.workDir || ROOT);
  }

  try {
    launchTerminal(title, 'powershell.exe', args);
    log(`account open: ${key}${resumeId ? ' resume ' + resumeId : ''}`);
    return { ok: true, key, resume: resumeId || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;                     // curl 等（Origin なし）は許可
  return o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(req, res, urlPath) {
  let rel = (urlPath === '/' ? '/index.html' : urlPath).split('?')[0];
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- SSE ----
const sseClients = new Set();
let lastPayloadJson = '';

const SELF_TASK = 'CbC-Hub';

function selfInfo() {
  const t = taskByName(SELF_TASK);
  if (!t || t.state === 'Missing') return { registered: false, on: false };
  return { registered: true, on: t.state !== 'Disabled', state: t.state };
}

function currentPayload() {
  const tools = computeAll();
  return { ts: Date.now(), probeAlive, snapshotTs: snapshot.ts, overall: overall(tools), tools, self: selfInfo(), accounts: accountsPayload() };
}

function broadcast(force) {
  const payload = currentPayload();
  const json = JSON.stringify(payload);
  if (!force && json === lastPayloadJson) return;
  lastPayloadJson = json;
  const frame = `data: ${json}\n\n`;
  for (const res of sseClients) { try { res.write(frame); } catch (_) {} }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = u.pathname;

    if (p === '/api/tools' && req.method === 'GET') return sendJson(res, 200, currentPayload());

    // セッション一覧（session-board から借りる。時間がかかるので SSE には載せない）
    if (p === '/api/sessions' && req.method === 'GET') return sendJson(res, 200, await sessionsPayload());

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(currentPayload())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      refreshAccounts(false);   // 窓が開いた。ここで初めて使用量を取りに行く
      return;
    }

    if (p === '/api/log' && req.method === 'GET') {
      const tool = toolById(u.searchParams.get('tool') || '');
      if (!tool || !tool.log) return sendJson(res, 404, { error: 'ログがありません' });
      const n = Math.min(parseInt(u.searchParams.get('n') || '150', 10) || 150, 500);
      return sendJson(res, 200, { id: tool.id, file: tool.log, lines: tailLines(tool.log, n) });
    }

    if (req.method === 'POST') {
      if (!sameOrigin(req)) { res.writeHead(403); return res.end('forbidden'); }
      const body = await readBody(req);

      // ツール → ハブ の状態報告（状態バス）
      if (p.startsWith('/api/state/')) {
        const id = decodeURIComponent(p.slice('/api/state/'.length));
        if (!toolById(id)) return sendJson(res, 404, { error: 'unknown tool' });
        pushedState[id] = { at: Date.now(), ...body };
        broadcast();
        // 停止を頼んであるなら、この返事で伝える
        if (quitRequests.has(id)) return sendJson(res, 200, { ok: true, quit: true });
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/tool/start')   return sendJson(res, 200, await startTool(body.id));
      if (p === '/api/tool/stop')    return sendJson(res, 200, await stopTool(body.id));
      if (p === '/api/tool/restart') { await stopTool(body.id); await new Promise(r => setTimeout(r, 800)); return sendJson(res, 200, await startTool(body.id)); }
      if (p === '/api/tool/autostart') return sendJson(res, 200, await setAutostart(body.id, !!body.on));
      if (p === '/api/tool/open') {
        const t = toolById(body.id);
        if (!t || !t.open) return sendJson(res, 404, { error: '開ける URL がありません' });
        return sendJson(res, 200, openWindow(t.open, 1200, 900));
      }
      if (p === '/api/tool/folder') {
        const t = toolById(body.id);
        if (!t || !t.dir) return sendJson(res, 404, { error: 'フォルダがありません' });
        try { launchDetached('explorer.exe', [t.dir]); } catch (_) {}
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/tool/config') {
        const t = toolById(body.id);
        if (!t || !t.configurable) return sendJson(res, 404, { error: '変えられる設定がありません' });
        const patch = {};
        for (const k of Object.keys(t.configurable)) {
          if (body.patch && k in body.patch) patch[k] = body.patch[k];
        }
        if (!Object.keys(patch).length) return sendJson(res, 200, { ok: false, error: '変更がありません' });
        try {
          writeToolConfig(t, patch);
          log(`config ${t.id}: ${JSON.stringify(patch)}`);
          return sendJson(res, 200, { ok: true, config: readToolConfig(t) });
        } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
      }
      if (p === '/api/tool/fix') {
        const t = toolById(body.id);
        if (!t || !t.fix) return sendJson(res, 404, { error: '直し方が定義されていません' });
        const args = (t.fix.args || []).slice();
        if (body.key) args.push(String(body.key));
        try {
          launchVisible(t.fix.exe, args);
          log(`fix ${t.id}${body.key ? ' ' + body.key : ''}`);
          return sendJson(res, 200, { ok: true });
        } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
      }
      if (p === '/api/accounts/refresh') {
        await refreshAccounts(true);
        return sendJson(res, 200, accounts.ok ? { ok: true } : { ok: false, error: accounts.error });
      }
      if (p === '/api/accounts/open') {
        return sendJson(res, 200, openAccount(String(body.key || ''), body.resume ? String(body.resume) : null));
      }

      if (p === '/api/self/autostart') {
        const info = selfInfo();
        if (!info.registered) {
          return sendJson(res, 200, { ok: false, error: 'CbC-Hub タスクが未登録です（tray\\install-autostart.ps1 を実行してください）' });
        }
        const cmd = body.on ? `Enable-ScheduledTask -TaskName '${SELF_TASK}'` : `Disable-ScheduledTask -TaskName '${SELF_TASK}'`;
        const r = await runPs(cmd);
        return sendJson(res, 200, r.ok ? { ok: true } : { ok: false, error: (r.err || '').trim() || '切り替えられませんでした' });
      }
      if (p === '/api/folder') {
        try { launchDetached('explorer.exe', [LOG_DIR]); } catch (_) {}
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/window') return sendJson(res, 200, openWindow(`http://${HOST}:${PORT}/`, 1040, 820));
      if (p === '/api/shutdown') {
        const results = await shutdownAll();
        try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STOP_FLAG, new Date().toISOString(), 'utf8'); } catch (_) {}
        sendJson(res, 200, { ok: true, results });
        log('shutdown 要求。ツールを止めて終了する');
        setTimeout(() => { try { if (probeChild) probeChild.kill(); } catch (_) {} process.exit(0); }, 400);
        return;
      }
      return sendJson(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

// =============================================================
//  起動
// =============================================================
if (require.main === module) {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // ポートが埋まっている。ただし「CbC が既に居る」のか
      // 「別のアプリが偶然そこを使っている」のかは、確かめないと分からない。
      // 確かめずに窓を開くと、まったく関係ないアプリの画面を出してしまう。
      const req = http.get({ host: HOST, port: PORT, path: '/api/status', timeout: 1500 }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          let isCbC = false;
          try {
            const j = JSON.parse(body);
            isCbC = res.statusCode === 200 && j && Array.isArray(j.tools);
          } catch (_) { /* CbC ではない */ }
          if (isCbC) {
            log('すでに起動しています。窓だけ開きます。');
            openWindow(`http://${HOST}:${PORT}/`, 1040, 820);
          } else {
            console.error('');
            console.error(`  ポート ${PORT} を、CbC ではない別のものが使っています。`);
            console.error('  そのアプリを終了するか、環境変数 CBC_PORT に空いている番号を入れてください。');
            console.error('    例) set CBC_PORT=47831');
            console.error('');
            log(`ポート ${PORT} が CbC 以外に使われているため起動できません。`);
          }
          process.exit(0);
        });
      });
      req.on('error', () => {
        console.error('');
        console.error(`  ポート ${PORT} が使われていますが、応答がありません。`);
        console.error('  環境変数 CBC_PORT に空いている番号を入れてお試しください。');
        console.error('');
        process.exit(1);
      });
      req.on('timeout', () => { req.destroy(); });
    } else { throw e; }
  });

  server.listen(PORT, HOST, async () => {
    try { fs.unlinkSync(STOP_FLAG); } catch (_) {}   // 立ち上がった＝止める意思は解除
    log(`CbC hub: http://${HOST}:${PORT}/`);
    startProbe();
    await refreshPorts();

    setInterval(async () => { await refreshPorts(); broadcast(); }, 1500);
    setInterval(() => broadcast(true), 30000);   // SSE のキープアライブ兼ねた定期送信

    // ★使用量は「窓を見ている間だけ」取る。
    //   /api/oauth/usage は叩きすぎると 429 で断られる（実際に踏んだ）。
    //   このハブはトレイに常駐しっぱなしなので、誰も見ていない間も 2 分ごとに
    //   叩くと、盤面・見張りと合わさって上限に当たる。窓が開いた時に取れば足りる。
    setInterval(() => { if (sseClients.size > 0) refreshAccounts(false); }, 30000);

    // 自動起動が ON のツールを上げる（autostart.type === 'hub' のもの）
    setTimeout(async () => {
      for (const t of registry.tools || []) {
        const a = autostartInfo(t);
        if (t.implemented && a.source === 'hub' && a.on) {
          const cur = computeTool(t);
          if (cur.state === 'stopped') { log(`autostart: ${t.id}`); await startTool(t.id); }
        }
      }
    }, 4000);

    if (!process.env.CBC_NO_WINDOW) openWindow(`http://${HOST}:${PORT}/`, 1040, 820);
  });
}

module.exports = { computeAll, anchorStatus, findProcs, tailLines, overall };
