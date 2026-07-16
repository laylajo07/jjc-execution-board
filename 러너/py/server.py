#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 조정치 공용 러너 (Python · 설치 0) — 웹앱 서빙 + `claude -p` 실행
# 로컬에 로그인된 Claude Code를 그대로 사용하므로 API 키가 필요 없습니다.
#
# 사용법:
#   python server.py <앱폴더> [포트]
#   예) python server.py ../../B_직접/앱
#       python server.py ../../A_웹페이지/앱 8788
#
# 사전 준비: Claude Code 설치 & 로그인  (npm i -g @anthropic-ai/claude-code, 그 후 `claude` 로 최초 로그인)

import sys, os, json, subprocess, urllib.parse, http.server, socketserver, datetime, re, threading, webbrowser

APP_DIR = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8787
NOTES_DIR = os.path.abspath(os.path.join(APP_DIR, '..', '..', '회의록'))
RESULT_DIR = os.path.join(APP_DIR, '결과')
AGENT_MD = os.path.join(APP_DIR, 'AGENT.md')
APPROACH = os.path.basename(os.path.dirname(APP_DIR))
MODEL = os.environ.get('CLAUDE_MODEL')
os.makedirs(RESULT_DIR, exist_ok=True)


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def collect_text(lines):
    """`claude -p --output-format stream-json` 의 JSON Lines에서 assistant 텍스트만 조립한다."""
    out = []
    for ln in lines:
        ln = (ln or '').strip()
        if not ln:
            continue
        try:
            ev = json.loads(ln)
        except Exception:
            continue  # 깨진 라인은 무시
        if ev.get('type') != 'assistant':
            continue
        for blk in (ev.get('message') or {}).get('content') or []:
            if blk.get('type') == 'text':
                out.append(blk.get('text') or '')
    return ''.join(out)


def extract_json(text):
    m = re.search(r'```json\s*(.*?)```', text, re.S)
    cand = m.group(1) if m else None
    if not cand:
        s, e = text.find('{'), text.rfind('}')
        if s >= 0 and e > s:
            cand = text[s:e + 1]
    if not cand:
        return None
    for c in (cand, re.sub(r',\s*([}\]])', r'\1', cand)):
        try:
            return json.loads(c)
        except Exception:
            pass
    return None


def run_claude(prompt, model=None):
    args = ['claude', '-p', '--output-format', 'stream-json', '--verbose']
    use = model or MODEL
    if use:
        args += ['--model', use]
    p = subprocess.run(args, input=prompt, capture_output=True, text=True,
                       encoding='utf-8', shell=(os.name == 'nt'), timeout=300)
    raw = collect_text(p.stdout.splitlines())
    if p.returncode != 0 and not raw.strip():
        raise RuntimeError((p.stderr or p.stdout or 'claude 실행 실패').strip())
    return raw


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=APP_DIR, **k)

    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/api/health':
            return self._send(200, {'ok': True, 'approach': APPROACH, 'appDir': APP_DIR, 'notesDir': NOTES_DIR})
        if u.path == '/api/notes':
            items = []
            if os.path.isdir(NOTES_DIR):
                for n in sorted(os.listdir(NOTES_DIR)):
                    if n.lower().endswith(('.md', '.txt')) and n.lower() != 'readme.md':
                        items.append({'name': n})
            return self._send(200, items)
        if u.path == '/api/note':
            q = urllib.parse.parse_qs(u.query)
            name = os.path.basename((q.get('name') or [''])[0])
            fp = os.path.join(NOTES_DIR, name)
            if os.path.isfile(fp):
                return self._send(200, {'name': name, 'content': read(fp)})
            return self._send(404, {'error': 'not found'})
        return super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != '/api/analyze':
            return self._send(404, {'error': 'unknown'})
        ln = int(self.headers.get('Content-Length', '0'))
        body = json.loads(self.rfile.read(ln) or b'{}')
        note = (body.get('note') or '').strip()
        model = (body.get('model') or '').strip() or None
        name = (body.get('name') or '').strip()  # 선택한 회의록 파일명(있으면 결과 파일명에 사용)
        if model and not re.match(r'^[\w.:-]+$', model):  # 셸 주입 방지: 모델명 화이트리스트
            model = None
        if not note:
            return self._send(400, {'error': 'empty note'})
        prompt = (read(AGENT_MD) +
                  "\n\n================================================================\n"
                  "# 처리할 회의록 (형식 그대로)\n"
                  "================================================================\n" + note +
                  "\n\n위 지침에 따라 \"A. 실행보드(마크다운)\"와 \"B. JSON\" 두 블록을 순서대로 출력해줘.")
        # ── SSE 스트리밍 응답 ──
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        def sse(obj):
            try:
                self.wfile.write(('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode('utf-8'))
                self.wfile.flush()
            except Exception:
                pass

        args = ['claude', '-p', '--output-format', 'stream-json', '--verbose']
        use = model or MODEL
        if use:
            args += ['--model', use]
        try:
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, shell=(os.name == 'nt'))
            proc.stdin.write(prompt.encode('utf-8'))
            proc.stdin.close()
        except Exception as e:
            return sse({'error': str(e)})

        buf, lines = '', []
        while True:
            b = proc.stdout.read1(4096)
            if not b:
                break
            buf += b.decode('utf-8', 'replace')
            while '\n' in buf:
                ln, buf = buf.split('\n', 1)
                lines.append(ln)
                piece = collect_text([ln])
                if piece:
                    sse({'t': piece})       # 생성되는 텍스트를 실시간 전달
        if buf.strip():
            lines.append(buf)
        proc.wait()
        raw = collect_text(lines)
        if proc.returncode != 0 and not raw.strip():
            err = proc.stderr.read().decode('utf-8', 'replace').strip()
            return sse({'error': err or 'claude 실행 실패'})

        data = extract_json(raw)
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        stem = re.sub(r'[^\w.\-]', '_', os.path.splitext(os.path.basename(name))[0]) if name else ''
        base = os.path.join(RESULT_DIR, (stem + '__' + ts) if stem else ts)
        try:
            with open(base + '.md', 'w', encoding='utf-8') as f:
                f.write(raw)
            if data is not None:
                with open(base + '.json', 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
        sse({'done': True, 'markdown': raw, 'json': data, 'savedTo': os.path.basename(base) + '.md'})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    print(f"[조정치 러너/py] {APPROACH}  http://localhost:{PORT}")
    print(f"  앱 폴더   : {APP_DIR}")
    print(f"  회의록 폴더: {NOTES_DIR}")
    print("  종료: Ctrl+C")
    threading.Timer(0.8, lambda: webbrowser.open(f'http://localhost:{PORT}')).start()
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), H) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n종료합니다.')
