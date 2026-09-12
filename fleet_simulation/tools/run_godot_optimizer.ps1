param(
    [Parameter(Mandatory = $true)][string]$GodotExe,
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$GalaxyId,
    [Parameter(Mandatory = $true)][string]$SimulationClock,
    [Parameter(Mandatory = $true)][int]$FixedFpsActive,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [Parameter(Mandatory = $true)][string]$NodeResult,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [switch]$VerboseOutput
)

$ErrorActionPreference = "Stop"

function Quote-ProcessArgument {
    param([string]$Value)
    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Write-FilteredGodotOutput {
    param([string]$Text, [hashtable]$Counts)
    $suppressContinuation = $false
    foreach ($line in ($Text -split "\r?\n")) {
        if ($suppressContinuation) {
            if ($line -match '^\s+(at:|GDScript backtrace|\[[0-9]+\])') {
                continue
            }
            $suppressContinuation = $false
        }
        if ($line.StartsWith('ERROR: Condition "!actions.custom_samplers.has(function->arguments[j].tex_builtin)"')) {
            $Counts.Shader = [int]$Counts.Shader + 1
            $suppressContinuation = $true
            continue
        }
        if (
            $line -match '^(WARNING|ERROR): [0-9]+ ObjectDB instances were leaked at exit' -or
            $line -match '^(WARNING|ERROR): [0-9]+ resources still in use at exit' -or
            $line -match '^(WARNING|ERROR): [0-9]+ RIDs? .* leaked'
        ) {
            [void]$Counts.Leaks.Add($line)
            $suppressContinuation = $true
            continue
        }
        if ($line -ne "") {
            [Console]::WriteLine($line)
        }
    }
}

$arguments = @("--headless", "--disable-render-loop", "--log-file", $LogPath)
if ($SimulationClock -eq "offline_fixed_step") {
    $arguments += @("--fixed-fps", "60")
}
if ($VerboseOutput) {
    $arguments += "--verbose"
}
$arguments += @(
    "--path",
    $ProjectPath,
    "res://fleet_optimizer_bootstrap.tscn",
    "--",
    "--optimizer-galaxy=$GalaxyId",
    "--simulation-clock=$SimulationClock",
    "--fixed-fps-active=$FixedFpsActive",
    "--daily-optimizer",
    "--daily-output-dir=$OutputDir",
    "--node-result=$NodeResult"
)
if ($VerboseOutput) {
    $arguments += "--verbose"
}

$logDirectory = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $GodotExe
$startInfo.Arguments = (($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " ")
$startInfo.WorkingDirectory = $ProjectPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $false
$startInfo.RedirectStandardOutput = -not $VerboseOutput
$startInfo.RedirectStandardError = -not $VerboseOutput

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
try {
    if (-not $process.Start()) {
        throw "Godot process did not start"
    }
    if ($VerboseOutput) {
        $process.WaitForExit()
    }
    else {
        $stdout = $process.StandardOutput
        $stderrTask = $process.StandardError.ReadToEndAsync()
        while (($line = $stdout.ReadLine()) -ne $null) {
            [Console]::WriteLine($line)
        }
        $process.WaitForExit()
        $stderr = $stderrTask.Result
        $counts = @{ Shader = 0; Leaks = New-Object System.Collections.ArrayList }
        Write-FilteredGodotOutput $stderr $counts
        if ([int]$counts.Shader -gt 0) {
            [Console]::WriteLine("NOTICE: collapsed {0} known non-fatal Godot 4.7.2 FleetBattle shader diagnostics." -f $counts.Shader)
        }
        if ($counts.Leaks.Count -gt 0) {
            [Console]::WriteLine("NOTICE: Godot reported fixed exit cleanup diagnostics: {0}" -f ($counts.Leaks -join " | "))
        }
        [Console]::WriteLine("Godot log: {0}" -f $LogPath)
    }
    $exitCode = $process.ExitCode
}
catch {
    [Console]::Error.WriteLine("ERROR: unable to run Godot Optimizer: " + $_.Exception.Message)
    $exitCode = 127
}
finally {
    $process.Dispose()
}

exit $exitCode
