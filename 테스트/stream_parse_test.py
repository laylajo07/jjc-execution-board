# -*- coding: utf-8 -*-
import sys, os, json, datetime, unittest, threading, socketserver, http.client
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '러너', 'py'))
from server import collect_text, collect_delta, dept_config_to_prompt, sanitize_dept_config, stamp_updated
import server as server_mod

class TestCollectText(unittest.TestCase):
    def test_assistant_텍스트만_이어붙인다(self):
        lines = [
            '{"type":"system","subtype":"init"}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"안녕"}]}}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"하세요"}]}}',
            '{"type":"result","subtype":"success"}',
        ]
        self.assertEqual(collect_text(lines), '안녕하세요')

    def test_깨진_라인은_건너뛴다(self):
        lines = ['{쓰레기', '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}']
        self.assertEqual(collect_text(lines), 'ok')

    def test_빈입력은_빈문자열(self):
        self.assertEqual(collect_text([]), '')


class TestCollectDelta(unittest.TestCase):
    """`claude -p --include-partial-messages` 가 내는 stream_event/content_block_delta 조각 추출.
    실제 `claude -p --output-format stream-json --verbose --include-partial-messages` 출력을
    직접 캡처해 확인한 형태를 그대로 픽스처로 사용한다."""

    def test_content_block_delta의_text만_추출한다(self):
        lines = [
            '{"type":"system","subtype":"init"}',
            '{"type":"stream_event","event":{"type":"message_start"}}',
            '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
            '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안"}}}',
            '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"녕"}}}',
            '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"안녕"}]}}',
        ]
        self.assertEqual(collect_delta(lines), '안녕')

    def test_thinking_delta는_무시한다(self):
        # 실제 API는 확장 사고(extended thinking) 시 thinking_delta 를 먼저 방출한다.
        # 텍스트 필드가 없으므로(text 대신 thinking 필드) 그대로 두면 자동으로 걸러진다 —
        # 이게 걸러지지 않으면 SSE에 사용자 화면 텍스트가 아닌 내부 사고 과정이 새어나간다.
        lines = ['{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"생각 중..."}}}']
        self.assertEqual(collect_delta(lines), '')

    def test_delta_없는_stream_event는_무시한다(self):
        lines = [
            '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
            '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
            '{"type":"stream_event","event":{"type":"message_stop"}}',
        ]
        self.assertEqual(collect_delta(lines), '')

    def test_stream_event가_아닌_라인은_무시한다(self):
        lines = ['{"type":"assistant","message":{"content":[{"type":"text","text":"본문"}]}}']
        self.assertEqual(collect_delta(lines), '')

    def test_깨진_라인은_건너뛴다(self):
        lines = ['{쓰레기', '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}}']
        self.assertEqual(collect_delta(lines), 'ok')

    def test_빈입력은_빈문자열(self):
        self.assertEqual(collect_delta([]), '')


class TestDeptConfigToPrompt(unittest.TestCase):
    """Task 5: 러너(py)가 JS(board-custom.js `deptConfigToPrompt`)와 같은 규칙으로
    deptConfig → 프롬프트 블록을 만드는지, 공유 fixture로 고정한다.
    fixture(`테스트/fixtures/dept-config-prompt-cases.json`)의 `expected` 는
    JS 구현을 실제로 실행해 뽑은 값이다(py가 손으로 지어낸 게 아니라 JS를 기준으로 맞춘 것)."""

    @classmethod
    def setUpClass(cls):
        fixture_path = os.path.join(os.path.dirname(__file__), 'fixtures', 'dept-config-prompt-cases.json')
        with open(fixture_path, encoding='utf-8') as f:
            cls.cases = json.load(f)

    def test_fixture_전체_일치(self):
        self.assertTrue(self.cases, 'fixture가 비어있으면 안 된다')
        for case in self.cases:
            with self.subTest(name=case['name']):
                self.assertEqual(dept_config_to_prompt(case['config']), case['expected'])

    def test_U2028_U2029_줄문단_구분자는_공백_접기_규칙에_의해_부수적으로_공백_하나로_눌린다(self):
        # board-custom.test.js의 동명 테스트와 같은 회귀를 py 쪽에도 고정한다 — 전용 제어문자
        # 정규식(_DEPT_CONTROL_CHARS_RE)이 아니라 그 뒤의 \s+ 공백 접기(_DEPT_WHITESPACE_RE)에서
        # 나오는 부수적 보호다(Python도 유니코드 모드 \s가 U+2028/U+2029를 포함). 이 정규식이
        # 나중에 [ \t]+ 처럼 좁혀지면 이 구멍이 소리 없이 다시 열리므로 못박아 둔다.
        result = sanitize_dept_config({'customDepts': ['a b c']})
        self.assertEqual(result['customDepts'], ['a b c'])


class TestStampUpdated(unittest.TestCase):
    """Task 3: 러너(py)가 자동 모드 결과 dict에 생성 시각 updated_at을 순수하게 주입하는지."""

    def test_dict_입력이면_updated_at이_ISO로_파싱_가능하다(self):
        result = stamp_updated({'a': 1})
        self.assertIn('updated_at', result)
        datetime.datetime.fromisoformat(result['updated_at'])  # 파싱 실패 시 예외로 실패

    def test_when을_고정하면_그_값이_그대로_나온다(self):
        when = datetime.datetime(2026, 7, 21, 14, 30, 5, tzinfo=datetime.timezone(datetime.timedelta(hours=9)))
        result = stamp_updated({'a': 1}, when=when)
        self.assertEqual(result['updated_at'], '2026-07-21T14:30:05+09:00')

    def test_원본_dict는_변형되지_않는다(self):
        original = {'a': 1}
        stamp_updated(original)
        self.assertNotIn('updated_at', original)
        self.assertEqual(original, {'a': 1})

    def test_dict가_아니면_그대로_반환한다(self):
        self.assertIsNone(stamp_updated(None))
        self.assertEqual(stamp_updated([]), [])
        self.assertEqual(stamp_updated('x'), 'x')


class TestAnalyzeErrorHandling(unittest.TestCase):
    """자체감사 발견: do_POST가 SSE 응답(send_response)을 시작하기 전 단계(AGENT_MD 읽기·
    JSON 파싱)에서 예외가 나면, try/except 없이는 응답을 하나도 못 보낸 채 소켓만 끊겨
    브라우저 쪽엔 원인불명 네트워크 에러("Failed to fetch")만 보인다(server.ts는 이미
    try/except로 감싸 500 JSON을 주는데 이쪽만 기능 동등성이 깨져 있었다). 실제 HTTP
    서버를 임시 포트로 띄워 재현·검증한다(단순 함수 단위 테스트로는 이 경로가 안 잡힌다)."""

    def _start_server(self):
        server_mod.APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '러너', 'py'))
        server_mod.NOTES_DIR = server_mod.APP_DIR
        server_mod.RESULT_DIR = os.path.join(server_mod.APP_DIR, '결과')
        server_mod.APPROACH = 'test'
        server_mod.MODEL = None
        httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), server_mod.H)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        return httpd, t

    def test_AGENT_MD_경로가_잘못돼도_소켓만_끊기지_않고_500_JSON을_응답한다(self):
        httpd, t = self._start_server()
        server_mod.AGENT_MD = os.path.join(server_mod.APP_DIR, '__없는_AGENT_MD__.md')  # 일부러 존재하지 않는 경로
        try:
            port = httpd.server_address[1]
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            body = json.dumps({'note': '테스트 회의록'}).encode('utf-8')
            conn.request('POST', '/api/analyze', body=body, headers={'Content-Type': 'application/json'})
            resp = conn.getresponse()
            data = resp.read()
            self.assertEqual(resp.status, 500, 'AGENT_MD가 없으면 500 JSON을 응답해야 한다(연결이 그냥 끊기면 안 된다)')
            parsed = json.loads(data.decode('utf-8'))
            self.assertIn('error', parsed)
            conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_body가_JSON이_아니어도_500_JSON을_응답한다(self):
        # json.loads가 read(AGENT_MD)보다 먼저 실행되므로 AGENT_MD 자체는 이 테스트의 관심사가
        # 아니지만, "AGENT_MD 문제와 섞이지 않고 순수하게 JSON 파싱 실패만" 확인하려 실제
        # 존재하는 파일을 가리켜 둔다.
        server_mod.AGENT_MD = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'B_직접', '앱', 'AGENT.md'))
        httpd, t = self._start_server()
        try:
            port = httpd.server_address[1]
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            body = '이건 JSON이 아님'.encode('utf-8')
            conn.request('POST', '/api/analyze', body=body, headers={'Content-Type': 'application/json'})
            resp = conn.getresponse()
            data = resp.read()
            self.assertEqual(resp.status, 500)
            parsed = json.loads(data.decode('utf-8'))
            self.assertIn('error', parsed)
            conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == '__main__':
    unittest.main()
