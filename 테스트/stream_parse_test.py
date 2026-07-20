# -*- coding: utf-8 -*-
import sys, os, json, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '러너', 'py'))
from server import collect_text, collect_delta, dept_config_to_prompt

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


if __name__ == '__main__':
    unittest.main()
