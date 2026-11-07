from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import Mock, patch

from titan_research.worker import NativeWorker


class WorkerTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / 'work' / 'test-temp'
        root.mkdir(parents=True, exist_ok=True)
        self.folder = TemporaryDirectory(dir=root)
        self.addCleanup(self.folder.cleanup)
        w = self.worker = NativeWorker.__new__(NativeWorker)
        w.run = w.user_dir = Path(self.folder.name)
        (w.run / 'stderr.log').write_text('', encoding='utf-8')
        w.process = Mock()
        w.process.poll.return_value = None
        w.deadline = time.perf_counter() + 60
        w.streams, w.cache, w.index = [], {}, 0

    def test_budget_always_checked_before_cache(self):
        self.worker.deadline = 0
        with self.assertRaises(TimeoutError):
            self.worker.evaluate({})

    def test_cache_only_reuses_identical_complete_requests(self):
        with patch.object(self.worker, '_wait', side_effect=[
            {'id': 1, 'battle': {'status': 'NATIVE_SMOKE_ONLY'}},
            {'id': 2, 'battle': {'status': 'NATIVE_SMOKE_ONLY'}}]) as wait:
            first = self.worker.evaluate({'seed': 1})
            self.assertEqual(self.worker.evaluate({'seed': 1}), first)
            self.worker.evaluate({'seed': 2})
            self.assertEqual(wait.call_count, 2)
            self.assertEqual(self.worker.index, 2)
        self.assertFalse(list(self.worker.user_dir.rglob('*.tmp')))

    def test_wrong_id_and_failed_native_status_never_cached(self):
        for response in ({'id': 99, 'battle': {}}, {'id': 1, 'battle': {'status': 'INVALID_SETUP'}}):
            self.worker.index = 0
            with patch.object(self.worker, '_wait', return_value=response), self.assertRaises(ValueError):
                self.worker.evaluate({'seed': 1})
            self.assertEqual(self.worker.cache, {})

    def test_script_errors_fail_before_result(self):
        (self.worker.run / 'stderr.log').write_text('SCRIPT ERROR: example', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Native runtime error'):
            self.worker.evaluate({})

    def test_close_terminates_owned_process_even_after_interrupt(self):
        with self.assertRaises(KeyboardInterrupt):
            with self.worker:
                raise KeyboardInterrupt()
        self.worker.process.kill.assert_called_once()
        self.worker.process.wait.assert_called_once()


if __name__ == '__main__':
    unittest.main()
