# -*- coding: utf-8 -*-
"""前面のウィンドウが「文字を打つ場所」かどうかを見る。

これが無いと、チャット欄で v や b を打っただけでホットキーが誤爆する。
元の voice_overlay.py にはこの判定が無く、実用上いちばん刺さる欠陥だった。

Windows には「今キーボード入力がテキスト欄に入っているか」を素直に
教えてくれる API が無いので、前面プロセス名で判断する。完璧ではないが、
誤爆の実害はほぼこれで消える。ゲームや VR が前面のときは必ず通す。
"""
import ctypes
import ctypes.wintypes as wt
import os
import time

_u32 = ctypes.windll.user32
_k32 = ctypes.windll.kernel32

# 文字を打つ場所（ここが前面のときはホットキーを無視する）
DEFAULT_TEXT_APPS = (
    'discord',        # 誤爆の主犯
    'chrome', 'msedge', 'firefox', 'brave', 'opera',
    'code', 'notepad', 'notepad++', 'sublime_text', 'idea64', 'pycharm64',
    'windowsterminal', 'powershell', 'cmd', 'wt',
    'slack', 'teams', 'thunderbird', 'obsidian', 'typora',
    'explorer',       # 名前の変更中に拾わないため
)

_cache = {'at': 0.0, 'name': ''}
_CACHE_SEC = 0.20   # 連打しても軽いように、ごく短く覚える


def _process_name(pid):
    if not pid:
        return ''
    # PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = _k32.OpenProcess(0x1000, False, pid)
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(260)
        size = wt.DWORD(260)
        if _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return ''
    finally:
        _k32.CloseHandle(h)


def foreground_process():
    """前面ウィンドウのプロセス名（小文字・拡張子なし）。取れなければ ''。"""
    now = time.time()
    if now - _cache['at'] < _CACHE_SEC:
        return _cache['name']
    name = ''
    try:
        hwnd = _u32.GetForegroundWindow()
        if hwnd:
            pid = wt.DWORD()
            _u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            name = _process_name(pid.value)
            if name.lower().endswith('.exe'):
                name = name[:-4]
            name = name.lower()
    except Exception:
        name = ''
    _cache['at'] = now
    _cache['name'] = name
    return name


def typing_now(text_apps=None):
    """前面が「文字を打つ場所」なら True。ホットキーを無視すべき合図。"""
    apps = text_apps if text_apps is not None else DEFAULT_TEXT_APPS
    fg = foreground_process()
    if not fg:
        return False          # 分からないときは通す（ゲーム中に効かない方が困る）
    return any(a in fg for a in apps)
