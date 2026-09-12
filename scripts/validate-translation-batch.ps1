[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 999)]
    [int]$BatchNumber
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BatchId = 'batch_{0:D3}' -f $BatchNumber
$BatchDirectory = Join-Path $ProjectRoot 'translation\work\translation_batches'
$InputPath = Join-Path $BatchDirectory ($BatchId + '_input.csv')
$OutputPath = Join-Path $BatchDirectory ($BatchId + '_output.csv')
$ValidationPath = Join-Path $BatchDirectory ($BatchId + '_validated.json')
$InventoryPath = Join-Path $ProjectRoot 'translation\translations\inventory.csv'
$CustomPath = Join-Path $ProjectRoot 'translation\translations\custom.csv'
$ReviewPath = Join-Path $ProjectRoot 'translation\translations\review.csv'
$StatusPath = Join-Path $ProjectRoot 'translation\status\translation_status.json'

foreach ($Path in @($InputPath, $OutputPath, $InventoryPath, $StatusPath)) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "输入文件不存在：$Path" }
}
if (Test-Path -LiteralPath $ValidationPath) { throw "批次已经验证，拒绝重复合并：$ValidationPath" }

function Get-SortedMatches {
    param([string]$Text, [string]$Pattern)
    if ($null -eq $Text) { return @() }
    return @([regex]::Matches($Text, $Pattern) | ForEach-Object { $_.Value } | Sort-Object)
}

function Test-SameList {
    param([string[]]$Left, [string[]]$Right)
    return (($Left -join [char]0) -ceq ($Right -join [char]0))
}

function Write-CsvAtomic {
    param([object[]]$Rows, [string]$Path)
    $Temporary = $Path + '.tmp'
    if (Test-Path -LiteralPath $Temporary) { throw "临时文件已存在：$Temporary" }
    try {
        $Rows | Export-Csv -LiteralPath $Temporary -NoTypeInformation -Encoding UTF8
        Move-Item -LiteralPath $Temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force }
    }
}

$InputRows = @(Import-Csv -LiteralPath $InputPath -Encoding UTF8)
$OutputRows = @(Import-Csv -LiteralPath $OutputPath -Encoding UTF8)
$Issues = New-Object 'System.Collections.Generic.List[string]'
if ($InputRows.Count -ne $OutputRows.Count) {
    $Issues.Add("条目数量不一致：input=$($InputRows.Count)，output=$($OutputRows.Count)")
}

$Count = [Math]::Min($InputRows.Count, $OutputRows.Count)
$TokenPattern = '%(?:[-+0#]*\d*(?:\.\d+)?[A-Za-z])|\{[^{}\r\n]+\}|\[/?[A-Za-z_][A-Za-z0-9_.:-]*(?:=[^\]]+)?\]'
$EscapePattern = '\\(?:n|r|t|"|\\)'
$NumberPattern = '[-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?%?'

for ($Index = 0; $Index -lt $Count; $Index++) {
    $Input = $InputRows[$Index]
    $Output = $OutputRows[$Index]
    $Line = $Index + 2
    foreach ($Column in @('key', 'english', 'official_chinese', 'classification', 'task')) {
        if ([string]$Input.$Column -cne [string]$Output.$Column) {
            $Issues.Add("第 $Line 行 $Column 被修改：$([string]$Input.key)")
        }
    }

    $Decision = [string]$Output.decision
    $Custom = [string]$Output.custom_chinese
    $Allowed = if ($Input.task -eq 'TRANSLATE') { @('IMPROVE', 'NEED_REVIEW') } else { @('KEEP', 'IMPROVE', 'NEED_REVIEW') }
    if ($Allowed -cnotcontains $Decision) {
        $Issues.Add("第 $Line 行 decision 非法：$Decision；key=$([string]$Input.key)")
        continue
    }
    if ($Decision -eq 'KEEP' -and -not [string]::IsNullOrWhiteSpace($Custom)) {
        $Issues.Add("第 $Line 行 KEEP 不应填写 custom_chinese：$([string]$Input.key)")
    }
    if ($Decision -eq 'IMPROVE' -and [string]::IsNullOrWhiteSpace($Custom)) {
        $Issues.Add("第 $Line 行 IMPROVE 缺少 custom_chinese：$([string]$Input.key)")
        continue
    }

    if ($Decision -eq 'IMPROVE') {
        $English = [string]$Input.english
        if (-not (Test-SameList (Get-SortedMatches $English $TokenPattern) (Get-SortedMatches $Custom $TokenPattern))) {
            $Issues.Add("第 $Line 行占位符/标签不一致：$([string]$Input.key)")
        }
        if (-not (Test-SameList (Get-SortedMatches $English $EscapePattern) (Get-SortedMatches $Custom $EscapePattern))) {
            $Issues.Add("第 $Line 行转义字符不一致：$([string]$Input.key)")
        }
        $EnglishNewlines = ([regex]::Matches($English, "`n")).Count
        $CustomNewlines = ([regex]::Matches($Custom, "`n")).Count
        if ($EnglishNewlines -ne $CustomNewlines) {
            $Issues.Add("第 $Line 行实际换行数不一致：$([string]$Input.key)；$EnglishNewlines != $CustomNewlines")
        }
        if (-not (Test-SameList (Get-SortedMatches $English $NumberPattern) (Get-SortedMatches $Custom $NumberPattern))) {
            $Issues.Add("第 $Line 行数字不一致：$([string]$Input.key)")
        }
    }
}

if ($Issues.Count -gt 0) {
    Write-Host "批次 $BatchId 技术校验失败，共 $($Issues.Count) 项："
    foreach ($Issue in $Issues) { Write-Host "- $Issue" }
    exit 1
}

$Inventory = @(Import-Csv -LiteralPath $InventoryPath -Encoding UTF8)
$InventoryByKey = @{}
foreach ($Row in $Inventory) {
    if ($InventoryByKey.ContainsKey($Row.key)) { throw "inventory key 重复：$($Row.key)" }
    $InventoryByKey[$Row.key] = $Row
}

foreach ($Output in $OutputRows) {
    if (-not $InventoryByKey.ContainsKey($Output.key)) { throw "output key 不在 inventory：$($Output.key)" }
    $Row = $InventoryByKey[$Output.key]
    $Row.custom_chinese = if ($Output.decision -eq 'IMPROVE') { [string]$Output.custom_chinese } else { '' }
    $Row.status = [string]$Output.decision
    if (-not [string]::IsNullOrWhiteSpace([string]$Output.note)) {
        $Row.note = (([string]$Row.note).TrimEnd() + ' Luna: ' + ([string]$Output.note).Trim()).Trim()
    }
}

Write-CsvAtomic $Inventory $InventoryPath

$CustomRows = @($Inventory | Where-Object status -eq 'IMPROVE' | ForEach-Object {
    [pscustomobject][ordered]@{
        key = $_.key
        english = $_.english
        official_chinese = $_.official_chinese
        custom_chinese = $_.custom_chinese
        note = $_.note
        status = 'approved'
    }
})
Write-CsvAtomic $CustomRows $CustomPath

$ReviewRows = @($Inventory | Where-Object status -eq 'NEED_REVIEW' | ForEach-Object {
    [pscustomobject][ordered]@{
        key = $_.key
        english = $_.english
        current_chinese = $_.official_chinese
        reason = $_.note
        suggested_action = if ([string]::IsNullOrWhiteSpace($_.english)) { '需要官方源 CSV 或精确英文 key 提示文件后再处理' } else { '人工确认游戏机制或上下文' }
        status = 'NEED_REVIEW'
    }
})
Write-CsvAtomic $ReviewRows $ReviewPath

$Status = Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Completed = New-Object 'System.Collections.Generic.List[string]'
foreach ($Item in @($Status.completed_batches)) { if ($Item) { $Completed.Add([string]$Item) } }
$Completed.Add($BatchId)
$CompletedSorted = @($Completed | Sort-Object -Unique)
$Status.completed_batches = $CompletedSorted
$Status.keep = @($Inventory | Where-Object status -eq 'KEEP').Count
$Status.improve = @($Inventory | Where-Object status -eq 'IMPROVE').Count
$Status.translated = @($Inventory | Where-Object { $_.status -eq 'IMPROVE' -and $_.classification -in @('MISSING', 'UNTRANSLATED') }).Count
$Status.validated = $Status.keep + $Status.improve + @($Inventory | Where-Object { $_.status -eq 'NEED_REVIEW' -and -not [string]::IsNullOrWhiteSpace($_.english) }).Count
$Status.remaining = [Math]::Max(0, $Status.parsed_entries - $Status.validated)
$Next = Get-ChildItem -LiteralPath $BatchDirectory -Filter 'batch_*_input.csv' -File | Sort-Object Name | Where-Object {
    $Candidate = $_.BaseName.Replace('_input', '')
    $CompletedSorted -notcontains $Candidate
} | Select-Object -First 1
$Status.current_batch = if ($Next) { $Next.BaseName.Replace('_input', '') } else { $null }
$Status.last_updated = (Get-Date).ToString('o')
[IO.File]::WriteAllText($StatusPath, ($Status | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

$Validation = [ordered]@{
    batch = $BatchId
    entries = $OutputRows.Count
    input_sha256 = (Get-FileHash -LiteralPath $InputPath -Algorithm SHA256).Hash
    output_sha256 = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash
    validation = 'passed'
    validated_at = (Get-Date).ToString('o')
}
[IO.File]::WriteAllText($ValidationPath, ($Validation | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Host "批次 $BatchId 校验并合并完成：$($OutputRows.Count) 条"
