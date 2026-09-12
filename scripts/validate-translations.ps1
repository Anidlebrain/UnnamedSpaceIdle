[CmdletBinding()]
param(
    [Parameter()]
    [string[]]$Path
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AllowedStatuses = @('untranslated', 'pending', 'translated', 'NEED_REVIEW', 'reviewed', 'approved', 'ignored', 'technical_test', 'KEEP', 'IMPROVE')
$Issues = New-Object 'System.Collections.Generic.List[string]'

if (-not $Path -or $Path.Count -eq 0) {
    $Path = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'translation\translations') -Filter '*.csv' -File | Select-Object -ExpandProperty FullName)
}

function Get-Tokens {
    param([string]$Text)
    if ($null -eq $Text) { return @() }
    $Pattern = '%(?:[-+0#]*\d*(?:\.\d+)?[A-Za-z])|\{[^{}\r\n]+\}|\[[A-Za-z_][A-Za-z0-9_.:-]*\]'
    return @([regex]::Matches($Text, $Pattern) | ForEach-Object { $_.Value } | Sort-Object)
}

function Get-TranslationColumn {
    param([string]$FileName)
    switch ($FileName) {
        'official_current.csv' { return 'official_chinese' }
        'custom.csv' { return 'custom_chinese' }
        'pending.csv' { return 'suggested_chinese' }
        'review.csv' { return 'current_chinese' }
        'test_patch.csv' { return 'test_chinese' }
        default { return $null }
    }
}

function Compare-TokenList {
    param([string[]]$Left, [string[]]$Right)
    return (($Left -join [char]0) -ceq ($Right -join [char]0))
}

$BbTags = @('color', 'b', 'i')

foreach ($InputPath in $Path) {
    try {
        $ResolvedPath = (Resolve-Path -LiteralPath $InputPath -ErrorAction Stop).Path
        $Rows = @(Import-Csv -LiteralPath $ResolvedPath -Encoding UTF8)
    } catch {
        $Issues.Add("[$InputPath] 无法读取 CSV：$($_.Exception.Message)")
        continue
    }

    $FileName = [System.IO.Path]::GetFileName($ResolvedPath)
    $TranslationColumn = Get-TranslationColumn $FileName
    $SeenKeys = @{}

    for ($Index = 0; $Index -lt $Rows.Count; $Index++) {
        $Row = $Rows[$Index]
        $Line = $Index + 2
        $Key = [string]$Row.key
        $English = [string]$Row.english
        $Chinese = if ($TranslationColumn) { [string]$Row.$TranslationColumn } else { '' }

        if ([string]::IsNullOrWhiteSpace($Key)) {
            $Issues.Add("[${FileName}:$Line] key 为空")
        } elseif ($SeenKeys.ContainsKey($Key)) {
            $Issues.Add("[${FileName}:$Line] key 重复：$Key（首次出现在第 $($SeenKeys[$Key]) 行）")
        } else {
            $SeenKeys[$Key] = $Line
        }

        if (-not [string]::IsNullOrWhiteSpace($English) -and $TranslationColumn -and [string]::IsNullOrWhiteSpace($Chinese)) {
            $Issues.Add("[${FileName}:$Line] 英文存在但 $TranslationColumn 为空：$Key")
        }

        $RowStatus = [string]$Row.status
        if (-not [string]::IsNullOrWhiteSpace($RowStatus) -and $AllowedStatuses -cnotcontains $RowStatus) {
            $Issues.Add("[${FileName}:$Line] status 非法：$RowStatus")
        }

        if (-not [string]::IsNullOrWhiteSpace($English) -and -not [string]::IsNullOrWhiteSpace($Chinese)) {
            $EnglishTokens = @(Get-Tokens $English)
            $ChineseTokens = @(Get-Tokens $Chinese)
            if (-not (Compare-TokenList $EnglishTokens $ChineseTokens)) {
                $Issues.Add("[${FileName}:$Line] 占位符不一致：$Key；原文=[$($EnglishTokens -join ', ')]，译文=[$($ChineseTokens -join ', ')]")
            }

            foreach ($Tag in $BbTags) {
                $OpenPattern = "\[$Tag(?:=[^\]]+)?\]"
                $ClosePattern = "\[/$Tag\]"
                $EnglishOpen = [regex]::Matches($English, $OpenPattern).Count
                $ChineseOpen = [regex]::Matches($Chinese, $OpenPattern).Count
                $EnglishClose = [regex]::Matches($English, $ClosePattern).Count
                $ChineseClose = [regex]::Matches($Chinese, $ClosePattern).Count
                if ($EnglishOpen -ne $ChineseOpen -or $EnglishClose -ne $ChineseClose) {
                    $Issues.Add("[${FileName}:$Line] [$Tag] 标签数量不一致：$Key")
                }
            }
        }
    }
}

if ($Issues.Count -eq 0) {
    Write-Host "翻译静态检查通过：已检查 $($Path.Count) 个 CSV 文件。"
    exit 0
}

Write-Host "翻译静态检查发现 $($Issues.Count) 个问题："
foreach ($Issue in $Issues) { Write-Host "- $Issue" }
exit 1
