# -*- coding: utf-8 -*-
import sys, os, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '러너', 'py'))
from server import collect_text

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

if __name__ == '__main__':
    unittest.main()
