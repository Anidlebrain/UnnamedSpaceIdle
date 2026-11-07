"""One isolated native process per search; sequential atomic file protocol."""
import json
import os
from pathlib import Path
import subprocess
import time

from .catalog import read_json, require
from .native import stage, unexpected_errors


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temporary, path)


class NativeWorker:
    def __init__(self, source, godot, label, deadline, clock='fixed'):
        self.deadline, self.index, self.process = deadline, 0, None
        self.streams = []
        self.run, self.project, self.user_dir = stage(source, label, deadline=deadline)
        self.cache = {}
        try:
            write_json(self.project / 'native_input.json', {'server': True})
            for name in ('requests', 'responses'):
                (self.user_dir / name).mkdir()
            self.streams = [(self.run / f'{name}.log').open('w', encoding='utf-8') for name in ('stdout', 'stderr')]
            command = [str(Path(godot).resolve()), '--headless', '--path', str(self.project)]
            if clock == 'fixed':
                command += ['--fixed-fps', '60']
            self.process = subprocess.Popen(command, stdout=self.streams[0], stderr=self.streams[1],
                                            env=dict(os.environ, APPDATA=str(self.run / 'appdata')),
                                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.startup = self._wait(self.user_dir / 'ready.json')
        except BaseException:
            self.close()
            raise

    def _check(self):
        if time.perf_counter() >= self.deadline:
            raise TimeoutError('Search time budget exhausted')
        stderr = (self.run / 'stderr.log').read_text(encoding='utf-8', errors='replace')
        require('SCRIPT ERROR:' not in stderr and not unexpected_errors(stderr),
                f'Native runtime error; see {self.run / "stderr.log"}')
        require(self.process.poll() is None, f'Native process exited unexpectedly: {self.process.returncode}')

    def _wait(self, path):
        while True:
            self._check()
            if path.exists():
                return read_json(path)
            time.sleep(.025)

    def evaluate(self, request):
        self._check()
        key = json.dumps(request, sort_keys=True, allow_nan=False)
        if key in self.cache:
            return self.cache[key]
        self.index += 1
        write_json(self.user_dir / 'requests' / f'{self.index:06d}.json', {'id': self.index, 'input': request})
        response = self._wait(self.user_dir / 'responses' / f'{self.index:06d}.json')
        require(response.get('id') == self.index, 'Native response ID mismatch')
        battle = response['battle']
        require(battle.get('status') == 'NATIVE_SMOKE_ONLY', f'Native trial failed: {battle}')
        self.cache[key] = battle
        return battle

    def close(self):
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        for stream in self.streams:
            stream.close()
        self.streams = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
