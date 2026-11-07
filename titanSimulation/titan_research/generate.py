"""Bounded stochastic joint search space; combat scoring stays in Godot."""
from collections import Counter
from copy import deepcopy
import itertools
import random

from .candidate import check_candidate
from .catalog import require
from .player import capacity


class Candidates:
    def __init__(self, catalog, profile, region, seed):
        self.catalog, self.profile, self.region = catalog, profile, region
        self.rng = random.Random(seed)
        self.caps = profile['core_level_caps']
        self.ids = [w for w in ('TitanLaser', 'TitanCannon', 'TitanShockwaveCannon') if w in self.caps]
        self.targets = [p['id'] for p in region['array_targets']]
        self.capacity = capacity(catalog, profile, region['layer'])

    def core(self, core_id, randomize=False):
        choices = {}
        for threshold, rows in self.catalog.milestones(core_id, self.caps[core_id]).items():
            choices[threshold] = (self.rng.choice(rows) if randomize else rows[0])['id']
        entry = dict(id=core_id, level=self.caps[core_id], milestones=choices)
        if core_id in self.ids:
            entry['targeting'] = dict(type='Unarmored' if core_id == 'TitanLaser' else 'Armored',
                                     priority='Biggest Cluster' if core_id == 'TitanShockwaveCannon' else 'Highest Max HP',
                                     swapping='Change Target', overlap='Allow')
            if randomize:
                for key in entry['targeting']:
                    entry['targeting'][key] = self.rng.choice(self.target_options(entry, key))
        return entry

    def target_options(self, entry, key):
        values = list(self.catalog.targeting[key])
        weapon = self.catalog.tables['weapons'][self.catalog.cores[entry['id']]['weapon']]
        if key == 'priority' and weapon['aoe_size'] > 0:
            values += self.catalog.targeting['aoe_priority']
        return values

    def inventory(self, candidate):
        inventory = Counter()
        for entry in [*candidate['weapons'], candidate['shield'], candidate['array_core']]:
            row = self.catalog.cores[entry['id']]
            if row.get('titan_element'):
                inventory[row['titan_element']] += 1
            for threshold, rows in self.catalog.milestones(entry['id'], entry['level']).items():
                selected = entry['milestones'].get(threshold, rows[0]['id'])
                for effect in next(r for r in rows if r['id'] == selected)['effect']:
                    if effect['modifier_type'] == 'TitanElement':
                        inventory[effect['target']] += 1
        for key in inventory:
            if self.catalog.elements[key].get('ability_id'):
                inventory[key] = min(inventory[key], 1)
        return inventory

    def element(self, element_id, randomize=False):
        targets = []
        if self.catalog.elements[element_id].get('weapon_id'):
            targets = (self.rng.sample(self.targets, self.rng.randrange(len(self.targets) + 1))
                       if randomize else self.targets[:])
        return dict(id=element_id, targets=targets)

    def repair(self, candidate):
        inventory = self.inventory(candidate)
        rows = self.catalog.elements
        # Reserve one legal attack even if mutations filled the capacity with buffs.
        attacks = [e for e in candidate['sequence'] if rows[e['id']].get('weapon_id')
                   and inventory[e['id']] and rows[e['id']]['cost'] <= self.capacity]
        if not attacks:
            available = [k for k, n in inventory.items() if n and rows[k].get('weapon_id') and rows[k]['cost'] <= self.capacity]
            require(available, 'Array capacity cannot fit an unlocked attack element')
            attacks = [self.element(min(available, key=lambda k: rows[k]['cost']))]
            candidate['sequence'].insert(0, attacks[0])
        reserved = attacks[0]
        inventory[reserved['id']] -= 1
        remaining = self.capacity - rows[reserved['id']]['cost']
        sequence, reserved_done = [], False
        for entry in candidate['sequence']:
            if entry is reserved and not reserved_done:
                sequence.append(entry)
                reserved_done = True
                continue
            key = entry['id']
            if inventory[key] > 0 and rows[key]['cost'] <= remaining:
                sequence.append(entry)
                remaining -= rows[key]['cost']
                inventory[key] -= 1
        candidate['sequence'] = sequence
        check_candidate(self.catalog, self.region, candidate)
        return candidate

    def create(self, ids=None, randomize=False):
        ids = ids or [self.rng.choice(self.ids) for _ in range(3)]
        result = dict(weapons=[self.core(i, randomize) for i in ids], shield=self.core('TitanShield'),
                      array_core=self.core('TitanArray'), array_capacity=self.capacity, sequence=[])
        inventory = self.inventory(result)
        elements = list(inventory.elements())
        if randomize:
            self.rng.shuffle(elements)
        else:
            # Start with an attack and alternate buffs/attacks; mutations explore all orders.
            attacks = [k for k in elements if self.catalog.elements[k].get('weapon_id')]
            buffs = [k for k in elements if k not in attacks]
            elements = [e for pair in itertools.zip_longest(attacks, buffs) for e in pair if e]
        result['sequence'] = [self.element(k, randomize) for k in elements]
        return self.repair(result)

    def seeds(self):
        balanced = tuple(self.ids[i % len(self.ids)] for i in range(3))
        yield self.create(balanced)
        # Same slots, different branches, including array-providing milestones.
        yield self.mutate(self.create(balanced), force='branches')
        combos = list(itertools.product(self.ids, repeat=3))
        self.rng.shuffle(combos)
        for ids in combos:
            if ids != balanced:
                yield self.create(ids)

    def mutate(self, original, force=None):
        result = deepcopy(original)
        operation = force or self.rng.choice(('weapon', 'branch', 'target', 'add', 'remove', 'order', 'shot_targets'))
        weapon = self.rng.choice(result['weapons'])
        if operation == 'weapon':
            result['weapons'][self.rng.randrange(3)] = self.core(self.rng.choice(self.ids), randomize=True)
        elif operation in ('branch', 'branches'):
            entries = result['weapons'] if operation == 'branches' else [weapon]
            for entry in entries:
                groups = [(k, rows) for k, rows in self.catalog.milestones(entry['id'], entry['level']).items() if len(rows) > 1]
                if groups:
                    selected = groups if operation == 'branches' else [self.rng.choice(groups)]
                    for key, rows in selected:
                        entry['milestones'][key] = self.rng.choice([r['id'] for r in rows if r['id'] != entry['milestones'][key]])
        elif operation == 'target':
            key = self.rng.choice(list(weapon['targeting']))
            weapon['targeting'][key] = self.rng.choice(self.target_options(weapon, key))
        elif operation == 'add':
            inventory = self.inventory(result) - Counter(e['id'] for e in result['sequence'])
            if inventory:
                element = self.element(self.rng.choice(list(inventory)), True)
                result['sequence'].insert(self.rng.randrange(len(result['sequence']) + 1), element)
                # Make room when full; subsequent repair protects one attack.
                if sum(self.catalog.elements[e['id']]['cost'] for e in result['sequence']) > self.capacity:
                    others = [e for e in result['sequence'] if e is not element]
                    if others:
                        result['sequence'].remove(self.rng.choice(others))
        elif operation == 'remove' and len(result['sequence']) > 1:
            result['sequence'].pop(self.rng.randrange(len(result['sequence'])))
        elif operation == 'order':
            self.rng.shuffle(result['sequence'])
        elif operation == 'shot_targets':
            shots = [e for e in result['sequence'] if self.catalog.elements[e['id']].get('weapon_id')]
            shot = self.rng.choice(shots)
            shot['targets'] = self.element(shot['id'], True)['targets']
        return self.repair(result)
