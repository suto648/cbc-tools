# -*- coding: utf-8 -*-
"""CbC ハブとのやりとり（状態を投げる／他のツールの状態を受け取る）。

* report()  … 2秒ごとに自分の状態をハブへ。止めるとハブは「停止中」と見なす
* watch()   … 他のツールの状態を SSE で受け取る（自前でキーフックしないため）

ハブが落ちていても、ツール自身の仕事は続ける。報告できないだけ。
標準ライブラリだけで書く（このPCの Python 3.11 に requests は入っていない）。
"""
import json
import os
import threading
import time
import urllib.request
import urllib.error

# CbC の待受先。既定は 47821。
# CbC 側で CBC_PORT を変えている場合は、こちらも同じ値を見る。
HUB = 'http://127.0.0.1:%s' % (os.environ.get('CBC_PORT') or '47821')


def _post(path, obj, timeout=2.0):
    body = json.dumps(obj).encode('utf-8')
    req = urllib.request.Request(
        HUB + path, data=body, method='POST',
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    try:
        return json.loads(raw.decode('utf-8'))
    except Exception:
        return {}


class Reporter(threading.Thread):
    """自分の状態を定期的にハブへ送る。state_fn() は dict を返す。

    ハブは返事に {"quit": true} を入れてくることがある＝穏やかな停止の合図。
    受け取ったら on_quit() を呼ぶので、後始末をしてから終わること。
    いきなり kill されると後始末が走らない（ミュートしたまま死ぬ等）ので、
    この経路がツールの正しい止まり方。
    """

    def __init__(self, tool_id, state_fn, interval=2.0, log=None, on_quit=None):
        super().__init__(daemon=True)
        self.tool_id = tool_id
        self.state_fn = state_fn
        self.interval = interval
        self.log = log or (lambda m: None)
        self.on_quit = on_quit
        self.stop = threading.Event()
        self._warned = False

    def run(self):
        while not self.stop.is_set():
            try:
                payload = dict(self.state_fn() or {})
                payload.setdefault('pid', os.getpid())
                res = _post('/api/state/' + self.tool_id, payload)
                self._warned = False
                if res.get('quit') and self.on_quit:
                    self.log('ハブから停止の合図。後始末して終わります')
                    self.stop.set()
                    try:
                        self.on_quit()
                    except Exception as e:
                        self.log('後始末で例外: %r' % (e,))
                    return
            except Exception as e:
                # ハブが居ないのは普通のこと（単体起動）。一度だけ言う。
                if not self._warned:
                    self.log('hub へ報告できません: %r' % (e,))
                    self._warned = True
            self.stop.wait(self.interval)


class Watcher(threading.Thread):
    """ハブの SSE を購読して、他のツールの状態を持っておく。

    self.tools は id -> ツール状態の dict。ハブが落ちていれば空のまま。
    """

    def __init__(self, log=None):
        super().__init__(daemon=True)
        self.tools = {}
        self.connected = False
        self.log = log or (lambda m: None)
        self.stop = threading.Event()

    def get(self, tool_id):
        return self.tools.get(tool_id)

    def run(self):
        while not self.stop.is_set():
            try:
                with urllib.request.urlopen(HUB + '/api/events', timeout=10) as r:
                    self.connected = True
                    buf = ''
                    while not self.stop.is_set():
                        chunk = r.readline()
                        if not chunk:
                            break
                        line = chunk.decode('utf-8', 'replace').rstrip('\r\n')
                        if line.startswith('data: '):
                            buf = line[6:]
                        elif line == '' and buf:
                            try:
                                payload = json.loads(buf)
                                self.tools = {t['id']: t for t in payload.get('tools', [])}
                            except Exception:
                                pass
                            buf = ''
            except Exception:
                self.connected = False
            if not self.stop.is_set():
                self.stop.wait(5.0)


def make_logger(path, keep_lines=400):
    """素朴なログ。行数が増えたら末尾だけ残す。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lock = threading.Lock()
    count = {'n': 0}

    def log(msg):
        line = '%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
        try:
            with lock:
                with open(path, 'a', encoding='utf-8') as f:
                    f.write(line)
                count['n'] += 1
                if count['n'] % 200 == 0:
                    with open(path, 'r', encoding='utf-8', errors='replace') as f:
                        lines = f.readlines()
                    if len(lines) > keep_lines * 2:
                        with open(path, 'w', encoding='utf-8') as f:
                            f.writelines(lines[-keep_lines:])
        except Exception:
            pass

    return log
