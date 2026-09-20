param(
    [string]$DataPath = (Join-Path $PSScriptRoot "..\work\recovered_data\game_data.cdb"),
    [string]$JsonPath = (Join-Path $PSScriptRoot "..\results\fleet_loadout_catalog.json"),
    [string]$MarkdownPath = (Join-Path $PSScriptRoot "..\results\fleet_loadout_catalog.md")
)

$ErrorActionPreference = "Stop"
$shipIds = @("Fighter", "Corvette", "Frigate", "Cruiser")
$slotNames = @("Primary", "Secondary", "Tertiary")
$statTypeNames = @("ADD", "MULTIPLY", "REPLACE", "ADDITIVE_MULTIPLY")

function Get-Array($value) {
    if ($null -eq $value) { return @() }
    return @($value)
}

function Get-PropertyValue($object, [string]$name) {
    $property = $object.PSObject.Properties[$name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-EffectSummary($mod, $weaponsById, $abilitiesById) {
    $parts = New-Object System.Collections.Generic.List[string]
    $weaponId = Get-PropertyValue $mod "weapon_override"
    if ($weaponId) {
        $weapon = $weaponsById[$weaponId]
        $weaponName = if ($weapon -and $weapon.name) { $weapon.name } elseif ($weapon -and $weapon.description) { $weapon.description } else { $weaponId }
        $parts.Add("Weapon override: $weaponName ($weaponId)")
    }
    $abilityId = Get-PropertyValue $mod "ability_override"
    if ($abilityId) {
        $ability = $abilitiesById[$abilityId]
        $abilityName = if ($ability) { $ability.name } else { $abilityId }
        $abilityDescription = if ($ability -and $ability.description) { ": $($ability.description)" } else { "" }
        $parts.Add("Ability override: $abilityName ($abilityId)$abilityDescription")
    }
    foreach ($change in (Get-Array (Get-PropertyValue $mod "stat_changes"))) {
        $type = [int]$change.type
        $typeName = if ($type -ge 0 -and $type -lt $statTypeNames.Count) { $statTypeNames[$type] } else { "UNKNOWN_$type" }
        $parts.Add("$($change.stat) $typeName $($change.amount)")
    }
    if ($parts.Count -eq 0) { return "No direct stat/override record" }
    return ($parts -join "; ")
}

function Escape-MarkdownCell([string]$text) {
    if ($null -eq $text) { return "" }
    return (($text -replace "[\r\n]+", "<br>").Replace("|", "\|"))
}

$data = Get-Content -Raw -LiteralPath $DataPath | ConvertFrom-Json
$sheets = @{}
foreach ($sheet in (Get-Array $data.sheets)) {
    $sheets[$sheet.name] = Get-Array $sheet.lines
}

$modsById = @{}
foreach ($mod in $sheets["fleet_mods"]) { $modsById[$mod.id] = $mod }
$weaponsById = @{}
foreach ($weapon in $sheets["weapons"]) { $weaponsById[$weapon.id] = $weapon }
$abilitiesById = @{}
foreach ($ability in $sheets["fleet_abilities"]) { $abilitiesById[$ability.id] = $ability }
$upgradesById = @{}
foreach ($upgrade in (@($sheets["upgrades"]) + @($sheets["upgrades2"]))) { $upgradesById[$upgrade.id] = $upgrade }
$eventsByUpgrade = @{}
foreach ($event in $sheets["fleet_events"]) {
    $upgradeId = Get-PropertyValue $event "contribution_upgrade"
    if ($upgradeId) { $eventsByUpgrade[$upgradeId] = $event }
}

$standardSources = @{}
foreach ($upgrade in $upgradesById.Values) {
    foreach ($effect in (Get-Array (Get-PropertyValue $upgrade "effect"))) {
        if ($effect.modifier_type -ne "UnlockFleetShipMod") { continue }
        $targetParts = @($effect.target -split ":")
        if ($targetParts.Count -lt 2 -or $targetParts[0] -notin $shipIds) { continue }
        $shipId = $targetParts[0]
        $modId = $targetParts[1]
        if (-not $modsById.ContainsKey($modId)) { continue }
        $scope = if ($targetParts.Count -ge 3) { $targetParts[2] } else { "all" }
        $costs = @()
        foreach ($cost in (Get-Array (Get-PropertyValue $upgrade "cost"))) {
            $costs += [ordered]@{
                resource = $cost.resource
                base = $cost.cost_base
                growth = $cost.cost_growth
                type = $cost.type
            }
        }
        $event = $eventsByUpgrade[$upgrade.id]
        $entry = [ordered]@{
            ship = $shipId
            scope = $scope
            upgrade_id = $upgrade.id
            upgrade_name = $upgrade.name
            event_id = if ($event) { $event.id } else { $null }
            event_name = if ($event) { $event.long_name } else { $null }
            event_temporary = if ($event) { [bool]$event.upgrade_is_temporary } else { $false }
            cost = $costs
            direct_requires = Get-Array (Get-PropertyValue $upgrade "requires")
        }
        if (-not $standardSources.ContainsKey($modId)) { $standardSources[$modId] = @() }
        $standardSources[$modId] += $entry
    }
}

$utSources = @{}
foreach ($level in $sheets["unstable_transit"]) {
    $levelId = $level.id
    $levelShips = @()
    foreach ($playerShip in (Get-Array $level.player_ships)) {
        if ($playerShip.ship -in $shipIds) {
            $levelShips += $playerShip.ship
            foreach ($available in (Get-Array $playerShip.available_mods)) {
                $modId = $available.mod
                if (-not $modsById.ContainsKey($modId)) { continue }
                if (-not $utSources.ContainsKey($modId)) { $utSources[$modId] = @() }
                $utSources[$modId] += [ordered]@{
                    ship = $playerShip.ship
                    level = $levelId
                    source = "ship_pool"
                }
            }
        }
    }
    foreach ($universal in (Get-Array $level.universal_mods)) {
        $modId = $universal.mod
        if (-not $modsById.ContainsKey($modId)) { continue }
        foreach ($shipId in $levelShips) {
            if (-not $utSources.ContainsKey($modId)) { $utSources[$modId] = @() }
            $utSources[$modId] += [ordered]@{
                ship = $shipId
                level = $levelId
                source = "universal_pool"
            }
        }
    }
}

$allIds = @($standardSources.Keys + $utSources.Keys | Sort-Object -Unique)
$items = New-Object System.Collections.Generic.List[object]
foreach ($modId in $allIds) {
    $mod = $modsById[$modId]
    $standard = Get-Array $standardSources[$modId]
    $ut = Get-Array $utSources[$modId]
    $ships = @($standard.ship + $ut.ship | Sort-Object -Unique)
    $slotNumber = [int]$mod.slot
    $requiredMod = Get-PropertyValue $mod "required_mod"
    $statChanges = @()
    foreach ($change in (Get-Array (Get-PropertyValue $mod "stat_changes"))) {
        $type = [int]$change.type
        $statChanges += [ordered]@{
            stat = $change.stat
            operation = if ($type -ge 0 -and $type -lt $statTypeNames.Count) { $statTypeNames[$type] } else { "UNKNOWN_$type" }
            operation_code = $type
            amount = $change.amount
        }
    }
    $weaponId = Get-PropertyValue $mod "weapon_override"
    $weapon = if ($weaponId) { $weaponsById[$weaponId] } else { $null }
    $abilityId = Get-PropertyValue $mod "ability_override"
    $ability = if ($abilityId) { $abilitiesById[$abilityId] } else { $null }
    $standardScopes = @($standard.scope | Sort-Object -Unique)
    $standardAvailable = $standard.Count -gt 0
    $scopeLabel = if (-not $standardAvailable) { "none" } elseif ($standardScopes -contains "all") { "all standard galaxies" } else { "only " + ($standardScopes -join ", ") }
    $utByShip = @{}
    foreach ($shipId in $ships) {
        $entries = @($ut | Where-Object { $_.ship -eq $shipId })
        if ($entries.Count -gt 0) {
            $utByShip[$shipId] = [ordered]@{
                levels = @($entries.level | Sort-Object -Unique)
                source_types = @($entries.source | Sort-Object -Unique)
            }
        }
    }
    $standardClassification = if ($standardScopes -contains "all") { "standard_galaxy_all" } else { "standard_galaxy_scoped" }
    $classification = if ($standardAvailable -and $ut.Count -gt 0) {
        "$standardClassification`_and_unstable_transit"
    } elseif ($standardAvailable) {
        $standardClassification
    } else {
        "unstable_transit_only"
    }
    $items.Add([ordered]@{
        id = $modId
        ui_name = $mod.description
        applicable_ships = $ships
        slot = $slotNames[$slotNumber]
        slot_code = $slotNumber
        classification = $classification
        effect_summary = Get-EffectSummary $mod $weaponsById $abilitiesById
        effect = [ordered]@{
            weapon_override = if ($weaponId) { [ordered]@{ id = $weaponId; ui_name = $(if ($weapon -and $weapon.name) { $weapon.name } elseif ($weapon -and $weapon.description) { $weapon.description } else { $weaponId }); description = $weapon.description } } else { $null }
            ability_override = if ($abilityId) { [ordered]@{ id = $abilityId; ui_name = $ability.name; description = $ability.description } } else { $null }
            stat_changes = $statChanges
        }
        unlock_prerequisites = [ordered]@{
            required_mod = $requiredMod
            standard_unlocks = $standard
            unstable_transit = [ordered]@{
                available = ($ut.Count -gt 0)
                by_ship = $utByShip
                note = if ($ut.Count -gt 0) { "Offered through the listed UT reward pools; availability is still subject to reward rolls, slot replacement, rarity, and required_mod checks." } else { $null }
            }
        }
        standard_galaxy_available = $standardAvailable
        standard_galaxy_scope = $scopeLabel
        tertiary_always_active_in_standard_galaxy = ($slotNumber -eq 2 -and $standardAvailable)
        ut_rarity_code = $mod.ut_rarity
        ut_limit_per_ship = $mod.ut_limit_per_ship
    })
}

$orderedItems = @($items | Sort-Object @{ Expression = { switch ($_.classification) { "standard_galaxy" { 0 }; "standard_and_unstable_transit" { 1 }; default { 2 } } } }, slot_code, id)
$catalog = [ordered]@{
    catalog_version = 1
    game_version = "0.85.1.0"
    generated_from = [ordered]@{
        game_data = "fleetSimulation/work/recovered_data/game_data.cdb"
        fleet_code = @(
            "fleet/Fleet.gd:get_fleet_ships_available",
            "fleet/Fleet.gd:get_ship_mods",
            "fleet/RogueLikeManager.gd:UT reward pool selection",
            "fleet/FleetShipInfoPanel.gd:slot display"
        )
    }
    scope_notes = @(
        "Standard Galaxy entries are derived from UnlockFleetShipMod upgrade effects for Fighter, Corvette, Frigate, and Cruiser.",
        "A standard scope of all means the source unlock stores target all; a galaxy id means Fleet only exposes it while viewing that Galaxy.",
        "UT-only entries are derived from unstable_transit player_ships.available_mods and universal_mods. They are eligible reward-pool entries, not a claim that a player owns them.",
        "Primary and Secondary occupy selected slots. Standard-Galaxy Tertiary Mods are automatically added by Fleet.get_ship_mods when their scope matches the active galaxy.",
        "No player save was read; this catalog describes version capability and prerequisites only."
    )
    item_count = $orderedItems.Count
    items = $orderedItems
}

$json = $catalog | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($JsonPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

$markdown = New-Object System.Collections.Generic.List[string]
$markdown.Add("# Fleet Loadout / Mod Catalog (0.85.1.0)")
$markdown.Add("")
$markdown.Add("Generated from the recovered original game_data.cdb and Fleet source. It describes version-level eligibility only; it does not inspect or infer player unlocks.")
$markdown.Add("")
$markdown.Add("Slots: Primary and Secondary are selected slots. A standard-Galaxy Tertiary Mod is automatically applied when its stored scope matches the active galaxy. UT entries are reward-pool candidates and remain subject to roll, rarity, slot replacement, and any listed prerequisite Mod.")
$markdown.Add("")
foreach ($section in @(
    [ordered]@{ title = "Standard Galaxy - persistent / all-galaxy"; filter = { $_.standard_galaxy_available -and $_.standard_galaxy_scope -eq "all standard galaxies" } },
    [ordered]@{ title = "Standard Galaxy - galaxy-scoped"; filter = { $_.standard_galaxy_available -and $_.standard_galaxy_scope -ne "all standard galaxies" } },
    [ordered]@{ title = "Unstable Transit only"; filter = { -not $_.standard_galaxy_available -and $_.unlock_prerequisites.unstable_transit.available } }
)) {
    $sectionItems = @($orderedItems | Where-Object -FilterScript $section.filter)
    if ($sectionItems.Count -eq 0) { continue }
    $markdown.Add("## $($section.title)")
    $markdown.Add("")
    $markdown.Add("| ID | UI name | Ships | Slot | Effect | Unlock / prerequisite | Standard Galaxy |")
    $markdown.Add("|---|---|---|---|---|---|---|")
    foreach ($item in $sectionItems) {
        $standardUnlockText = @($item.unlock_prerequisites.standard_unlocks | ForEach-Object {
            $cost = @($_.cost | ForEach-Object { "$($_.base) $($_.resource)" }) -join ", "
            "event $($_.event_id) -> $($_.upgrade_id)" + $(if ($cost) { " ($cost)" } else { "" })
        }) -join "; "
        $utText = @($item.unlock_prerequisites.unstable_transit.by_ship.GetEnumerator() | Sort-Object Name | ForEach-Object {
            "$($_.Name): $($_.Value.levels -join ',')"
        }) -join "; "
        $prereqParts = @()
        if ($standardUnlockText) { $prereqParts += $standardUnlockText }
        if ($utText) { $prereqParts += "UT $utText" }
        if ($item.unlock_prerequisites.required_mod) { $prereqParts += "requires Mod $($item.unlock_prerequisites.required_mod)" }
        $prereqText = $prereqParts -join "; "
        $markdown.Add("| $(Escape-MarkdownCell $item.id) | $(Escape-MarkdownCell $item.ui_name) | $($item.applicable_ships -join ", ") | $($item.slot) | $(Escape-MarkdownCell $item.effect_summary) | $(Escape-MarkdownCell $prereqText) | $(Escape-MarkdownCell $item.standard_galaxy_scope) |")
    }
    $markdown.Add("")
}

$markdown.Add("## Source classification")
$markdown.Add("")
$markdown.Add("- Standard Galaxy: Fleet.get_fleet_ships_available() includes a Mod only when the ship's stored target is all or equals the active galaxy_in.")
$markdown.Add("- Unstable Transit: RogueLikeManager joins the selected ship's available_mods with the current level's universal_mods; required_mod, slot, rarity, and limit checks are applied before a reward is offered.")
$markdown.Add("- The JSON companion retains raw operation names/codes, overrides, upgrade costs, event IDs, level pools, and prerequisite Mod IDs.")
[System.IO.File]::WriteAllLines($MarkdownPath, $markdown, [System.Text.UTF8Encoding]::new($false))

Write-Output ("Generated {0} items" -f $orderedItems.Count)
