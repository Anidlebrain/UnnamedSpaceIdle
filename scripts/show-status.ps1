[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StatusPath = Join-Path $ProjectRoot 'translation\status\translation_status.json'

if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) {
    Write-Warning "状态文件不存在：$StatusPath"
    exit 1
}

try {
    $Status = Get-Content -Raw -LiteralPath $StatusPath -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Warning "无法读取状态文件：$($_.Exception.Message)"
    exit 1
}

function Show-Value {
    param($Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return '未知' }
    return [string]$Value
}

Write-Host "项目阶段：$(Show-Value $Status.project_phase)"
Write-Host "游戏目录：$(Show-Value $Status.game_path)"
Write-Host "原版 PCK SHA256：$(Show-Value $Status.original_pck_sha256)"
Write-Host "备份状态：$(Show-Value $Status.backup_status)"
Write-Host "Godot / PCK：$(Show-Value $Status.godot_version) / 格式 $(Show-Value $Status.pck_format_version)"
Write-Host "测试补丁：$(Show-Value $Status.test_patch_status)"
Write-Host "测试构建：$(Show-Value $Status.test_build_status)"
Write-Host "测试安装：$(Show-Value $Status.test_install_status)"
Write-Host "最后更新时间：$(Show-Value $Status.last_updated)"
