[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'config\config.local.json'
$Config = Get-Content -Raw -LiteralPath $ConfigPath -Encoding UTF8 | ConvertFrom-Json
$GamePck = [IO.Path]::GetFullPath([string]$Config.game_pck)
$BackupRoot = if ([IO.Path]::IsPathRooted([string]$Config.backup_dir)) {
    [IO.Path]::GetFullPath([string]$Config.backup_dir)
} else {
    [IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$Config.backup_dir)))
}
$SelectedBackup = [IO.Path]::GetFullPath($BackupDirectory)
$BackupPrefix = $BackupRoot.TrimEnd('\') + '\'
if (-not $SelectedBackup.StartsWith($BackupPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "备份目录必须位于项目 backup 目录内：$BackupRoot"
}

if (Get-Process -Name 'SpaceIdle' -ErrorAction SilentlyContinue) {
    throw '检测到 SpaceIdle 正在运行，拒绝恢复。'
}

$BackupPck = Join-Path $SelectedBackup 'SpaceIdle.pck'
$MetadataPath = Join-Path $SelectedBackup 'metadata.json'
if (-not (Test-Path -LiteralPath $BackupPck -PathType Leaf)) { throw "备份 PCK 不存在：$BackupPck" }
if (-not (Test-Path -LiteralPath $MetadataPath -PathType Leaf)) { throw "备份元数据不存在：$MetadataPath" }
if (-not (Test-Path -LiteralPath $GamePck -PathType Leaf)) { throw "游戏 PCK 不存在：$GamePck" }

$Metadata = Get-Content -Raw -LiteralPath $MetadataPath -Encoding UTF8 | ConvertFrom-Json
$ExpectedHash = ([string]$Metadata.sha256).ToUpperInvariant()
$BackupHash = (Get-FileHash -LiteralPath $BackupPck -Algorithm SHA256).Hash.ToUpperInvariant()
if ($BackupHash -cne $ExpectedHash) { throw "目标备份 SHA256 与元数据不一致：$BackupHash" }

Write-Host '恢复前保存当前游戏 PCK...'
& (Join-Path $PSScriptRoot 'backup-pck.ps1') -PckPath $GamePck | Out-Host

$GameDirectory = Split-Path -Parent $GamePck
$TemporaryPck = Join-Path $GameDirectory ('.SpaceIdle.restore.{0}.tmp' -f [guid]::NewGuid().ToString('N'))
$RollbackPck = Join-Path $GameDirectory ('.SpaceIdle.rollback.{0}.pck' -f [guid]::NewGuid().ToString('N'))
$ReplacementStarted = $false

try {
    Copy-Item -LiteralPath $BackupPck -Destination $TemporaryPck
    $TemporaryHash = (Get-FileHash -LiteralPath $TemporaryPck -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($TemporaryHash -cne $ExpectedHash) { throw "临时文件 SHA256 校验失败：$TemporaryHash" }

    $ReplacementStarted = $true
    [IO.File]::Replace($TemporaryPck, $GamePck, $RollbackPck, $true)
    $InstalledHash = (Get-FileHash -LiteralPath $GamePck -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($InstalledHash -cne $ExpectedHash) {
        [IO.File]::Replace($RollbackPck, $GamePck, $null, $true)
        $ReplacementStarted = $false
        throw "恢复后 SHA256 校验失败，已回滚：$InstalledHash"
    }

    $ReplacementStarted = $false
    if (Test-Path -LiteralPath $RollbackPck) { Remove-Item -LiteralPath $RollbackPck -Force }
    Write-Host "恢复成功：$GamePck"
    Write-Host "SHA256：$InstalledHash"
} finally {
    if (Test-Path -LiteralPath $TemporaryPck) { Remove-Item -LiteralPath $TemporaryPck -Force }
    if (-not $ReplacementStarted -and (Test-Path -LiteralPath $RollbackPck)) { Remove-Item -LiteralPath $RollbackPck -Force }
}
