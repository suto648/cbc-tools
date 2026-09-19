'use strict';
/*
 * registry.json の絶対パスを、どのPCでも通じる目印に置き換える。
 *
 *   <CbCの置き場>\tools  → {TOOLS}
 *   <CbCの置き場>\logs   → {LOGS}
 *   <CbCの置き場>        → {CBC}
 *   <利用者のフォルダ>    → {HOME}
 *
 * 使い方:
 *   node tools/portable-registry.js            … 確認だけ（書き換えない）
 *   node tools/portable-registry.js --write    … 実際に書き換える
 *
 * 文字列に対して素朴に置換するのではなく、JSON を読み込んで
 * 値ひとつずつを見る。JSON のエスケープ（\\）を自分で相手にしないため。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REG = path.join(__dirname, '..', 'hub', 'registry.json');
const CBC = path.resolve(path.join(__dirname, '..'));
const HOME = os.homedir();
const WRITE = process.argv.includes('--write');

// 長いものから先に当てる（{CBC} が {TOOLS} を食べてしまわないように）
const RULES = [
  [path.join(CBC, 'tools'), '{TOOLS}'],
  [path.join(CBC, 'logs'), '{LOGS}'],
  [CBC, '{CBC}'],
  [HOME, '{HOME}'],
];

let hits = 0;
const changed = [];

function convert(value, keyPath) {
  if (typeof value === 'string') {
    let s = value;
    for (const [from, to] of RULES) {
      // Windows のパスは大文字小文字を区別しないので、その前提で探す
      const i = s.toLowerCase().indexOf(from.toLowerCase());
      if (i >= 0) {
        s = s.slice(0, i) + to + s.slice(i + from.length);
      }
    }
    if (s !== value) { hits++; changed.push(keyPath + ': ' + value + '  ->  ' + s); }
    return s;
  }
  if (Array.isArray(value)) return value.map((v, i) => convert(v, keyPath + '[' + i + ']'));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = convert(v, keyPath ? keyPath + '.' + k : k);
    return out;
  }
  return value;
}

const before = JSON.parse(fs.readFileSync(REG, 'utf-8'));
const after = convert(before, '');

console.log('CbC の置き場: ' + CBC);
console.log('利用者のフォルダ: ' + HOME);
console.log('');
console.log('置き換わる箇所: ' + hits + ' 件');
for (const c of changed) console.log('  ' + c);

// まだ残っている絶対パスを知らせる（他人のPCでは動かない場所）
const leftovers = [];
(function scan(v, kp) {
  if (typeof v === 'string') {
    if (/^[A-Za-z]:\\/.test(v)) leftovers.push(kp + ': ' + v);
  } else if (Array.isArray(v)) v.forEach((x, i) => scan(x, kp + '[' + i + ']'));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, kp ? kp + '.' + k : k);
})(after, '');

console.log('');
if (leftovers.length) {
  console.log('★まだ絶対パスのまま残っているもの: ' + leftovers.length + ' 件');
  console.log('（CbC の外にある、この人だけのツール。出荷する登録簿からは外すこと）');
  for (const l of leftovers) console.log('  ' + l);
} else {
  console.log('絶対パスは残っていません。');
}

if (WRITE) {
  fs.writeFileSync(REG, JSON.stringify(after, null, 2) + '\n', 'utf-8');
  console.log('\nregistry.json を書き換えました。');
} else {
  console.log('\n（確認しただけです。書き換えるには --write を付けてください）');
}
