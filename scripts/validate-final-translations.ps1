[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$InventoryPath = Join-Path $ProjectRoot 'translation\translations\inventory.csv'
$CustomPath = Join-Path $ProjectRoot 'translation\translations\custom.csv'
$ReviewPath = Join-Path $ProjectRoot 'translation\translations\review.csv'
$StatusPath = Join-Path $ProjectRoot 'translation\status\translation_status.json'
$ReportPath = Join-Path $ProjectRoot 'translation\status\translation_validation.json'
$BatchDirectory = Join-Path $ProjectRoot 'translation\work\translation_batches'
$Issues = New-Object 'System.Collections.Generic.List[string]'

function Get-SortedMatches {
    param([string]$Text, [string]$Pattern)
    if ($null -eq $Text) { return @() }
    return @([regex]::Matches($Text, $Pattern) | ForEach-Object { $_.Value } | Sort-Object)
}

function Test-SameList {
    param([string[]]$Left, [string[]]$Right)
    return (($Left -join [char]0) -ceq ($Right -join [char]0))
}

$Inventory = @(Import-Csv -LiteralPath $InventoryPath -Encoding UTF8)
$Custom = @(Import-Csv -LiteralPath $CustomPath -Encoding UTF8)
$Review = @(Import-Csv -LiteralPath $ReviewPath -Encoding UTF8)
$Status = Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json

$InventoryByKey = @{}
foreach ($Row in $Inventory) {
    if ([string]::IsNullOrWhiteSpace([string]$Row.key)) { $Issues.Add('inventory 存在空 key'); continue }
    if ($InventoryByKey.ContainsKey($Row.key)) { $Issues.Add("inventory key 重复：$($Row.key)"); continue }
    $InventoryByKey[$Row.key] = $Row
}

if ($Inventory.Count -ne [int]$Status.total_entries) { $Issues.Add("inventory 数量与状态不一致：$($Inventory.Count) != $($Status.total_entries)") }
if ($Custom.Count -ne @($Inventory | Where-Object status -eq 'IMPROVE').Count) { $Issues.Add('custom 数量与 IMPROVE 状态不一致') }
if ($Review.Count -ne @($Inventory | Where-Object status -eq 'NEED_REVIEW').Count) { $Issues.Add('review 数量与 NEED_REVIEW 状态不一致') }

$TokenPattern = '%(?:[-+0#]*\d*(?:\.\d+)?[A-Za-z])|\{[^{}\r\n]+\}|\[/?[A-Za-z_][A-Za-z0-9_.:-]*(?:=[^\]]+)?\]'
$AngleTagPattern = '</?[A-Za-z_][^>]*?/?>'
$EscapePattern = '\\(?:n|r|t|"|\\)'
$NumberPattern = '[-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?%?'
$FormulaPattern = '(?<![\p{L}\p{N}_])[-+]?\d+(?:\.\d+)?(?:\s*[/*^=<>]\s*[-+]?\d+(?:\.\d+)?)+'
$SeenCustom = @{}

foreach ($Row in $Custom) {
    if ($SeenCustom.ContainsKey($Row.key)) { $Issues.Add("custom key 重复：$($Row.key)"); continue }
    $SeenCustom[$Row.key] = $true
    if (-not $InventoryByKey.ContainsKey($Row.key)) { $Issues.Add("custom key 不在 inventory：$($Row.key)"); continue }
    $Source = $InventoryByKey[$Row.key]
    if ($Source.status -ne 'IMPROVE') { $Issues.Add("custom key 状态不是 IMPROVE：$($Row.key)") }
    if ([string]$Row.english -cne [string]$Source.english -or [string]$Row.official_chinese -cne [string]$Source.official_chinese -or [string]$Row.custom_chinese -cne [string]$Source.custom_chinese) {
        $Issues.Add("custom 与 inventory 字段不一致：$($Row.key)")
    }
    if ([string]::IsNullOrWhiteSpace([string]$Row.custom_chinese)) { $Issues.Add("custom 译文为空：$($Row.key)"); continue }
    if ([string]$Row.custom_chinese -ceq [string]$Row.official_chinese) { $Issues.Add("custom 译文未变化：$($Row.key)") }
    if ($Row.key -like 'HASH:*') { $Issues.Add("未解析哈希条目不应进入 custom：$($Row.key)") }

    foreach ($Check in @(
        @{ Name = '占位符/方括号标签'; Pattern = $TokenPattern },
        @{ Name = '尖括号标签'; Pattern = $AngleTagPattern },
        @{ Name = '转义字符'; Pattern = $EscapePattern },
        @{ Name = '数字'; Pattern = $NumberPattern },
        @{ Name = '公式'; Pattern = $FormulaPattern }
    )) {
        if (-not (Test-SameList (Get-SortedMatches $Row.english $Check.Pattern) (Get-SortedMatches $Row.custom_chinese $Check.Pattern))) {
            $Issues.Add("$($Check.Name)不一致：$($Row.key)")
        }
    }
    $EnglishNewlines = ([regex]::Matches([string]$Row.english, "`n")).Count
    $ChineseNewlines = ([regex]::Matches([string]$Row.custom_chinese, "`n")).Count
    if ($EnglishNewlines -ne $ChineseNewlines) { $Issues.Add("实际换行数不一致：$($Row.key)") }
}

foreach ($Number in 1..5) {
    $BatchId = 'batch_{0:D3}' -f $Number
    $InputPath = Join-Path $BatchDirectory ($BatchId + '_input.csv')
    $OutputPath = Join-Path $BatchDirectory ($BatchId + '_output.csv')
    $ValidationPath = Join-Path $BatchDirectory ($BatchId + '_validated.json')
    foreach ($Path in @($InputPath, $OutputPath, $ValidationPath)) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { $Issues.Add("批次文件缺失：$Path") }
    }
    if (Test-Path -LiteralPath $ValidationPath -PathType Leaf) {
        $Validation = Get-Content -LiteralPath $ValidationPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ((Get-FileHash -LiteralPath $InputPath -Algorithm SHA256).Hash -cne [string]$Validation.input_sha256) { $Issues.Add("批次输入哈希变化：$BatchId") }
        if ((Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash -cne [string]$Validation.output_sha256) { $Issues.Add("批次输出哈希变化：$BatchId") }
        if ([string]$Validation.validation -ne 'passed') { $Issues.Add("批次验证状态异常：$BatchId") }
    }
}

$Report = [ordered]@{
    status = if ($Issues.Count -eq 0) { 'passed' } else { 'failed' }
    checked_at = (Get-Date).ToString('o')
    inventory_entries = $Inventory.Count
    custom_entries = $Custom.Count
    review_entries = $Review.Count
    completed_batches = 5
    checks = @('key_and_count', 'printf_and_brace_placeholders', 'bbcode_and_html_tags', 'literal_and_actual_newlines', 'escape_sequences', 'numbers', 'formula_operators', 'batch_hashes')
    issues = @($Issues)
}
[IO.File]::WriteAllText($ReportPath, ($Report | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

if ($Issues.Count -gt 0) {
    Write-Host "最终技术校验失败，共 $($Issues.Count) 项："
    foreach ($Issue in $Issues) { Write-Host "- $Issue" }
    exit 1
}

$Status.technical_validation = 'passed'
$Status.last_updated = (Get-Date).ToString('o')
[IO.File]::WriteAllText($StatusPath, ($Status | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
Write-Host "最终技术校验通过：inventory=$($Inventory.Count)，custom=$($Custom.Count)，review=$($Review.Count)，batches=5"
