[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$InputPath,
    [Parameter(Mandatory = $true)] [string]$OutputPath,
    [Parameter(Mandatory = $true)] [string]$Key,
    [Parameter(Mandatory = $true)] [string]$Value
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) { throw "输入资源不存在：$InputPath" }
if (Test-Path -LiteralPath $OutputPath) { throw "输出资源已存在，拒绝覆盖：$OutputPath" }

function Get-Hash {
    param([uint32]$Seed, [string]$Text)
    [uint64]$Hash = $Seed
    if ($Hash -eq 0) { $Hash = 0x1000193 }
    foreach ($Byte in [Text.Encoding]::UTF8.GetBytes($Text)) {
        $Hash = ((($Hash * 0x1000193) -band 0xFFFFFFFFL) -bxor [uint64]$Byte)
    }
    return [uint32]$Hash
}

function ConvertTo-SignedInt32Text {
    param([uint32]$Value)
    if ([uint64]$Value -gt [int]::MaxValue) { return [string]([long]([uint64]$Value - 4294967296L)) }
    return [string]$Value
}

function ConvertTo-UInt32 {
    param([long]$Value)
    if ($Value -lt 0) { return [uint32]([uint64]($Value + 4294967296L)) }
    return [uint32]$Value
}

$Lines = [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $InputPath).Path)
$HashIndex = -1
$BucketIndex = -1
$StringsIndex = -1
for ($Index = 0; $Index -lt $Lines.Count; $Index++) {
    if ($Lines[$Index].StartsWith('hash_table = PackedInt32Array(', [StringComparison]::Ordinal)) { $HashIndex = $Index }
    elseif ($Lines[$Index].StartsWith('bucket_table = PackedInt32Array(', [StringComparison]::Ordinal)) { $BucketIndex = $Index }
    elseif ($Lines[$Index].StartsWith('strings = PackedByteArray("', [StringComparison]::Ordinal)) { $StringsIndex = $Index }
}
if ($HashIndex -lt 0 -or $BucketIndex -lt 0 -or $StringsIndex -lt 0) { throw 'OptimizedTranslation 三个数据属性不完整' }

$HashPrefix = 'hash_table = PackedInt32Array('
$BucketPrefix = 'bucket_table = PackedInt32Array('
$StringsPrefix = 'strings = PackedByteArray("'
$HashValues = New-Object 'System.Collections.Generic.List[string]'
$Lines[$HashIndex].Substring($HashPrefix.Length, $Lines[$HashIndex].Length - $HashPrefix.Length - 1).Split(', ') | ForEach-Object { $HashValues.Add($_) }
$BucketValues = New-Object 'System.Collections.Generic.List[string]'
$Lines[$BucketIndex].Substring($BucketPrefix.Length, $Lines[$BucketIndex].Length - $BucketPrefix.Length - 1).Split(', ') | ForEach-Object { $BucketValues.Add($_) }
$Base64 = $Lines[$StringsIndex].Substring($StringsPrefix.Length, $Lines[$StringsIndex].Length - $StringsPrefix.Length - 2)
$StringBytes = [Convert]::FromBase64String($Base64)

$PrimaryHash = Get-Hash 0 $Key
$Slot = [int]([uint64]$PrimaryHash % [uint64]$HashValues.Count)
$OldPointer = [long]$HashValues[$Slot]
$OldElements = New-Object 'System.Collections.Generic.List[string]'
$OldSize = 0
if ($OldPointer -ge 0) {
    if ($OldPointer + 1 -ge $BucketValues.Count) { throw "原桶指针越界：$OldPointer" }
    $OldSize = [int]$BucketValues[$OldPointer]
    $Function = ConvertTo-UInt32 ([long]$BucketValues[$OldPointer + 1])
    for ($Index = 0; $Index -lt $OldSize * 4; $Index++) {
        $OldElements.Add($BucketValues[$OldPointer + 2 + $Index])
    }
} else {
    $Function = [uint32]1
}
$SecondaryHash = Get-Hash $Function $Key
for ($Index = 0; $Index -lt $OldSize; $Index++) {
    if ((ConvertTo-UInt32 ([long]$OldElements[$Index * 4])) -eq $SecondaryHash) {
        throw "二级哈希碰撞，拒绝追加：slot=$Slot hash=$SecondaryHash"
    }
}
$Offset = $StringBytes.Length
$ValueBytes = [Text.Encoding]::UTF8.GetBytes($Value)
$Combined = New-Object byte[] ($StringBytes.Length + $ValueBytes.Length)
[Array]::Copy($StringBytes, 0, $Combined, 0, $StringBytes.Length)
[Array]::Copy($ValueBytes, 0, $Combined, $StringBytes.Length, $ValueBytes.Length)

$HashValues[$Slot] = [string]$BucketValues.Count
$BucketValues.Add([string]($OldSize + 1))
$BucketValues.Add((ConvertTo-SignedInt32Text $Function))
foreach ($Element in $OldElements) { $BucketValues.Add($Element) }
$BucketValues.Add((ConvertTo-SignedInt32Text $SecondaryHash))
$BucketValues.Add([string]$Offset)
$BucketValues.Add([string]$ValueBytes.Length)
$BucketValues.Add([string]$ValueBytes.Length)

$Lines[$HashIndex] = $HashPrefix + ($HashValues -join ', ') + ')'
$Lines[$BucketIndex] = $BucketPrefix + ($BucketValues -join ', ') + ')'
$Lines[$StringsIndex] = $StringsPrefix + [Convert]::ToBase64String($Combined) + '")'
[IO.File]::WriteAllLines([IO.Path]::GetFullPath($OutputPath), $Lines, (New-Object Text.UTF8Encoding($false)))

Write-Host "已追加 key：$Key"
Write-Host "主哈希槽：$Slot"
Write-Host "字符串池偏移：$Offset"
Write-Host "UTF-8 字节数：$($ValueBytes.Length)"
