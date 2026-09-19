[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SummaryPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    [Console]::Error.WriteLine("ERROR: $Message")
    exit 1
}

try {
    $summary = [IO.Path]::GetFullPath($SummaryPath)
    $configPath = [IO.Path]::GetFullPath($ConfigPath)
    if (-not [IO.File]::Exists($summary)) { Fail "result TXT not found: $summary" }
    if (-not [IO.File]::Exists($configPath)) { Fail "config JSON not found: $configPath" }

    $lines = [IO.File]::ReadAllLines($summary)
    $modsAt = [Array]::IndexOf($lines, 'Mods:')
    $formationAt = [Array]::IndexOf($lines, 'Formation:')
    if ($modsAt -lt 0 -or $formationAt -le $modsAt) {
        Fail 'result TXT has no valid Mods/Formation sections'
    }

    $rows = @{}
    for ($i = $formationAt + 1; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match '^\s*([AB])\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$') {
            $rows[$matches[1]] = @($matches[2], $matches[3], $matches[4], $matches[5], $matches[6])
        }
    }
    if (-not $rows.ContainsKey('A') -or -not $rows.ContainsKey('B')) {
        Fail 'Formation must contain A and B rows with five cells each'
    }

    $tokens = @($rows.A) + @($rows.B)
    $numeric = @($tokens | Where-Object { $_ -notmatch '^[0-5]$' }).Count -eq 0
    $english = @($tokens | Where-Object { $_ -notin @('.', 'Fi', 'Co', 'Fr', 'Cr', 'HC', 'Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser') }).Count -eq 0
    if (-not $numeric -and -not $english) { Fail 'Formation contains unsupported or mixed ship tokens' }

    $ships = @{
        '1'='Fighter'; 'Fi'='Fighter'; 'Fighter'='Fighter'
        '2'='Corvette'; 'Co'='Corvette'; 'Corvette'='Corvette'
        '3'='Frigate'; 'Fr'='Frigate'; 'Frigate'='Frigate'
        '4'='Cruiser'; 'Cr'='Cruiser'; 'Cruiser'='Cruiser'
        '5'='HeavyCruiser'; 'HC'='HeavyCruiser'; 'HeavyCruiser'='HeavyCruiser'
    }
    $formation = [ordered]@{}
    foreach ($row in @('A', 'B')) {
        for ($column = 1; $column -le 5; $column++) {
            $token = [string]$rows[$row][$column - 1]
            if ($numeric) { $formation["$row$column"] = [int]$token }
            elseif ($token -ne '.') { $formation["$row$column"] = $ships[$token] }
        }
    }

    $foundLoadouts = @{}
    for ($i = $modsAt + 1; $i -lt $formationAt; $i++) {
        if ([string]::IsNullOrWhiteSpace($lines[$i])) { continue }
        if ($lines[$i] -notmatch '^\s*(Fighter|Corvette|Frigate|Cruiser|HeavyCruiser|[1-5]):\s*Primary=([^;]+);\s*Secondary=(\S+)\s*$') {
            Fail "unsupported Mods line: $($lines[$i].Trim())"
        }
        $ship = $ships[$matches[1]]
        $primary = $matches[2].Trim()
        $secondary = $matches[3].Trim()
        if ($numeric) {
            if ($primary -notmatch '^\d+$' -or $secondary -notmatch '^\d+$') {
                Fail "numeric Formation requires numeric Mod values for $ship"
            }
            $foundLoadouts[$ship] = [ordered]@{ primary=[int]$primary; secondary=[int]$secondary }
        }
        else {
            if ($primary -ieq 'none' -or $primary -eq '0') { $primary = $null }
            if ($secondary -ieq 'none' -or $secondary -eq '0') { $secondary = $null }
            $foundLoadouts[$ship] = [ordered]@{ primary=$primary; secondary=$secondary }
        }
    }
    if ($foundLoadouts.Count -eq 0) { Fail 'result TXT Mods section is empty' }

    $loadouts = [ordered]@{}
    foreach ($ship in @('Fighter', 'Corvette', 'Frigate', 'Cruiser', 'HeavyCruiser')) {
        if ($foundLoadouts.ContainsKey($ship)) { $loadouts[$ship] = $foundLoadouts[$ship] }
    }

    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    if ($null -eq $config.baseline) { Fail 'config JSON has no baseline object' }
    $config.baseline.enabled = $true
    $config.baseline.formation = [pscustomobject]$formation
    $config.baseline.loadouts = [pscustomobject]$loadouts

    $json = $config | ConvertTo-Json -Depth 100
    $null = $json | ConvertFrom-Json
    $temp = Join-Path ([IO.Path]::GetDirectoryName($configPath)) ('.copy-result-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temp, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temp -Destination $configPath -Force
    }
    finally {
        if ([IO.File]::Exists($temp)) { Remove-Item -LiteralPath $temp -Force }
    }

    Write-Output 'Copied recommended formation and loadouts:'
    Write-Output "  From: $summary"
    Write-Output "  To:   $configPath"
}
catch {
    Fail $_.Exception.Message
}
