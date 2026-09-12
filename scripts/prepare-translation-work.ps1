[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourceCsv = Join-Path $ProjectRoot 'translation\work\current\recovered\.assets\Translation.csv'
$TextResource = Join-Path $ProjectRoot 'translation\work\translation_text\Translation.zh.translation'
$MessagesPath = Join-Path $ProjectRoot 'translation\work\zh_messages.jsonl'
$InventoryPath = Join-Path $ProjectRoot 'translation\translations\inventory.csv'
$ReviewPath = Join-Path $ProjectRoot 'translation\translations\review.csv'
$BatchDirectory = Join-Path $ProjectRoot 'translation\work\translation_batches'
$StatusPath = Join-Path $ProjectRoot 'translation\status\translation_status.json'

foreach ($Path in @($SourceCsv, $TextResource, $MessagesPath)) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "输入文件不存在：$Path" }
}
if (Test-Path -LiteralPath $InventoryPath) { throw "inventory 已存在，拒绝覆盖：$InventoryPath" }
if (Test-Path -LiteralPath $BatchDirectory) { throw "批次目录已存在，拒绝覆盖：$BatchDirectory" }

function ConvertTo-UInt32 {
    param([long]$Value)
    if ($Value -lt 0) { return [uint32]([uint64]($Value + 4294967296L)) }
    return [uint32]$Value
}

function Get-OptimizedTranslationHash {
    param([uint32]$Seed, [string]$Text)
    [uint64]$Hash = $Seed
    if ($Hash -eq 0) { $Hash = 0x1000193 }
    foreach ($Byte in [Text.Encoding]::UTF8.GetBytes($Text)) {
        $Hash = ((($Hash * 0x1000193) -band 0xFFFFFFFFL) -bxor [uint64]$Byte)
    }
    return [uint32]$Hash
}

function Get-PropertyValues {
    param([string[]]$Lines, [string]$Name)
    $Prefix = "$Name = PackedInt32Array("
    $Line = @($Lines | Where-Object { $_.StartsWith($Prefix, [StringComparison]::Ordinal) })
    if ($Line.Count -ne 1) { throw "资源属性 $Name 的匹配数不是 1：$($Line.Count)" }
    $Inner = $Line[0].Substring($Prefix.Length)
    $Inner = $Inner.Substring(0, $Inner.Length - 1)
    return @($Inner -split ', ' | ForEach-Object { [long]$_ })
}

$Lines = [IO.File]::ReadAllLines($TextResource)
$HashTable = @(Get-PropertyValues $Lines 'hash_table')
$BucketTable = @(Get-PropertyValues $Lines 'bucket_table')
$StringsLine = @($Lines | Where-Object { $_.StartsWith('strings = PackedByteArray("', [StringComparison]::Ordinal) })
if ($StringsLine.Count -ne 1) { throw "strings 属性匹配数不是 1：$($StringsLine.Count)" }
$StringsPrefix = 'strings = PackedByteArray("'
$Base64 = $StringsLine[0].Substring($StringsPrefix.Length)
$Base64 = $Base64.Substring(0, $Base64.Length - 2)
$StringByteCount = [Convert]::FromBase64String($Base64).Length

$Messages = @(Get-Content -LiteralPath $MessagesPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
$Entries = New-Object 'System.Collections.Generic.List[object]'
for ($Slot = 0; $Slot -lt $HashTable.Count; $Slot++) {
    $Pointer = $HashTable[$Slot]
    if ($Pointer -lt 0) { continue }
    if ($Pointer + 1 -ge $BucketTable.Count) { throw "桶指针越界：slot=$Slot pointer=$Pointer" }
    $Size = [int]$BucketTable[$Pointer]
    $Function = ConvertTo-UInt32 $BucketTable[$Pointer + 1]
    for ($Index = 0; $Index -lt $Size; $Index++) {
        $Base = $Pointer + 2 + ($Index * 4)
        if ($Base + 3 -ge $BucketTable.Count) { throw "桶元素越界：slot=$Slot index=$Index" }
        $Offset = [long]$BucketTable[$Base + 1]
        $CompressedSize = [long]$BucketTable[$Base + 2]
        $UncompressedSize = [long]$BucketTable[$Base + 3]
        if ($Offset -lt 0 -or $CompressedSize -lt 0 -or $Offset + $CompressedSize -gt $StringByteCount) {
            throw "字符串池范围无效：slot=$Slot index=$Index offset=$Offset size=$CompressedSize pool=$StringByteCount"
        }
        $Entries.Add([pscustomobject]@{
            slot = $Slot
            function = $Function
            secondary_hash = ConvertTo-UInt32 $BucketTable[$Base]
            offset = $Offset
            compressed_size = $CompressedSize
            uncompressed_size = $UncompressedSize
        })
    }
}
if ($Entries.Count -ne $Messages.Count) { throw "桶条目数与解压消息数不一致：$($Entries.Count) != $($Messages.Count)" }

$EntryByIdentity = @{}
for ($Index = 0; $Index -lt $Entries.Count; $Index++) {
    $Entry = $Entries[$Index]
    $Identity = '{0}|{1}' -f $Entry.slot, $Entry.secondary_hash
    if ($EntryByIdentity.ContainsKey($Identity)) { throw "重复哈希身份：$Identity" }
    $EntryByIdentity[$Identity] = [pscustomobject]@{ entry = $Entry; message = [string]$Messages[$Index] }
}

$RecoveredRows = @(Import-Csv -LiteralPath $SourceCsv -Encoding UTF8)
$ReliableRows = @($RecoveredRows | Where-Object { $_.key -notlike '<!MissingKey:*' })
$ReliableByKey = @{}
foreach ($Group in @($ReliableRows | Group-Object key)) {
    $ChineseValues = @($Group.Group.zh | Sort-Object -Unique)
    if ($ChineseValues.Count -ne 1) { throw "重复 key 的简中值不一致：$($Group.Name)" }
    $ReliableByKey[$Group.Name] = $Group.Group[0]
}

$KnownByIdentity = @{}
$MissingKnownKeys = New-Object 'System.Collections.Generic.List[string]'
foreach ($Key in $ReliableByKey.Keys) {
    $PrimaryHash = Get-OptimizedTranslationHash 0 $Key
    $Slot = [int]([uint64]$PrimaryHash % [uint64]$HashTable.Count)
    $Pointer = $HashTable[$Slot]
    if ($Pointer -lt 0) {
        $MissingKnownKeys.Add($Key)
        continue
    }
    $Function = ConvertTo-UInt32 $BucketTable[$Pointer + 1]
    $SecondaryHash = Get-OptimizedTranslationHash $Function $Key
    $Identity = '{0}|{1}' -f $Slot, $SecondaryHash
    if (-not $EntryByIdentity.ContainsKey($Identity)) {
        $MissingKnownKeys.Add($Key)
        continue
    }
    $KnownByIdentity[$Identity] = $Key
}


function Get-Tokens {
    param([string]$Text)
    if ($null -eq $Text) { return @() }
    return @([regex]::Matches($Text, '%(?:[-+0#]*\d*(?:\.\d+)?[A-Za-z])|\{[^{}\r\n]+\}|\[/?[A-Za-z_][A-Za-z0-9_.:-]*(?:=[^\]]+)?\]') | ForEach-Object { $_.Value } | Sort-Object)
}

function Get-Classification {
    param([string]$English, [string]$Chinese)
    if ([string]::IsNullOrWhiteSpace($Chinese)) { return 'MISSING' }
    $EnglishTrimmed = $English.Trim()
    $ChineseTrimmed = $Chinese.Trim()
    $LooksLikeCode = $EnglishTrimmed -match '^(?:[A-Z]\d+|AI|N/A|OK|\d+(?:\.\d+)?)$'
    if (-not $LooksLikeCode -and $EnglishTrimmed.Length -ge 4 -and $EnglishTrimmed -ceq $ChineseTrimmed) { return 'UNTRANSLATED' }
    if ($Chinese -match [char]0xFFFD) { return 'SUSPICIOUS' }
    if (((Get-Tokens $English) -join [char]0) -cne ((Get-Tokens $Chinese) -join [char]0)) { return 'SUSPICIOUS' }
    return 'REVIEW'
}

$Inventory = New-Object 'System.Collections.Generic.List[object]'
for ($Index = 0; $Index -lt $Entries.Count; $Index++) {
    $Entry = $Entries[$Index]
    $Identity = '{0}|{1}' -f $Entry.slot, $Entry.secondary_hash
    $Chinese = [string]$Messages[$Index]
    if ($KnownByIdentity.ContainsKey($Identity)) {
        $Key = [string]$KnownByIdentity[$Identity]
        $RecoveredChinese = [string]$ReliableByKey[$Key].zh
        if ($RecoveredChinese -cne $Chinese) { throw "直接解压值与可靠恢复值不一致：$Key" }
        $Classification = Get-Classification $Key $Chinese
        $Status = 'pending'
        $Note = 'key 由 GDRETools 从当前 PCK 的资源字符串可靠恢复，并通过 OptimizedTranslation 哈希查找复核。'
        $English = $Key
    } else {
        $Key = 'HASH:{0:D4}:{1:X8}' -f $Entry.slot, $Entry.secondary_hash
        $English = ''
        $Classification = 'REVIEW'
        $Status = 'NEED_REVIEW'
        $Note = 'OptimizedTranslation 不保存源 key；当前 PCK 中没有可可靠匹配的英文原文。保留哈希身份与官方简中，不猜测 key。'
    }
    $Inventory.Add([pscustomobject][ordered]@{
        key = $Key
        english = $English
        official_chinese = $Chinese
        classification = $Classification
        custom_chinese = ''
        status = $Status
        note = $Note
    })
}

foreach ($Key in $MissingKnownKeys) {
    $Inventory.Add([pscustomobject][ordered]@{
        key = $Key
        english = $Key
        official_chinese = ''
        classification = 'MISSING'
        custom_chinese = ''
        status = 'pending'
        note = '英文 key 已可靠恢复，但简中 OptimizedTranslation 中不存在该 key。'
    })
}
$Inventory | Export-Csv -LiteralPath $InventoryPath -NoTypeInformation -Encoding UTF8

$Unresolved = @($Inventory | Where-Object { $_.status -eq 'NEED_REVIEW' })
$Unresolved | ForEach-Object {
    [pscustomobject][ordered]@{
        key = $_.key
        english = $_.english
        current_chinese = $_.official_chinese
        reason = '英文源 key 无法从 OptimizedTranslation 单向哈希中可靠恢复'
        suggested_action = '需要官方源 CSV 或精确英文 key 提示文件后再处理'
        status = 'NEED_REVIEW'
    }
} | Export-Csv -LiteralPath $ReviewPath -NoTypeInformation -Encoding UTF8

New-Item -ItemType Directory -Path $BatchDirectory | Out-Null
$Processable = @($Inventory | Where-Object { -not [string]::IsNullOrWhiteSpace($_.english) })
$Short = @($Processable | Where-Object { [Math]::Max($_.english.Length, $_.official_chinese.Length) -lt 240 })
$Long = @($Processable | Where-Object { [Math]::Max($_.english.Length, $_.official_chinese.Length) -ge 240 })
$BatchNumber = 1
foreach ($Group in @(@{ Rows = $Short; Size = 300 }, @{ Rows = $Long; Size = 150 })) {
    for ($Start = 0; $Start -lt $Group.Rows.Count; $Start += $Group.Size) {
        $End = [Math]::Min($Start + $Group.Size - 1, $Group.Rows.Count - 1)
        $BatchRows = @($Group.Rows[$Start..$End] | ForEach-Object {
            [pscustomobject][ordered]@{
                key = $_.key
                english = $_.english
                official_chinese = $_.official_chinese
                classification = $_.classification
                task = if ($_.classification -in @('MISSING', 'UNTRANSLATED')) { 'TRANSLATE' } else { 'REVIEW' }
                decision = ''
                custom_chinese = ''
                status = 'pending'
                note = ''
            }
        })
        $BatchName = 'batch_{0:D3}_input.csv' -f $BatchNumber
        $BatchRows | Export-Csv -LiteralPath (Join-Path $BatchDirectory $BatchName) -NoTypeInformation -Encoding UTF8
        $BatchNumber++
    }
}

$Counts = @{}
foreach ($Name in @('OK', 'MISSING', 'UNTRANSLATED', 'SUSPICIOUS', 'REVIEW')) {
    $Counts[$Name] = @($Inventory | Where-Object classification -eq $Name).Count
}
$Status = [ordered]@{
    schema_version = 3
    project_phase = 'formal_translation'
    total_entries = $Inventory.Count
    parsed_entries = $ReliableByKey.Count
    missing = $Counts.MISSING
    untranslated = $Counts.UNTRANSLATED
    suspicious = $Counts.SUSPICIOUS
    review = $Counts.REVIEW
    keep = 0
    improve = 0
    translated = 0
    validated = 0
    remaining = $Processable.Count
    current_batch = if ($BatchNumber -gt 1) { 'batch_001' } else { $null }
    completed_batches = @()
    total_batches = $BatchNumber - 1
    unresolved_entries = $Unresolved.Count
    source_locale = 'zh'
    traditional_chinese_in_scope = $false
    last_updated = (Get-Date).ToString('o')
}
[IO.File]::WriteAllText($StatusPath, ($Status | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

Write-Host "inventory：$($Inventory.Count) 条"
Write-Host "可靠英文 key：$($ReliableByKey.Count) 条"
Write-Host "未解析 key：$($Unresolved.Count) 条"
Write-Host "翻译批次：$($BatchNumber - 1) 批"
