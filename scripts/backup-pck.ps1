[CmdletBinding()]
param(
    [Parameter()]
    [string]$PckPath,

    [Parameter()]
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $ProjectRoot 'config\config.local.json'

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "本地配置不存在：$ConfigPath"
}

$Config = Get-Content -Raw -LiteralPath $ConfigPath -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($PckPath)) { $PckPath = [string]$Config.game_pck }
if (-not (Test-Path -LiteralPath $PckPath -PathType Leaf)) { throw "PCK 不存在：$PckPath" }

$Source = Get-Item -LiteralPath $PckPath
$SourceHash = (Get-FileHash -LiteralPath $Source.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
$ConfiguredBackupRoot = [string]$Config.backup_dir
if ([IO.Path]::IsPathRooted($ConfiguredBackupRoot)) {
    $BackupRoot = [IO.Path]::GetFullPath($ConfiguredBackupRoot)
} else {
    $BackupRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $ConfiguredBackupRoot))
}
New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

$ExistingBackup = $null
foreach ($MetadataFile in Get-ChildItem -LiteralPath $BackupRoot -Filter 'metadata.json' -File -Recurse -ErrorAction SilentlyContinue) {
    try {
        $Metadata = Get-Content -Raw -LiteralPath $MetadataFile.FullName -Encoding UTF8 | ConvertFrom-Json
        $CandidatePck = Join-Path $MetadataFile.Directory.FullName 'SpaceIdle.pck'
        if ([string]$Metadata.sha256 -ieq $SourceHash -and (Test-Path -LiteralPath $CandidatePck -PathType Leaf)) {
            $CandidateHash = (Get-FileHash -LiteralPath $CandidatePck -Algorithm SHA256).Hash
            if ($CandidateHash -ieq $SourceHash) {
                $ExistingBackup = $MetadataFile.Directory.FullName
                break
            }
        }
    } catch {
        Write-Warning "忽略无法读取的备份元数据：$($MetadataFile.FullName)"
    }
}

if ($ExistingBackup) {
    Write-Host "相同 SHA256 的备份已存在，未重复复制：$ExistingBackup"
    $Result = [pscustomobject]@{ BackupPath = $ExistingBackup; Sha256 = $SourceHash; FileSize = $Source.Length; Reused = $true }
    if ($PassThru) { return $Result }
    return
}

$FolderName = '{0}_{1}' -f $Source.LastWriteTime.ToString('yyyy-MM-dd'), $SourceHash.Substring(0, 8)
$BackupDirectory = Join-Path $BackupRoot $FolderName
if (Test-Path -LiteralPath $BackupDirectory) { throw "备份目录已存在但未通过校验：$BackupDirectory" }
New-Item -ItemType Directory -Path $BackupDirectory | Out-Null

$FinalPck = Join-Path $BackupDirectory 'SpaceIdle.pck'
$TemporaryPck = Join-Path $BackupDirectory 'SpaceIdle.pck.copying'
try {
    Copy-Item -LiteralPath $Source.FullName -Destination $TemporaryPck
    $CopiedHash = (Get-FileHash -LiteralPath $TemporaryPck -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($CopiedHash -cne $SourceHash) { throw "备份校验失败：源=$SourceHash，副本=$CopiedHash" }
    Move-Item -LiteralPath $TemporaryPck -Destination $FinalPck

    $GdreVersion = $null
    if (Test-Path -LiteralPath ([string]$Config.gdretools_path) -PathType Leaf) {
        $GdreVersion = (Get-Item -LiteralPath ([string]$Config.gdretools_path)).VersionInfo.ProductVersion
        if ($GdreVersion -match '^(\d+\.\d+\.\d+)\.0$') { $GdreVersion = $Matches[1] }
    }

    $Metadata = [ordered]@{
        source_path = $Source.FullName
        backup_time = (Get-Date).ToString('o')
        file_size = $Source.Length
        sha256 = $SourceHash
        last_write_time = $Source.LastWriteTime.ToString('o')
        game_version = $null
        gdretools_version = $GdreVersion
        notes = '原版 SpaceIdle.pck 的只读复制；复制后 SHA256 已校验。'
    }
    $Json = $Metadata | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $BackupDirectory 'metadata.json'), $Json, (New-Object Text.UTF8Encoding($false)))
} catch {
    if (Test-Path -LiteralPath $TemporaryPck) { Remove-Item -LiteralPath $TemporaryPck -Force }
    throw
}

Write-Host "备份完成：$BackupDirectory"
Write-Host "SHA256：$SourceHash"
Write-Host "文件大小：$($Source.Length) 字节"
Write-Host '源游戏文件未被修改。'

$Result = [pscustomobject]@{ BackupPath = $BackupDirectory; Sha256 = $SourceHash; FileSize = $Source.Length; Reused = $false }
if ($PassThru) { return $Result }
