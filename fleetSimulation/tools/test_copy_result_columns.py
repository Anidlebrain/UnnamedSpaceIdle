"""Regression tests for copying a result TXT into a Friendly Node config."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("copy_result_to_config.ps1")
POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")


@unittest.skipUnless(POWERSHELL, "PowerShell is required")
class CopyResultColumnsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config_path = self.root / "node.json"
        self.result_path = self.root / "node.result.txt"

    def write_config(self, columns=2):
        config = {
            "baseline": {
                "enabled": False,
                "formation": {"A1": "Fighter"},
                "loadouts": {
                    "1": {"primary": "ExistingFighter", "secondary": None},
                    "Cruiser": {"primary": "OldCruiser", "secondary": None},
                },
            }
        }
        if columns is not None:
            config["formation_columns"] = columns
        self.config_path.write_text(json.dumps(config), encoding="utf-8")

    def write_result(self, rows, metadata=None):
        lines = []
        if metadata is not None:
            lines.append(f"Formation columns: {metadata}")
        lines.extend([
            "Mods:",
            "  4: Primary=1; Secondary=0",
            "",
            "Formation:",
            "        1    2    3    4    5",
        ])
        lines.extend(f"{letter}    {' '.join(map(str, cells))}" for letter, cells in rows)
        lines.extend(["  0=empty; ship IDs: 1 / 2 / 3 / 4 / 5", "", "FR: Used/Battle=5"])
        self.result_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def run_copy(self):
        return subprocess.run(
            [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", str(SCRIPT),
             "-SummaryPath", str(self.result_path), "-ConfigPath", str(self.config_path)],
            capture_output=True, text=True, timeout=20,
        )

    def test_complete_numeric_rows_for_one_two_and_three_columns(self):
        rows = [
            ("A", [4, 0, 0, 0, 0]),
            ("B", [0, 4, 0, 0, 0]),
            ("C", [0, 0, 4, 0, 0]),
        ]
        for columns, with_metadata in ((1, True), (2, False), (3, True)):
            with self.subTest(columns=columns):
                self.write_config(columns if with_metadata else None)
                self.write_result(rows[:columns], metadata=columns if with_metadata else None)
                result = self.run_copy()
                self.assertEqual(result.returncode, 0, result.stderr)
                config = json.loads(self.config_path.read_text(encoding="utf-8"))
                formation = config["baseline"]["formation"]
                self.assertEqual(len(formation), columns * 5)
                for row_index, (letter, cells) in enumerate(rows[:columns]):
                    for cell_index, cell in enumerate(cells, 1):
                        self.assertEqual(formation[f"{letter}{cell_index}"], cell)
                self.assertTrue(config["baseline"]["enabled"])
                self.assertEqual(config["baseline"]["loadouts"]["Fighter"]["primary"], "ExistingFighter")
                self.assertEqual(config["baseline"]["loadouts"]["Cruiser"],
                                 {"primary": 1, "secondary": 0})

    def test_rejected_rows_and_column_counts_leave_config_unchanged(self):
        valid = [("A", [4, 0, 0, 0, 0]), ("B", [0, 4, 0, 0, 0]),
                 ("C", [0, 0, 4, 0, 0])]
        cases = [
            (3, valid[:2], 3),             # missing C
            (2, valid, 2),                 # extra C
            (2, valid[:2] + valid[:1], 2), # duplicate A
            (2, valid[:1] + [("B", [4, 0, 0, 0])], 2), # short row
            (2, valid[:2], 3),             # mismatched metadata
            (0, valid[:2], None),          # invalid target count
            (27, valid[:2], None),
            ("2", valid[:2], None),
            (2.5, valid[:2], None),
        ]
        for index, (columns, rows, metadata) in enumerate(cases):
            with self.subTest(case=index):
                self.write_config(columns)
                self.write_result(rows, metadata)
                before = self.config_path.read_bytes()
                result = self.run_copy()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.config_path.read_bytes(), before)

    def test_english_formation_remains_supported(self):
        self.write_config(1)
        self.write_result([("A", ["Cr", ".", "Fighter", ".", "."])], metadata=1)
        result_text = self.result_path.read_text(encoding="utf-8")
        self.result_path.write_text(
            result_text.replace("4: Primary=1; Secondary=0",
                                "Cruiser: Primary=LaserMod; Secondary=None"),
            encoding="utf-8",
        )
        result = self.run_copy()
        self.assertEqual(result.returncode, 0, result.stderr)
        baseline = json.loads(self.config_path.read_text(encoding="utf-8"))["baseline"]
        self.assertEqual(baseline["formation"], {"A1": "Cruiser", "A3": "Fighter"})
        self.assertEqual(baseline["loadouts"]["Cruiser"],
                         {"primary": "LaserMod", "secondary": None})

    def test_integer_valued_json_number_and_invalid_types(self):
        rows = [(letter, [4, 0, 0, 0, 0]) for letter in "ABC"]
        self.write_config(3.0)
        self.write_result(rows, metadata=3)
        result = self.run_copy()
        self.assertEqual(result.returncode, 0, result.stderr)
        for value in [True, False, "3", None]:
            self.write_config(3)
            config = json.loads(self.config_path.read_text(encoding="utf-8"))
            config["formation_columns"] = value
            self.config_path.write_text(json.dumps(config), encoding="utf-8")
            before = self.config_path.read_bytes()
            self.assertNotEqual(self.run_copy().returncode, 0)
            self.assertEqual(self.config_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
