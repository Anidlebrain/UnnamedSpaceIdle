[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Write-Error "项目目录不存在：$ProjectRoot"
    exit 1
}

$RequiredDirectories = @(
    '.codex\agents', 'config', 'status', 'scripts', 'backup', 'docs', 'tools',
    'translation', 'translation\glossary', 'translation\translations',
    'translation\status', 'translation\work', 'translation\output', 'translation\docs'
)

foreach ($RelativePath in $RequiredDirectories) {
    $Directory = Join-Path $ProjectRoot $RelativePath
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        New-Item -ItemType Directory -Path $Directory | Out-Null
        Write-Host "已创建目录：$RelativePath"
    }
}

$RequiredFiles = @(
    'AGENTS.md', 'README.md', '.gitignore',
    '.codex\agents\translator.toml',
    'config\config.example.json',
    'translation\glossary\glossary.csv',
    'translation\translations\official_current.csv',
    'translation\translations\custom.csv',
    'translation\translations\pending.csv',
    'translation\translations\review.csv',
    'translation\translations\test_patch.csv',
    'translation\status\translation_status.json',
    'translation\status\translation_validation.json',
    'status\pck_analysis.json',
    'translation\docs\localization-analysis.md',
    'scripts\backup-pck.ps1',
    'scripts\restore-pck.ps1',
    'scripts\install-test-pck.ps1'
)

$MissingFiles = @()
foreach ($RelativePath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $RelativePath) -PathType Leaf)) {
        $MissingFiles += $RelativePath
    }
}

$LocalConfig = Join-Path $ProjectRoot 'config\config.local.json'
if (Test-Path -LiteralPath $LocalConfig -PathType Leaf) {
    Write-Host '本地配置：已找到 config/config.local.json'
} else {
    Write-Host '本地配置：未创建（需要时复制 config.example.json 并填写）'
}

if ($MissingFiles.Count -gt 0) {
    Write-Warning ("缺少关键文件：" + ($MissingFiles -join ', '))
    exit 1
}

Write-Host '项目结构检查通过；未修改任何游戏文件。'
