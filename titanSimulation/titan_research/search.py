"""Anytime native search. Only completed trials can become recommendations."""
from copy import deepcopy
import json
import math
import random
import time

from .generate import Candidates
from .player import native_input


def stable(battle, distance, seconds, cycles):
    samples = battle.get('cycle_shield_fractions', [])
    # Short screens only rank candidates. Long acceptance also rejects visible
    # cumulative shield depletion between the last two groups of three cycles.
    no_depletion = (cycles < 6 or (len(samples) >= cycles and
                    min(samples[-3:]) >= min(samples[-6:-3]) - .002))
    return (no_depletion and battle.get('status') == 'NATIVE_SMOKE_ONLY' and battle.get('observation_complete') is True
            and battle.get('deaths') == 0 and battle.get('seconds', 0) >= seconds
            and battle.get('colossal_kills', 0) >= cycles
            and abs(battle.get('distance_min', -1) - distance) < .01
            and abs(battle.get('distance_max', -1) - distance) < .01)


def boss_score(battle):
    sections = [s for p in battle.get('parts', []) for s in p['sections'] if s['max_health'] > 0]
    remaining = sum(max(0, s['health']) / s['max_health'] for s in sections) / max(1, len(sections))
    return (1 - remaining if sections else 0, battle['seconds'], battle['minimum_shield_fraction'])


def optimize(catalog, player, profile, region, mode, worker, deadline, seed, publish,
             record, farm_seconds=120, farm_cycles=10, distance_step=20, boss_seconds=90):
    factory = Candidates(catalog, profile, region, seed)
    rng = random.Random(seed)
    starts = iter(factory.seeds())
    elites, seen, promising = [], set(), []
    result = dict(status='SEARCHING', mode=mode, region=region, best=None, trials=0,
                  validated_candidates=0, globally_optimal=False,
                  validation_policy=dict(seeds=3, minimum_seconds=farm_seconds,
                                         minimum_cycles=farm_cycles, distance_step=distance_step,
                                         maximum_tail_shield_drop=.002),
                  accuracy='Native source execution; not yet compared with this player in the live game')
    publish(result)
    bottom = int(math.floor(region['distance_start'])) + 1
    top = int(math.ceil(region['distance_end'])) - 1
    grid = sorted(set([bottom, top] + list(range(bottom, top + 1, distance_step))))
    # Coarse exploration followed by upward refinement; no monotonicity proof is assumed.
    coarse = [top, bottom] + [grid[round((len(grid) - 1) * f)] for f in (.5, .75, .25, .875, .625, .375, .125)]
    started = time.perf_counter()
    exploration_end = started + max(0, deadline - started) * .4
    trial_id = 0

    def evaluate(candidate, distance, phase, trial_seed, seconds, minimum=None, cycles=None):
        nonlocal trial_id
        request = native_input(player, profile, region, candidate, mode, distance, trial_seed, seconds, minimum, cycles)
        battle = worker.evaluate(request)
        trial_id += 1
        item = dict(trial=trial_id, phase=phase, candidate=deepcopy(candidate), distance=distance,
                    seed=trial_seed, battle=battle)
        record(item)
        result['trials'] += 1
        return item

    def validate(candidate, distance):
        checks = []
        # Disjoint from short-screen seeds; each run starts a fresh encounter and then
        # continues waves natively without resetting shields, cooldowns or array state.
        for index in range(3):
            holdout = (seed + 1000003 + index * 1000033) % 2147483648
            item = evaluate(candidate, distance, 'validation', holdout,
                            max(600, farm_seconds * 3), farm_seconds, farm_cycles)
            checks.append(item)
            if not stable(item['battle'], distance, farm_seconds, farm_cycles):
                return False
        result['validated_candidates'] += 1
        if result['best'] is None or distance > result['best']['distance']:
            result['best'] = dict(candidate=deepcopy(candidate), distance=distance, validation=checks)
            result['status'] = 'BEST_VALIDATED_DISTANCE_FOUND'
            publish(result)
        return True

    try:
        iteration = 0
        while time.perf_counter() < deadline:
            if mode == 'farm_distance' and time.perf_counter() >= exploration_end and promising:
                break
            if iteration % 3 == 0 or not elites:
                candidate = next(starts, None)
                if candidate is None:
                    candidate = factory.create(randomize=True)
            elif rng.random() < .85:
                candidate = factory.mutate(rng.choice(elites[:6])[1])
            else:
                candidate = factory.create(randomize=True)
            if mode == 'boss_once':
                distance = region['distance_end']
            elif promising and iteration % 2:
                prior = max(promising, key=lambda p: p['distance'])
                higher = [d for d in grid if d > prior['distance']]
                distance = higher[len(higher) // 2] if higher else top
                if iteration % 4 == 1:
                    candidate = deepcopy(prior['candidate'])
            else:
                distance = coarse[iteration % len(coarse)]
            iteration += 1
            key = json.dumps([candidate, distance], sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            item = evaluate(candidate, distance, 'screen', seed,
                            boss_seconds if mode == 'boss_once' else 90,
                            None if mode == 'boss_once' else 30,
                            None if mode == 'boss_once' else 2)
            battle = item['battle']
            if mode == 'boss_once':
                if battle.get('boss_killed') is True:
                    result.update(status='KILL_FOUND', best=item)
                    publish(result)
                    return result
                score = boss_score(battle)
            else:
                passed = stable(battle, distance, 30, 2)
                score = (int(passed), distance if passed else battle['colossal_kills'],
                         battle['minimum_shield_fraction'], battle['seconds'])
                if passed:
                    promising.append(item)
                    # Nothing beyond this integer distance is inside the selected sector.
                    if distance == top and validate(candidate, distance):
                        result['tested_sector_ceiling'] = True
                        publish(result)
                        return result
            elites.append((score, candidate))
            elites.sort(key=lambda e: e[0], reverse=True)
            elites = elites[:12]
            result['screened_promising'] = len(promising)
            publish(result)
        if mode == 'farm_distance':
            attempted = set()
            for item in sorted(promising, key=lambda p: p['distance'], reverse=True):
                key = json.dumps([item['candidate'], item['distance']], sort_keys=True)
                if key in attempted:
                    continue
                attempted.add(key)
                if validate(item['candidate'], item['distance']):
                    break
        result['stop_reason'] = 'budget_or_candidate_schedule_finished'
    except TimeoutError:
        result['stop_reason'] = 'time_budget'
    except KeyboardInterrupt:
        result['stop_reason'] = 'cancelled'
    if result['best'] is None:
        result['status'] = 'NO_KILL_FOUND_WITHIN_BUDGET' if mode == 'boss_once' else 'NO_STABLE_RESULT_WITHIN_BUDGET'
    publish(result)
    return result
