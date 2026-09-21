[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$prettier = Join-Path $appRoot 'node_modules\.bin\prettier.cmd'

if (-not (Test-Path -LiteralPath $prettier -PathType Leaf)) {
    throw "Prettier is not installed. Run 'pnpm install' in app first."
}

$prettierArgs = @(
    '--config', (Join-Path $appRoot '.prettierrc.json'),
    '--ignore-path', (Join-Path $appRoot '.prettierignore')
)
if ($Check) {
    $prettierArgs += '--check'
} else {
    $prettierArgs += '--write'
}
$prettierArgs += @(
    'src/**/*.ts',
    'src/**/*.tsx',
    'tests/**/*.ts',
    'tests/**/*.tsx',
    'tests/**/*.mts',
    '*.ts',
    '*.json'
)

Push-Location $appRoot
try {
    & $prettier @prettierArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
