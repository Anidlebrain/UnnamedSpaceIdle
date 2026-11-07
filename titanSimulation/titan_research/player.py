"""Area-independent player inputs and source-derived candidate capacity."""
from .candidate import fields
from .catalog import LAYERS, integer, require
from .normalize import normalize


def prepare_player(catalog, data):
    fields(data, ('statistics', 'progress'), 'player')
    profile = normalize(catalog, data['statistics'])
    require(profile['array_calibration'] is not None,
            'Search requires reference_array_base_damage from the array core Base Damage')
    require(all(item['target'] == 'titan_damage' and item['hook'] == 'array'
                for item in profile['hook_only_sources_not_in_summary']),
            'New hook-only stat requires another reference reading')
    progress = data['progress']
    progress_fields = ('highest_sectors', 'umbra_sector_number', 'reintegration')
    fields(progress, (*progress_fields, 'galaxy12_unlocked'), 'progress',
           required=(*progress_fields, 'galaxy12_unlocked') if catalog.enemy_alignment else progress_fields)
    if 'galaxy12_unlocked' in progress:
        require(type(progress['galaxy12_unlocked']) is bool, 'galaxy12_unlocked must be true or false')
    fields(progress['highest_sectors'], LAYERS, 'highest_sectors')
    for layer, value in progress['highest_sectors'].items():
        integer(value, f'highest_sectors.{layer}', minimum=0)
    integer(progress['umbra_sector_number'], 'umbra_sector_number', minimum=0)
    require(type(progress['reintegration']) is bool, 'reintegration must be true or false')
    require(progress['highest_sectors']['surface'] >= 160, 'Titan requires surface sector 160+')
    require(progress['reintegration'] or progress['umbra_sector_number'] == 0,
            'Umbra boundary requires reintegration')
    guard_external_combat(catalog)
    return profile


def guard_external_combat(catalog):
    """Fail closed if a new source needs inputs beyond the supported aggregate stats.

    Current non-local Titan rate/regen effects are native abilities, whose lifetime
    is handled in Godot. There are no player-progression modifiers to those abilities.
    """
    local = {tier['upgrade'] for row in catalog.cores.values() for tier in row['tiers']}
    targets = {k for k in catalog.tables['stats'] if k.startswith(('titan_', 'array_'))}
    targets -= {'titan_damage', 'titan_max_shields', 'array_capacity', 'array_charge_rate'}
    abilities = {'TitanShieldBolster', 'TitanRapidFire', 'ColossalSiphon'}

    def walk(value, table, owner):
        if isinstance(value, dict):
            target = value.get('target', '')
            if value.get('modifier_type') is not None:
                require(not any(str(target).startswith(a + '_') for a in abilities),
                        f'Ability modifier now requires another input: {table}/{owner}/{target}')
                if target in targets:
                    require(table == 'core_milestones' or owner in local or
                            (table == 'abilities' and owner in abilities),
                            f'External combat modifier requires another input: {table}/{owner}/{target}')
            for child in value.values():
                walk(child, table, owner)
        elif isinstance(value, list):
            for child in value:
                walk(child, table, owner)
    for table, rows in catalog.tables.items():
        for owner, row in rows.items():
            walk(row, table, owner)


def check_access(player, region, mode):
    progress = player['progress']
    layer, sector = region['layer'], region['sector']
    require(sector <= progress['highest_sectors'][layer], 'Selected sector has not been reached in this layer')
    boundary = progress['umbra_sector_number']
    require((sector < boundary) == (layer == 'umbra'),
            'Effective layer mismatch: sectors below umbra_sector_number are Umbra; the boundary itself is not')
    if mode == 'boss_once' and layer in ('antumbra', 'penumbra'):
        require(progress['highest_sectors']['surface'] > sector,
                'This layer boss requires the surface to have reached the next sector')


def capacity(catalog, profile, layer):
    value = profile['capacity_before_array_core_milestones_and_layer']
    for rows in catalog.milestones('TitanArray', profile['core_level_caps']['TitanArray']).values():
        for effect in rows[0]['effect']:
            if effect['target'] == 'array_capacity':
                value += effect['base_effect']
    return value * profile['layer_multipliers'][layer]['capacity']


def native_input(player, profile, region, candidate, mode, distance, seed, seconds,
                 minimum_seconds=None, minimum_cycles=None):
    progress = player['progress']
    result = dict(candidate=candidate, profile=profile, layer=region['layer'],
                  layer_id=LAYERS[region['layer']], sector=region['sector'], sector_id=region['sector_id'],
                  distance=distance, mode=mode, seed=seed, simulation_seconds=seconds,
                  highest_surface=progress['highest_sectors']['surface'],
                  highest_sectors=[progress['highest_sectors'][k] for k in LAYERS],
                  umbra_sector_number=progress['umbra_sector_number'], reintegration=progress['reintegration'],
                  galaxy12_unlocked=progress.get('galaxy12_unlocked', False),
                  # All three early reinforcement tiers are prerequisites of this Titan research scope.
                  prior_reinforcements=['R1Basic', 'R2Basic', 'R3Basic'])
    if minimum_seconds is not None:
        result.update(minimum_seconds=minimum_seconds, minimum_cycles=minimum_cycles)
    return result
