[CmdletBinding()]
param(
    [Parameter()]
    [string]$GameDirectory
)

$ErrorActionPreference = 'Stop'
$GameName = 'Unnamed Space Idle'
$Candidates = New-Object 'System.Collections.Generic.List[string]'

function Add-Candidate {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not $Candidates.Contains($Path)) { $Candidates.Add($Path) }
}

if ($GameDirectory) {
    Add-Candidate $GameDirectory
}

$SteamRoots = New-Object 'System.Collections.Generic.List[string]'
function Add-SteamRoot {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not $SteamRoots.Contains($Path)) { $SteamRoots.Add($Path) }
}

if (${env:ProgramFiles(x86)}) { Add-SteamRoot (Join-Path ${env:ProgramFiles(x86)} 'Steam') }
if ($env:ProgramFiles) { Add-SteamRoot (Join-Path $env:ProgramFiles 'Steam') }

$RegistryLocations = @(
    @{ Path = 'HKCU:\Software\Valve\Steam'; Name = 'SteamPath' },
    @{ Path = 'HKLM:\Software\Valve\Steam'; Name = 'InstallPath' },
    @{ Path = 'HKLM:\Software\WOW6432Node\Valve\Steam'; Name = 'InstallPath' }
)

foreach ($Location in $RegistryLocations) {
    try {
        $Value = Get-ItemPropertyValue -LiteralPath $Location.Path -Name $Location.Name -ErrorAction Stop
        Add-SteamRoot $Value
    } catch {
        # 缺少某个注册表项是正常情况。
    }
}

$LibraryRoots = New-Object 'System.Collections.Generic.List[string]'
foreach ($SteamRoot in $SteamRoots) {
    if (-not $LibraryRoots.Contains($SteamRoot)) { $LibraryRoots.Add($SteamRoot) }

    $LibraryFile = Join-Path $SteamRoot 'steamapps\libraryfolders.vdf'
    if (-not (Test-Path -LiteralPath $LibraryFile -PathType Leaf)) { continue }

    foreach ($Line in Get-Content -LiteralPath $LibraryFile -Encoding UTF8) {
        if ($Line -match '^\s*"path"\s+"([^"]+)"') {
            $LibraryPath = $Matches[1].Replace('\\', '\')
            if (-not $LibraryRoots.Contains($LibraryPath)) { $LibraryRoots.Add($LibraryPath) }
        }
    }
}

foreach ($LibraryRoot in $LibraryRoots) {
    Add-Candidate (Join-Path $LibraryRoot "steamapps\common\$GameName")
}

$FoundDirectory = $null
foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate -PathType Container) {
        $ExePath = Join-Path $Candidate 'SpaceIdle.exe'
        $PckPath = Join-Path $Candidate 'SpaceIdle.pck'
        if ((Test-Path -LiteralPath $ExePath -PathType Leaf) -or (Test-Path -LiteralPath $PckPath -PathType Leaf)) {
            $FoundDirectory = (Resolve-Path -LiteralPath $Candidate).Path
            break
        }
    }
}

if (-not $FoundDirectory) {
    Write-Host '未找到 Unnamed Space Idle。可使用 -GameDirectory 指定游戏目录；未执行任何修改。'
    exit 0
}

$ExePath = Join-Path $FoundDirectory 'SpaceIdle.exe'
$PckPath = Join-Path $FoundDirectory 'SpaceIdle.pck'
$ExeExists = Test-Path -LiteralPath $ExePath -PathType Leaf
$PckExists = Test-Path -LiteralPath $PckPath -PathType Leaf

Write-Host "游戏目录：$FoundDirectory"
Write-Host "SpaceIdle.exe：$(if ($ExeExists) { '存在' } else { '不存在' })"
Write-Host "SpaceIdle.pck：$(if ($PckExists) { '存在' } else { '不存在' })"

if ($PckExists) {
    $Pck = Get-Item -LiteralPath $PckPath
    $Hash = Get-FileHash -LiteralPath $PckPath -Algorithm SHA256
    Write-Host "SpaceIdle.pck 文件大小：$($Pck.Length) 字节"
    Write-Host "SpaceIdle.pck 最后修改时间：$($Pck.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss zzz'))"
    Write-Host "SpaceIdle.pck SHA256：$($Hash.Hash)"
}

Write-Host '检测完成；未修改任何游戏文件。'
