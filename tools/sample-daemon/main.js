'use strict';
/*
 * CbC につなぐツールの見本（これ以上短くできない形）。
 *
 * やっていることは2つだけ:
 *   1. 2秒ごとに「生きています」と CbC へ知らせる
 *   2. 止められたときに後始末をする
 *
 * 自分のツールを CbC につなぐときは、このファイルの heartbeat の部分を
 * 自分のプログラムへ持っていけば済む。依存は無い（Node 標準のみ）。
 *
 * 動かしてみる:
 *   node tools/sample-daemon/main.js
 * CbC の窓に「見本（常駐）」が緑で出れば、つながっている。
 */

const http = require('http');

// CbC の待受先。既定は 47821。
// CbC 側で CBC_PORT を変えている場合は、こちらも同じ値を見る。
const HUB = { host: '127.0.0.1', port: Number(process.env.CBC_PORT) || 47821 };
const TOOL_ID = 'sample-daemon';       // registry.json の id と必ず合わせる
const INTERVAL_MS = 2000;              // 2秒ごと。8秒届かないと停止扱いになる

let ticks = 0;
let timer = null;

// ── CbC へ状態を知らせる ───────────────────────────────
// level は 'ok' / 'warn' / 'error' の3つ。
// detail は窓にそのまま出るので、人が読んで分かる一言にする。
function report(level, detail) {
  const body = JSON.stringify({ level, detail, pid: process.pid });
  const req = http.request({
    host: HUB.host, port: HUB.port,
    path: '/api/state/' + TOOL_ID,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 1500,
  }, res => res.resume());
  // CbC が動いていないときは黙って諦める。
  // ここで落ちると、ハブを止めただけでツールまで巻き添えになる。
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

function tick() {
  ticks++;
  const min = Math.floor(ticks * INTERVAL_MS / 60000);
  report('ok', min > 0 ? ('動いています（' + min + '分）') : '動いています');
}

// ── 後始末 ─────────────────────────────────────────
// 環境を変えるツール（ミュートする・デバイスを切り替える等）は、
// ここで必ず元に戻す。戻す必要があることは registry.json の restore にも書く。
function shutdown(why) {
  if (timer) clearInterval(timer);
  report('warn', '終了しました（' + why + '）');
  // 送信を投げてから、少しだけ待って落ちる
  setTimeout(() => process.exit(0), 200);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => shutdown(sig));
}

console.log('見本ツールを開始しました。CbC の窓に緑で出れば、つながっています。');
console.log('止めるには Ctrl+C。');
tick();
timer = setInterval(tick, INTERVAL_MS);
