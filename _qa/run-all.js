// CbC Tools の自己点検。
//
// 使い方:  node _qa/run-all.js
// 終了コード 0 = 全部通った。1 以上 = 落ちた数。
//
// ★ここで守る作法（過去に実際に踏んだ失敗から）:
//   1. `node a.js | tail -1 && node b.js` のように繋がない。
//      tail の終了コードが返るので、落ちたテストが「通った」ことになる。
//      実際にそれで「全部通った」と誤報告した。だから1本にまとめて自分で数える。
//   2. 本番のポートを絶対に掴まない。使用中のポートを先に調べてから空きを使う。
//      本番: CbC=47821 / セッション盤面=4788 / md-editor=3456
//   3. テストが落ちたら、実装ではなくテストの期待値を先に疑う。

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0, skip = 0;
const failures = [];

function ok(name) { pass++; console.log('OK   ' + name); }
function ng(name, why) { fail++; failures.push(name + (why ? '  -> ' + why : '')); console.log('NG   ' + name + (why ? '  -> ' + why : '')); }
function sk(name, why) { skip++; console.log('--   ' + name + (why ? '  (' + why + ')' : '')); }
function check(name, cond, why) { cond ? ok(name) : ng(name, why); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 空いているポートを探す（本番を掴まないため）----
function listeningPorts() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue).LocalPort"',
      { encoding: 'utf8', timeout: 20000 }
    );
    return new Set(out.split(/\r?\n/).map(s => Number(s.trim())).filter(Boolean));
  } catch (_) {
    return null;   // 権限やコマンドが無い環境。呼び出し側で判断する。
  }
}

function freePortsFrom(start, count, used) {
  const got = [];
  for (let p = start; p < start + 400 && got.length < count; p++) {
    if (!used.has(p)) got.push(p);
  }
  return got;
}

function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: -1, body: '', error: String(e.code || e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: '', error: 'timeout' }); });
  });
}

// 立ち上がるまで待つ。上がった印は標準出力の `[ready]`。
function startHub(env, cwd) {
  const nodeExe = process.execPath;
  const child = spawn(nodeExe, [path.join(cwd, 'hub', 'hub.js')], {
    cwd,
    env: Object.assign({}, process.env, { CBC_NO_WINDOW: '1' }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', c => out += c.toString('utf8'));
  child.stderr.on('data', c => err += c.toString('utf8'));
  return {
    child,
    get out() { return out; },
    get err() { return err; },
    async waitReady(ms) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const m = out.match(/\[ready\] (\S+)/);
        if (m) return m[1];
        if (child.exitCode !== null) return null;
        await sleep(250);
      }
      return null;
    },
    stop() { try { child.kill(); } catch (_) {} },
  };
}

(async () => {
  console.log('=== CbC Tools 自己点検 ===\n');

  // ---------------------------------------------------------------
  // 1. 起動スクリプトが cmd.exe に安全に読めるか
  // ---------------------------------------------------------------
  try {
    const checker = path.join(ROOT, 'tools', 'check-cmd-encoding.js');
    const targets = fs.readdirSync(ROOT).filter(f => /\.(bat|cmd|vbs)$/i.test(f)).map(f => path.join(ROOT, f));
    execSync([process.execPath, checker].concat(targets).map(s => '"' + s + '"').join(' '), { stdio: 'pipe' });
    ok('起動スクリプトに文字化けの地雷が無い (' + targets.length + '本)');
  } catch (e) {
    ng('起動スクリプトに文字化けの地雷が無い', String((e.stdout || e.message || '').toString().slice(0, 300)));
  }

  // ---------------------------------------------------------------
  // 2. build-dist.ps1 が壊れていないか（BOM・行途中の復帰文字）
  //    ★BOM が無いと PowerShell 5.1 が CP932 と誤読して落ちる。実際に踏んだ。
  //    ★バックスラッシュ+r が本物の復帰文字に化けてゲートが動かなくなった。実際に踏んだ。
  // ---------------------------------------------------------------
  const ps1 = path.join(ROOT, 'build-dist.ps1');
  if (fs.existsSync(ps1)) {
    const buf = fs.readFileSync(ps1);
    check('build-dist.ps1 に BOM が付いている', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
    const lines = buf.toString('utf8').split(/\r?\n/);
    const stray = lines.map((l, i) => (l.includes('\r') ? i + 1 : 0)).filter(Boolean);
    check('build-dist.ps1 の行途中に復帰文字が無い', stray.length === 0, '行 ' + stray.join(','));
    // ゲートが本当に registry.json を見ているか（文字列として正しい形か）
    const src = buf.toString('utf8');
    check('個人データのゲートが registry.json を正しく指している',
      src.includes("'hub" + String.fromCharCode(92) + "registry.json'"));
  } else {
    sk('build-dist.ps1 の検査', 'ファイルが無い');
  }

  // ---------------------------------------------------------------
  // 2-b. ポートを決め打ちしている場所が残っていないか
  //   ★ハブは埋まっていたら隣のポートへ移る。外側（トレイ・停止役）が
  //     47821 を決め打ちしていると、移った瞬間にハブを見失う。
  //     実際にトレイが決め打ちしていて、別PC検証で気づいた。
  // ---------------------------------------------------------------
  {
    const offenders = [];
    for (const rel of ['tray/tray.ps1', 'tray/stop-all.ps1']) {
      const f = path.join(ROOT, rel);
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      src.split(/\r?\n/).forEach((line, i) => {
        // コメント行は除く。URL や接続先として 47821 を直接書いている行だけを見る。
        const t = line.trim();
        if (t.startsWith('#')) return;
        if (/47821/.test(line) && /(127\.0\.0\.1|BeginConnect|Uri)/.test(line)) {
          offenders.push(rel + ':' + (i + 1));
        }
      });
    }
    check('トレイ側がポートを決め打ちしていない', offenders.length === 0, offenders.join(', '));
  }

  // ---------------------------------------------------------------
  // 2-c. 同梱の node.exe を使っているか
  //   ★受け取った人のPCに Node.js は入っていない前提。
  //     トレイが 'node' で起動しようとして、Node 未導入のPCで失敗していた。
  // ---------------------------------------------------------------
  {
    const f = path.join(ROOT, 'tray', 'tray.ps1');
    if (fs.existsSync(f)) {
      const src = fs.readFileSync(f, 'utf8');
      check('トレイが同梱の node.exe を指している', /node\\node\.exe/.test(src.replace(/\\\\/g, '\\')));
      check("トレイが素の 'node' でハブを起動していない",
        !/Start-Process\s+-FilePath\s+'node'/.test(src));
    } else {
      sk('トレイの node 参照の検査', 'tray.ps1 が無い');
    }
  }

  // ---------------------------------------------------------------
  // 3. 見本の登録簿が読める JSON か
  // ---------------------------------------------------------------
  try {
    const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'hub', 'registry.sample.json'), 'utf8'));
    check('registry.sample.json が読める', sample && Array.isArray(sample.tools));
  } catch (e) {
    ng('registry.sample.json が読める', String(e.message));
  }

  // ---------------------------------------------------------------
  // 4. 実際に立ち上げて、身元と目印を確かめる
  // ---------------------------------------------------------------
  const used = listeningPorts();
  if (!used) {
    sk('起動して確かめる一連', 'listen 中のポートを調べられなかった（本番を掴む危険があるので実行しない）');
  } else {
    // 本番は絶対に避ける
    [47821, 4788, 3456].forEach(p => used.add(p));
    const ports = freePortsFrom(47900, 4, used);

    // 試験用の作業場を作る（リポジトリの中に registry.json を作らせない）
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-qa-'));
    fs.mkdirSync(path.join(work, 'hub'), { recursive: true });
    for (const f of ['hub.js', 'registry.sample.json']) {
      fs.copyFileSync(path.join(ROOT, 'hub', f), path.join(work, 'hub', f));
    }
    fs.cpSync(path.join(ROOT, 'hub', 'public'), path.join(work, 'hub', 'public'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'adapters'), path.join(work, 'adapters'), { recursive: true });

    // --- 4-a. 指定したポートで上がるか ---
    const hub = startHub({ CBC_PORT: String(ports[0]) }, work);
    const url = await hub.waitReady(25000);
    check('[ready] を出して起動する', Boolean(url), (hub.out + hub.err).slice(0, 300));

    if (url) {
      const who = await get(ports[0], '/api/whoami');
      let j = null; try { j = JSON.parse(who.body); } catch (_) {}
      check('/api/whoami が 200 を返す', who.status === 200, String(who.status) + ' ' + (who.error || ''));
      check('/api/whoami が cbc-tools と名乗る', j && j.app === 'cbc-tools', who.body.slice(0, 120));
      check('/api/whoami が api の版を返す', j && j.api === 1, who.body.slice(0, 120));

      const top = await get(ports[0], '/');
      check('窓の画面が 200 で返る', top.status === 200, String(top.status));
      check('窓の画面に外部サイトへの読み込みが無い',
        !/(src|href)\s*=\s*["']https?:/i.test(top.body),
        (top.body.match(/(src|href)\s*=\s*["']https?:[^"']*/i) || [''])[0]);

      // ★ここは最初 /api/status を見て落ちた。だが正しいのはテストではなく実装側だった。
      //   CbC が持っているのは /api/tools。/api/status は「セッション盤面」の口で、
      //   CbC はそれを外へ問い合わせるときにだけ使う。
      //   （この勘違いのおかげで本物のバグが1つ見つかった＝台帳参照）
      const st = await get(ports[0], '/api/tools');
      check('/api/tools が 200 で返る', st.status === 200, String(st.status));

      // 初回起動で見本が写されるか（人の登録簿を持ち込まないための仕組み）
      check('初回起動で registry.json が見本から作られる',
        fs.existsSync(path.join(work, 'hub', 'registry.json')));

      // 待受ポートを外へ知らせているか（トレイがこれを読む）
      const pf = path.join(work, 'logs', 'port.txt');
      const wrote = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8').trim() : '';
      check('実際の待受ポートを logs/port.txt に書いている', wrote === String(ports[0]), 'port.txt=' + wrote);
    }

    // --- 4-b. 別のアプリがポートを使っていたら、次の空きへ退避するか ---
    //     本物の CbC が居る場合は「窓だけ開いて終わる」のが正しいので、
    //     ここでは CbC ではない別物を置いて、退避する側だけを見る。
    hub.stop();
    await sleep(600);

    const squatter = http.createServer((req, res) => {
      // CbC ではないと名乗る（形は似せる。名前で判定していることの確認になる）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'something-else', tools: [] }));
    });
    await new Promise(r => squatter.listen(ports[1], '127.0.0.1', r));

    // 既定ポートを試験用の番号にした複製を使う。
    // （CBC_PORT を指定すると「人が明示した番号」扱いで退避しない設計なので、
    //   既定値そのものを差し替えないとこの経路は試せない）
    const hubSrc = fs.readFileSync(path.join(work, 'hub', 'hub.js'), 'utf8');
    const patched = hubSrc.replace(
      'Number(process.env.CBC_PORT) || 47821',
      'Number(process.env.CBC_PORT) || ' + ports[1]
    );
    check('退避の試験用に既定ポートを差し替えられた', patched !== hubSrc);
    fs.writeFileSync(path.join(work, 'hub', 'hub.js'), patched);

    const hub2 = startHub({}, work);
    const url2 = await hub2.waitReady(25000);
    check('埋まっていたら次の空きポートで上がる', Boolean(url2) && !url2.includes(':' + ports[1]),
      'url=' + url2 + ' / ' + (hub2.out + hub2.err).slice(0, 300));
    if (url2) {
      const m = url2.match(/:(\d+)/);
      const landed = m ? Number(m[1]) : 0;
      const who2 = await get(landed, '/api/whoami');
      let j2 = null; try { j2 = JSON.parse(who2.body); } catch (_) {}
      check('退避先でも身元を名乗る', j2 && j2.app === 'cbc-tools', who2.body.slice(0, 120));
      check('居座っていた別アプリを CbC と誤認していない', landed !== ports[1], 'landed=' + landed);
    }

    hub2.stop();
    await new Promise(r => squatter.close(r));
    await sleep(400);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }

  // ---------------------------------------------------------------
  // 5. 配布物ができているなら、そこに個人データが無いか
  // ---------------------------------------------------------------
  const dist = path.join(ROOT, 'dist', 'CbC Tools');
  if (fs.existsSync(dist)) {
    const bad = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (/^(registry|state|board|scan-cache|status-state)\.json$/i.test(e.name)) bad.push(full.slice(dist.length + 1));
      }
    };
    walk(dist);
    check('配布物に個人の登録簿・状態ファイルが無い', bad.length === 0, bad.join(', '));

    const nodeExe = path.join(dist, 'node', 'node.exe');
    check('配布物に node.exe が同梱されている', fs.existsSync(nodeExe));
  } else {
    sk('配布物の検査', 'dist がまだ無い（build-dist.ps1 を先に実行する）');
  }

  console.log('\n=== 結果: 通った ' + pass + ' / 落ちた ' + fail + ' / 飛ばした ' + skip + ' ===');
  if (failures.length) {
    console.log('\n落ちたもの:');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail);
})().catch(e => {
  console.error('点検そのものが例外で落ちた: ' + (e && e.stack || e));
  process.exit(99);
});
