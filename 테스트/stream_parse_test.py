# -*- coding: utf-8 -*-
import sys, os, json, datetime, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '러너', 'py'))
from server import collect_text, collect_delta, dept_config_to_prompt, sanitize_dept_config, stamp_updated

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


if __name__ == '__main__':
    unittest.main()
