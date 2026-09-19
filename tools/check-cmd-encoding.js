'use strict';
/*
 * .cmd / .bat が cmd.exe に安全に読める形かを調べる。
 *
 * 背景（2026-09-19 に対照実験で確認し、CbC Tools の既存コメントでも裏が取れた）:
 *  - cmd.exe は .bat をシステムのコードページ（日本語Windowsなら CP932）で読む。
 *  - したがって **UTF-8 の日本語を書くと壊れる**。関係のない行で
 *    「'…' は、内部コマンドまたは外部コマンドとして認識されていません」が出る。
 *  - CP932 で書けば表示は正しくなるが、**2バイト目が cmd の特殊文字になる漢字**がある。
 *    有名な例: 「表」= 0x95 0x5C（0x5C は "\"）。ほかに 0x7C(|) 0x26(&) など。
 *    これらが入ると、その行が途中で切れたり別のコマンドとして解釈されたりする。
 *
 * つまり安全なのは次のどちらか:
 *   (a) ASCII のみ（日本語は PowerShell 側か、起動後の Node 側で出す）
 *   (b) CP932 で、かつ危険な2バイト目を持つ文字を使わない
 *
 * 使い方: node tools/check-cmd-encoding.js <ファイル...>
 * 問題があれば終了コード 1。
 */

const fs = require('fs');

// cmd.exe が特別扱いする文字
const DANGER = {
  0x5C: '\\', 0x7C: '|', 0x26: '&', 0x3C: '<', 0x3E: '>',
  0x5E: '^', 0x28: '(', 0x29: ')', 0x22: '"', 0x25: '%',
};

function isUtf8(buf) {
  try {
    // Node は不正なバイトを U+FFFD に置き換えるので、往復して一致するかで見る
    const s = buf.toString('utf8');
    return Buffer.compare(Buffer.from(s, 'utf8'), buf) === 0;
  } catch (_) { return false; }
}

function checkFile(file) {
  const buf = fs.readFileSync(file);
  const problems = [];

  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    problems.push('BOM がある。cmd.exe は BOM を最初のコマンドの一部として読む');
  }

  const nonAscii = buf.filter(b => b > 127).length;
  if (nonAscii === 0) {
    return { file, problems, note: 'ASCII のみ（いちばん安全）' };
  }

  if (isUtf8(buf)) {
    problems.push('UTF-8 で保存されている。CP932 にするか、日本語をやめること');
    return { file, problems, note: 'UTF-8・非ASCII ' + nonAscii + ' バイト' };
  }

  // CP932 とみなして、危険な2バイト目を持つ文字を探す
  const hits = [];
  for (let i = 0; i < buf.length; ) {
    const c = buf[i];
    const isLead = (c >= 0x81 && c <= 0x9F) || (c >= 0xE0 && c <= 0xFC);
    if (isLead && i + 1 < buf.length) {
      const t = buf[i + 1];
      if (DANGER[t] !== undefined) {
        hits.push({ offset: i, trail: t, sym: DANGER[t] });
      }
      i += 2;
    } else i += 1;
  }
  if (hits.length) {
    for (const h of hits) {
      problems.push('位置 ' + h.offset + ': 2バイト目が 0x' +
        h.trail.toString(16) + ' ("' + h.sym + '") になる文字がある。別の言い回しにすること');
    }
  }
  return { file, problems, note: 'CP932・非ASCII ' + nonAscii + ' バイト' };
}

const files = process.argv.slice(2);
if (!files.length) { console.error('ファイルを指定してください'); process.exit(2); }

let bad = 0;
for (const f of files) {
  const r = checkFile(f);
  const mark = r.problems.length ? '★' : '  ';
  console.log(mark + ' ' + r.file + '  (' + r.note + ')');
  for (const p of r.problems) console.log('     - ' + p);
  if (r.problems.length) bad++;
}
console.log('');
console.log(bad === 0 ? 'すべて問題なし' : '★ ' + bad + ' 件に問題あり');
process.exitCode = bad === 0 ? 0 : 1;
