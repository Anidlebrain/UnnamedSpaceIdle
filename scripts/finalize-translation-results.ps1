[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$InventoryPath = Join-Path $ProjectRoot 'translation\translations\inventory.csv'
$CustomPath = Join-Path $ProjectRoot 'translation\translations\custom.csv'
$ReviewPath = Join-Path $ProjectRoot 'translation\translations\review.csv'
$StatusPath = Join-Path $ProjectRoot 'translation\status\translation_status.json'
$BatchDirectory = Join-Path $ProjectRoot 'translation\work\translation_batches'

foreach ($Number in 1..5) {
    $ValidationPath = Join-Path $BatchDirectory ('batch_{0:D3}_validated.json' -f $Number)
    if (-not (Test-Path -LiteralPath $ValidationPath -PathType Leaf)) { throw "批次未验证：$ValidationPath" }
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

function Add-NoteOnce {
    param([object]$Row, [string]$Text)
    if (-not ([string]$Row.note).Contains($Text)) {
        $Row.note = (([string]$Row.note).TrimEnd() + ' ' + $Text).Trim()
    }
}

$Inventory = @(Import-Csv -LiteralPath $InventoryPath -Encoding UTF8)
$ByKey = @{}
foreach ($Row in $Inventory) {
    if ($ByKey.ContainsKey($Row.key)) { throw "inventory key 重复：$($Row.key)" }
    $ByKey[$Row.key] = $Row
}

foreach ($Row in $Inventory) {
    if ($Row.status -eq 'IMPROVE' -and [string]$Row.custom_chinese -ceq [string]$Row.official_chinese) {
        $Row.status = 'KEEP'
        $Row.custom_chinese = ''
        Add-NoteOnce $Row '主 Agent: 自定义译文与官方译文完全相同，归并为 KEEP。'
    }
}

$EnglishOverrides = [ordered]@{
    '[Research]' = 'Research'
    '[Shards]' = 'Shards'
    '[AI Points Price]' = 'AI Points'
    '[AI Points Total]' = 'AI Points'
}
foreach ($Key in $EnglishOverrides.Keys) {
    if (-not $ByKey.ContainsKey($Key)) { throw "英文覆写 key 不在 inventory：$Key" }
    $ByKey[$Key].english = $EnglishOverrides[$Key]
    Add-NoteOnce $ByKey[$Key] '主 Agent: english 来自 Translation_en.en.translation 的可靠覆写映射。'
}

$KeepOverrides = @('Drive')
foreach ($Key in $KeepOverrides) {
    if (-not $ByKey.ContainsKey($Key)) { throw "KEEP 覆写 key 不在 inventory：$Key" }
    $ByKey[$Key].status = 'KEEP'
    $ByKey[$Key].custom_chinese = ''
    Add-NoteOnce $ByKey[$Key] '主 Agent: 现有译文语义成立，保留。'
}

$ImproveOverrides = [ordered]@{
    '[AI Points Price]' = 'AI 点数'
    '[AI Points Total]' = 'AI 点数'
    'Void Device' = '虚空装置'
    'Shield %' = '护盾百分比'
    'Ablative Shielding' = '烧蚀护盾'
    'System Challenge Active:   Damage and Shields are set to your Power.  1/10th Damage taken drains Power.' = '系统挑战进行中：伤害和护盾设为你的能量值。承受伤害的 1/10 会消耗能量。'
}
foreach ($Key in $ImproveOverrides.Keys) {
    if (-not $ByKey.ContainsKey($Key)) { throw "IMPROVE 覆写 key 不在 inventory：$Key" }
    $ByKey[$Key].status = 'IMPROVE'
    $ByKey[$Key].custom_chinese = $ImproveOverrides[$Key]
    Add-NoteOnce $ByKey[$Key] '主 Agent: 根据可靠英文映射、明确词义或技术保护规则修正。'
}

foreach ($Key in @('1.25 Cap+ Cap+', '1.1 Cap+++')) {
    if (-not $ByKey.ContainsKey($Key)) { throw "NEED_REVIEW 覆写 key 不在 inventory：$Key" }
    $ByKey[$Key].status = 'NEED_REVIEW'
    $ByKey[$Key].custom_chinese = ''
    Add-NoteOnce $ByKey[$Key] '主 Agent: Cap+ 标签含义不明确，且不得删除加号，退回 NEED_REVIEW。'
}

$CustomRows = @($Inventory | Where-Object status -eq 'IMPROVE' | ForEach-Object {
    if ([string]::IsNullOrWhiteSpace([string]$_.custom_chinese)) { throw "IMPROVE 缺少译文：$($_.key)" }
    if ([string]$_.custom_chinese -ceq [string]$_.official_chinese) { throw "IMPROVE 未产生变化：$($_.key)" }
    [pscustomobject][ordered]@{
        key = $_.key
        english = $_.english
        official_chinese = $_.official_chinese
        custom_chinese = $_.custom_chinese
        note = $_.note
        status = 'approved'
    }
})

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

Write-CsvAtomic $Inventory $InventoryPath
Write-CsvAtomic $CustomRows $CustomPath
Write-CsvAtomic $ReviewRows $ReviewPath

$Status = Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Status.keep = @($Inventory | Where-Object status -eq 'KEEP').Count
$Status.improve = $CustomRows.Count
$Status.translated = @($Inventory | Where-Object { $_.status -eq 'IMPROVE' -and $_.classification -in @('MISSING', 'UNTRANSLATED') }).Count
$Status.validated = @($Inventory | Where-Object { -not [string]::IsNullOrWhiteSpace($_.english) }).Count
$Status.remaining = 0
$Status.current_batch = $null
$Status.completed_batches = @(1..5 | ForEach-Object { 'batch_{0:D3}' -f $_ })
$Status.review = $ReviewRows.Count
$Status | Add-Member -NotePropertyName classification_review -NotePropertyValue (@($Inventory | Where-Object classification -eq 'REVIEW').Count) -Force
$Status | Add-Member -NotePropertyName technical_validation -NotePropertyValue 'translation_batches_passed' -Force
$Status.last_updated = (Get-Date).ToString('o')
[IO.File]::WriteAllText($StatusPath, ($Status | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

Write-Host "KEEP：$($Status.keep)"
Write-Host "IMPROVE：$($Status.improve)"
Write-Host "TRANSLATED：$($Status.translated)"
Write-Host "NEED_REVIEW：$($Status.review)"
