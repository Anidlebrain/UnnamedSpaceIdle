"""Small launcher regressions: deployment closure, live errors and watchdogs."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
PS = shutil.which('powershell.exe')


class StageFilesTests(unittest.TestCase):
    def test_daily_stage_includes_local_script_dependencies(self):
        bat = (ROOT / 'run_optimizer.bat').read_text()
        names = re.search(r'for %%F in \((.*?)\) do', bat).group(1).split()
        for name in names:
            if not name.endswith('.gd'):
                continue
            source = (ROOT / 'poc' / name).read_text(encoding='utf-8')
            for dependency in re.findall(r'(?:preload|extends)\(?"res://([^/" ]+\.gd)"', source):
                self.assertIn(dependency, names, f'{name} needs {dependency}')


@unittest.skipUnless(PS, 'Windows PowerShell required')
class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='fleet-runner-test-')
        cls.root = Path(cls.directory.name)
        cls.exe = cls.root / 'fake-godot.exe'
        source = cls.root / 'fake.cs'
        source.write_text('''using System;
using System.Threading;
class FakeGodot {
  static void Main() {
    string mode = Environment.GetEnvironmentVariable("FLEET_RUNNER_TEST");
    if (mode == "parse") {
      Console.Error.WriteLine("SCRIPT ERROR: Parse Error: missing dependency");
      Thread.Sleep(30000); return;
    }
    if (mode != "startup") Console.WriteLine("OPTIMIZER_RUNNER_READY: test");
    if (mode == "startup" || mode == "wall") Thread.Sleep(30000);
    Console.Error.WriteLine("diagnostic visible before exit");
  }
}''', encoding='utf-8')
        quote = lambda p: "'" + str(p).replace("'", "''") + "'"
        subprocess.run([PS, '-NoProfile', '-Command',
                        f'Add-Type -Path {quote(source)} -OutputAssembly {quote(cls.exe)} -OutputType ConsoleApplication'],
                       capture_output=True, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def run_case(self, mode, expected):
        env = dict(os.environ, FLEET_RUNNER_TEST=mode)
        cmd = [PS, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
               str(ROOT / 'tools/run_godot_optimizer.ps1'), '-GodotExe', str(self.exe),
               '-ProjectPath', str(self.root), '-GalaxyId', 'galaxy8',
               '-SimulationClock', 'offline_fixed_step', '-FixedFpsActive', '60',
               '-OutputDir', str(self.root), '-NodeResult', str(self.root / 'result.json'),
               '-LogPath', str(self.root / 'godot.log'), '-MaxWallSeconds', '3',
               '-StartupTimeoutSeconds', '2', '-ShutdownGraceSeconds', '0']
        started = time.monotonic()
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertLess(time.monotonic() - started, 8)
        return result.stdout + result.stderr

    def test_parse_error_exits_without_waiting_for_godot(self):
        self.assertIn('missing dependency', self.run_case('parse', 70))

    def test_missing_runner_has_startup_deadline(self):
        self.assertIn('startup timeout', self.run_case('startup', 71))

    def test_stalled_runner_has_outer_wall_deadline(self):
        self.assertIn('wall budget', self.run_case('wall', 72))

    def test_success_streams_stderr_and_keeps_exit_code(self):
        self.assertIn('diagnostic visible before exit', self.run_case('success', 0))


if __name__ == '__main__':
    unittest.main()
