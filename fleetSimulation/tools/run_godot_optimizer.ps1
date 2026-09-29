param(
    [Parameter(Mandatory = $true)][string]$GodotExe,
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$GalaxyId,
    [Parameter(Mandatory = $true)][string]$SimulationClock,
    [Parameter(Mandatory = $true)][int]$FixedFpsActive,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [Parameter(Mandatory = $true)][string]$NodeResult,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [switch]$VerboseOutput,
    [double]$MaxWallSeconds = 0,
    [double]$StartupTimeoutSeconds = 60,
    [double]$ShutdownGraceSeconds = 30,
    [string]$WorkerId = ""
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
    foreach ($line in ($Text -split "\r?\n")) {
        if ($Counts.SuppressContinuation) {
            if ($line -match '^\s+(at:|GDScript backtrace|\[[0-9]+\])') {
                continue
            }
            $Counts.SuppressContinuation = $false
        }
        if ($line.StartsWith('ERROR: Condition "!actions.custom_samplers.has(function->arguments[j].tex_builtin)"')) {
            $Counts.Shader = [int]$Counts.Shader + 1
            $Counts.SuppressContinuation = $true
            continue
        }
        if (
            $line -match '^(WARNING|ERROR): [0-9]+ ObjectDB instances were leaked at exit' -or
            $line -match '^(WARNING|ERROR): [0-9]+ resources still in use at exit' -or
            $line -match '^(WARNING|ERROR): [0-9]+ RIDs? .* leaked'
        ) {
            [void]$Counts.Leaks.Add($line)
            $Counts.SuppressContinuation = $true
            continue
        }
        if ($line -ne "") {
            [Console]::WriteLine($line)
        }
    }
}

function Stop-OptimizerProcessTree {
    param([System.Diagnostics.Process]$Child)
    if (-not $Child.HasExited) {
        # Only the process launched by this invocation and its own workers.
        try { & "$env:SystemRoot\System32\taskkill.exe" /PID $Child.Id /T /F 2>&1 | Out-Null }
        catch { [Console]::Error.WriteLine('WARNING: process-tree shutdown failed; terminating the direct child.') }
        if (-not $Child.HasExited) { $Child.Kill() }
    }
}

if ($MaxWallSeconds -le 0) {
    $config = Get-Content -LiteralPath (Join-Path $ProjectPath 'config.json') -Raw | ConvertFrom-Json
    $MaxWallSeconds = 300
    if ($null -ne $config.search.max_wall_seconds) {
        $MaxWallSeconds = [double]$config.search.max_wall_seconds
    }
}
if ($MaxWallSeconds -le 0 -or $StartupTimeoutSeconds -le 0 -or $ShutdownGraceSeconds -lt 0) {
    throw 'Optimizer time limits must be positive (shutdown grace may be zero)'
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

if ($WorkerId -ne "") { $arguments += "--worker-id=$WorkerId" }

$logDirectory = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $GodotExe
$startInfo.Arguments = (($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join " ")
$startInfo.WorkingDirectory = $ProjectPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$started = $false
$forcedExit = 0
try {
    if (-not $process.Start()) {
        throw "Godot process did not start"
    }
    $started = $true
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $phase = 'engine startup'
    $runnerReady = $false
    $nextHeartbeat = 5.0
    $counts = @{ Shader = 0; Leaks = New-Object System.Collections.ArrayList; SuppressContinuation = $false }
    $readers = @($process.StandardOutput, $process.StandardError)
    $pending = @($readers[0].ReadLineAsync(), $readers[1].ReadLineAsync())
    [Console]::WriteLine(("Runner budget: {0}s; startup timeout: {1}s; shutdown grace: {2}s" -f $MaxWallSeconds, $StartupTimeoutSeconds, $ShutdownGraceSeconds))
    while ($null -ne $pending[0] -or $null -ne $pending[1] -or -not $process.HasExited) {
        for ($channel = 0; $channel -lt 2; $channel++) {
            # Drain a bounded number per channel so busy stdout cannot starve errors.
            for ($batch = 0; $batch -lt 100 -and $null -ne $pending[$channel] -and $pending[$channel].IsCompleted; $batch++) {
                $line = $pending[$channel].Result
                if ($null -eq $line) { $pending[$channel] = $null; break }
                if ($channel -eq 0 -or $VerboseOutput) { [Console]::WriteLine($line) }
                else { Write-FilteredGodotOutput $line $counts }
                if ($line -match '^OPTIMIZER_RUNNER_READY:') { $runnerReady = $true; $phase = 'native initialization / input resolution' }
                if ($line -match '^\[[0-9]+/[0-9]+\]') { $phase = $line }
                if ($line -match '^SCRIPT ERROR:|^ERROR: Failed to (load script|instantiate an autoload)') {
                    $forcedExit = 70
                    [Console]::Error.WriteLine('ERROR: Godot script failed; stopping this optimizer process tree. See the error above.')
                    Stop-OptimizerProcessTree $process
                }
                $pending[$channel] = $readers[$channel].ReadLineAsync()
            }
        }
        $elapsed = $clock.Elapsed.TotalSeconds
        if ($forcedExit -eq 0 -and -not $process.HasExited) {
            if (-not $runnerReady -and $elapsed -ge $StartupTimeoutSeconds) {
                $forcedExit = 71
                [Console]::Error.WriteLine('ERROR: optimizer Runner did not become ready before the startup timeout.')
            }
            elseif ($elapsed -ge $MaxWallSeconds + $ShutdownGraceSeconds) {
                $forcedExit = 72
                [Console]::Error.WriteLine('ERROR: optimizer exceeded its wall budget plus shutdown grace; stopping the stalled run.')
            }
            if ($forcedExit -ne 0) { Stop-OptimizerProcessTree $process }
        }
        if ($elapsed -ge $nextHeartbeat -and -not $process.HasExited) {
            [Console]::WriteLine(('Runner heartbeat: {0:F1}s / {1}s | {2}' -f $elapsed, $MaxWallSeconds, $phase))
            $nextHeartbeat = $elapsed + 5.0
        }
        Start-Sleep -Milliseconds 25
    }
    $process.WaitForExit()
    if ([int]$counts.Shader -gt 0) {
        [Console]::WriteLine("NOTICE: collapsed {0} known non-fatal Godot 4.7.2 FleetBattle shader diagnostics." -f $counts.Shader)
    }
    if ($counts.Leaks.Count -gt 0) {
        [Console]::WriteLine("NOTICE: Godot reported fixed exit cleanup diagnostics: {0}" -f ($counts.Leaks -join " | "))
    }
    [Console]::WriteLine("Godot log: {0}" -f $LogPath)
    $exitCode = if ($forcedExit -ne 0) { $forcedExit } else { $process.ExitCode }
}
catch {
    [Console]::Error.WriteLine("ERROR: unable to run Godot Optimizer: " + $_.Exception.Message)
    $exitCode = 127
}
finally {
    if ($started -and -not $process.HasExited) { Stop-OptimizerProcessTree $process }
    $process.Dispose()
}

exit $exitCode
