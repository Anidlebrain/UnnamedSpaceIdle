[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'config\config.local.json'
$TestPck = Join-Path $ProjectRoot 'translation\output\SpaceIdle.test.pck'
$BuildMetadataPath = Join-Path $ProjectRoot 'translation\output\SpaceIdle.test.metadata.json'

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "本地配置不存在：$ConfigPath" }
if (-not (Test-Path -LiteralPath $TestPck -PathType Leaf)) { throw "测试 PCK 不存在：$TestPck" }
if (-not (Test-Path -LiteralPath $BuildMetadataPath -PathType Leaf)) { throw "构建元数据不存在：$BuildMetadataPath" }
if (Get-Process -Name 'SpaceIdle' -ErrorAction SilentlyContinue) {
    throw '检测到 SpaceIdle 正在运行，拒绝安装测试 PCK。'
}

$Config = Get-Content -Raw -LiteralPath $ConfigPath -Encoding UTF8 | ConvertFrom-Json
$BuildMetadata = Get-Content -Raw -LiteralPath $BuildMetadataPath -Encoding UTF8 | ConvertFrom-Json
$GamePck = [IO.Path]::GetFullPath([string]$Config.game_pck)
if (-not (Test-Path -LiteralPath $GamePck -PathType Leaf)) { throw "游戏 PCK 不存在：$GamePck" }

$ExpectedHash = ([string]$BuildMetadata.test_pck_sha256).ToUpperInvariant()
$TestHash = (Get-FileHash -LiteralPath $TestPck -Algorithm SHA256).Hash.ToUpperInvariant()
if ($TestHash -cne $ExpectedHash) { throw "测试 PCK 与构建元数据不一致：$TestHash" }

Write-Host '安装前保存当前游戏 PCK...'
$Backup = & (Join-Path $PSScriptRoot 'backup-pck.ps1') -PckPath $GamePck -PassThru
if ($null -eq $Backup) { throw '安装前备份没有返回结果。' }

$GameDirectory = Split-Path -Parent $GamePck
$TemporaryPck = Join-Path $GameDirectory ('.SpaceIdle.test.{0}.tmp' -f [guid]::NewGuid().ToString('N'))
$RollbackPck = Join-Path $GameDirectory ('.SpaceIdle.rollback.{0}.pck' -f [guid]::NewGuid().ToString('N'))
$ReplacementStarted = $false

try {
    Copy-Item -LiteralPath $TestPck -Destination $TemporaryPck
    $TemporaryHash = (Get-FileHash -LiteralPath $TemporaryPck -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($TemporaryHash -cne $ExpectedHash) { throw "临时文件 SHA256 校验失败：$TemporaryHash" }

    $ReplacementStarted = $true
    [IO.File]::Replace($TemporaryPck, $GamePck, $RollbackPck, $true)
    $InstalledHash = (Get-FileHash -LiteralPath $GamePck -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($InstalledHash -cne $ExpectedHash) {
        [IO.File]::Replace($RollbackPck, $GamePck, $null, $true)
        $ReplacementStarted = $false
        throw "安装后 SHA256 校验失败，已回滚：$InstalledHash"
    }

    $ReplacementStarted = $false
    if (Test-Path -LiteralPath $RollbackPck) { Remove-Item -LiteralPath $RollbackPck -Force }
    Write-Host '当前安装的是测试汉化 PCK，不是正式汉化。'
    Write-Host "已安装：$GamePck"
    Write-Host "SHA256：$InstalledHash"
    Write-Host ('恢复命令：.\scripts\restore-pck.ps1 -BackupDirectory "{0}"' -f $Backup.BackupPath)
} finally {
    if (Test-Path -LiteralPath $TemporaryPck) { Remove-Item -LiteralPath $TemporaryPck -Force }
    if (-not $ReplacementStarted -and (Test-Path -LiteralPath $RollbackPck)) {
        Remove-Item -LiteralPath $RollbackPck -Force
    }
}
