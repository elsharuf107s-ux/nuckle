#!/usr/bin/env python3
"""The Mart and villager arbitrage check (world update design 5.6). Exits 1 when the trades could print money.

Prices: tools/mcdata.py PRICES, with tools/villager_trades.py MART_PLAN over them (the prices the world update gives
emeralds and the new items; mcdata.py adopts them when trades are wired in). A Mart sells only what its stock lists
name (world.json's FireRed lists through src/mart.js FR_IDS, plus mart.js EXTRA and its fallback list), at `price`, and
buys anything with a price for `sell` or half the price, as src/mart.js salePrice does.

Conversions: everything that turns some items into others without yen, read from mcdata.py (the source items.json is
built from): crafting recipes (shaped and shapeless, n out per inputs), smelting (1:1, fuel free by default, which only
makes the check stricter), campfire cooking (1:1), breaking a placed block that drops something else (block drop x
dropN), and, where noted, the villager offers.

Checks, all at base prices (no demand, no discounts):
  rules    every offer is well formed (counts 1..64, uses > 0, xp >= 0, priceMul 0.05 or 0.2, every level 1..5 has an
           offer, offer ids unique per profession and level); no villager sells an eye of ender, a blaze rod or blaze
           powder; ender pearls only from the Master cleric; no Mart stocks an emerald; every item that compresses or
           uncompresses emeralds (a recipe whose only input is emeralds, or which makes emeralds from one other item)
           is priced in MART_PLAN at exactly its emeralds' worth, derived from the recipe, so it cannot drift.
  pump     "buy at a Mart for yen, convert, trade, convert, sell at a Mart": the cheapest yen cost of every item
           through Mart purchases and any chain of conversions and trades (a fixed point, multi-item costs included)
           is never below what a Mart pays for it. Any item that sells for more than it can be made for is a money
           pump and fails, with its chain.
  launder  "trade raw goods for emeralds, then get yen for the emeralds": for every offer paying emeralds, the best
           Mart value reachable from those emeralds through crafting, smelting and breaking (so an emerald block
           counts, not just the emerald's own sale price) is at most the Mart value of the goods given.
  loop     (generated worlds, design section 20) every item counts as what a Mart pays for it, an emerald as 32
           (Minecraft's own buys of 32 rotten flesh or 32 sticks fetch exactly that); anything a trade makes cheaper
           than that way (a villager's sale, or something crafted, smelted or broken out of one, such as a netherite
           helmet from a cheap diamond helmet) may not sell to a Mart for more than it costs: villager_trades.py
           GEN_SELL caps what a generated world's Mart pays for those items (Classic Marts keep their prices).
  report   (information, not a failure) the best Mart value of an emerald when villager sales are allowed too, and so
           the best "raw goods -> emerald -> villager goods -> Mart" ratio; maxUses per day and demand pricing bound
           it, and the pump check guarantees that no emerald bought with yen can use it.

  --current     use mcdata.py's prices as they are now, without MART_PLAN (fails today: an emerald sells for 1500)
  --fuel N      charge N yen per smelt (default 0)
  --suggest     print GEN_SELL as the loop family derives it (for tools/villager_trades.py)
  --selftest    also run negative controls (the design's replaced offers, an eye for sale, a pearl below Master, the
                emerald at 50 and at 3000, the emerald block at 27000, the hay route back), each must fail with the
                family named
  --json        print the result as JSON
"""
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import mcdata as D  # noqa: E402
import villager_trades as VT  # noqa: E402

HERE = Path(__file__).resolve().parent.parent
INF = math.inf


def mart_stock():
    """Every item a Mart can sell, read from the game's own sources."""
    js = (HERE / 'src' / 'mart.js').read_text()
    fr_ids = dict(re.findall(r"([A-Z_]+): '([a-z_]+)'", js.split('const EXTRA')[0].split('const FR_IDS')[1]))
    extra = js.split('const EXTRA')[1].split('};')[0]
    ids = set(re.findall(r"'([a-z_]+)'", extra))
    fallback = re.search(r"return all\.length \? \[\.\.\.new Set\(all\)\] : \[([^\]]*)\]", js)
    if fallback:
        ids |= set(re.findall(r"'([a-z_]+)'", fallback.group(1)))
    world = json.loads((HERE / 'assets' / 'world' / 'world.json').read_text())
    for lst in (world.get('marts') or {}).values():
        for k in lst:
            if k in fr_ids:
                ids.add(fr_ids[k])
    return ids


def price_table(current=False, plan=None, gen_sell=None):
    price, sell = {}, {}
    for k, it in D.ITEMS.items():
        if it.get('price'):
            price[k] = it['price']
        if it.get('sell') is not None:
            sell[k] = it['sell']
    for k, v in D.PRICES.items():
        price.setdefault(k, v)
    buyable_off = set()
    if not current:
        for k, p in (plan if plan is not None else VT.MART_PLAN).items():
            price[k] = p['price']
            if 'sell' in p:
                sell[k] = p['sell']
            if p.get('buyable') is False:
                buyable_off.add(k)
        # generated worlds' buy-back caps (design section 20); a cap never raises what a Mart pays
        for k, v in (VT.GEN_SELL if gen_sell is None else gen_sell).items():
            if k in price:
                sell[k] = min(v, sell.get(k, price[k] // 2))
    return price, sell, buyable_off


def offers(trades):
    for prof, levels in trades.items():
        for lvl, lst in levels.items():
            for i, o in enumerate(lst):
                yield prof, int(lvl), i, o


def fmt(o):
    a, na, b, nb, r, nr = o[:6]
    return f'{na} {a}' + (f' + {nb} {b}' if b else '') + f' -> {nr} {r}'


def recipe_inputs(r):
    if 'ins' in r:
        return Counter(r['ins'])
    return Counter(r['key'][ch] for row in r['rows'] for ch in row if ch != ' ')


def conversions(trades=None, fuel=0.0):
    """[(inputs Counter, output, n out, label, kind, extra yen)] for every item-to-item conversion the game has."""
    conv = []
    for r in D.RECIPES:
        c = recipe_inputs(r)
        conv.append((c, r['out'], r['n'], 'craft ' + ' + '.join(f'{n} {k}' for k, n in c.items()) + f' -> {r["n"]} {r["out"]}', 'craft', 0.0))
    for k, (o, _) in D.SMELT.items():
        conv.append((Counter({k: 1}), o, 1, f'smelt {k} -> {o}', 'smelt', fuel))
    for k, o in (getattr(D, 'CAMPFIRE', None) or {}).items():
        conv.append((Counter({k: 1}), o, 1, f'campfire {k} -> {o}', 'smelt', 0.0))
    for k, it in D.ITEMS.items():
        b = it.get('block') or {}
        if b.get('drop') and b['drop'] != k:
            n = b.get('dropN') or 1
            conv.append((Counter({k: 1}), b['drop'], n, f'place and break {k} -> {n} {b["drop"]}', 'break', 0.0))
    if trades is not None:
        for prof, lvl, i, o in offers(trades):
            a, na, b, nb, r, nr = o[:6]
            c = Counter({a: na})
            if b:
                c[b] += nb
            conv.append((c, r, nr, f'{prof} L{lvl}: {fmt(o)}', 'trade', 0.0))
    return conv


def emerald_forms():
    """Items that compress or uncompress emeralds, with their worth in emeralds, from the recipes."""
    out = {}
    for r in D.RECIPES:
        c = recipe_inputs(r)
        if set(c) == {'emerald'} and r['out'] != 'emerald':
            out[r['out']] = (c['emerald'] / r['n'], 'craft ' + f'{c["emerald"]} emerald -> {r["n"]} {r["out"]}')
        if r['out'] == 'emerald' and len(c) == 1:
            (k, n), = c.items()
            if k != 'emerald':
                out.setdefault(k, (r['n'] / n, f'craft {n} {k} -> {r["n"]} emerald'))
    return out


def cheapest(conv, price, stock, buy_off):
    """The cheapest yen cost of every item through Mart purchases and any chain of conversions. Returns (cost, how,
    converged)."""
    cost = {k: (price[k] if k in stock and k in price and k not in buy_off else INF) for k in set(price) | {c[1] for c in conv}}
    how = {k: ('mart', price[k]) for k, v in cost.items() if v < INF}
    for _ in range(400):
        changed = False
        for c, out, n, label, kind, extra in conv:
            tot = sum(m * cost.get(k, INF) for k, m in c.items()) + extra
            if tot / n < cost.get(out, INF) - 1e-9:
                cost[out] = tot / n
                how[out] = ('conv', label, dict(c))
                changed = True
        if not changed:
            return cost, how, True
    return cost, how, False


def best_value(conv, sale, items):
    """The most yen one item can fetch at a Mart, sold as it is or after any chain of the given conversions. The other
    inputs of a multi-input conversion are charged their own best value so far (what they would have fetched instead),
    so a loop such as "charcoal + logs + sticks -> campfire -> 2 charcoal" is valued as the logs it eats. Values only
    rise, so the result can only err high (stricter). Returns (value, how, converged)."""
    val = {k: float(sale(k)) for k in items}
    how = {}
    for _ in range(400):
        changed = False
        for c, out, n, label, kind, extra in conv:
            vo = val.get(out, float(sale(out)))
            for k, m in c.items():
                others = sum(mm * val.get(kk, float(sale(kk))) for kk, mm in c.items() if kk != k) + extra
                v = (n * vo - others) / m
                if v > val.get(k, 0.0) + 1e-9:
                    val[k] = v
                    how[k] = (label, out)
                    changed = True
        if not changed:
            return val, how, True
    return val, how, False


def loop_costs(conv, price, sale):
    """The `loop` family's costs (design section 20): every item counts as what a Mart pays for it (selling it instead
    would fetch that), emeralds included (Minecraft's own buys fetch exactly an emerald's 32 in raw goods), and the
    cheapest way to make each item through conversions is found twice, with the villagers' trades and without them.
    Returns (with trades, its chains, without trades, converged)."""
    base = {k: sale(k) for k in price if sale(k) > 0}
    base['emerald'] = sale('emerald')
    ct, ht, ok1 = cheapest(conv, base, set(base), set())
    cn, _, ok2 = cheapest([c for c in conv if c[4] != 'trade'], base, set(base), set())
    return ct, ht, cn, ok1 and ok2


def loop_flags(conv, price, sale):
    """Items a trade makes cheaper than they sell for: {item: (cap, cost, chain)}."""
    ct, ht, cn, ok = loop_costs(conv, price, sale)

    def chain(k, seen=()):
        if k not in ht or k in seen:
            return []
        h = ht[k]
        if h[0] == 'mart':
            return [f'{"an emerald" if k == "emerald" else k} worth {h[1]} at a Mart']
        out = []
        for q in h[2]:
            out += chain(q, seen + (k,))
        return out + [h[1]]
    out = {}
    for k, c in ct.items():
        if c < INF and sale(k) > c + 1e-9 and c < cn.get(k, INF) - 1e-9:
            out[k] = (math.floor(c + 1e-9), c, chain(k))
    return out, ok


def suggest(trades, fuel=0.0):
    """GEN_SELL as the loop family derives it: caps applied until no item is flagged (caps only fall, so it ends)."""
    caps = {}
    for _ in range(50):
        price, sell, _ = price_table(gen_sell=caps)
        sale = lambda k: sell[k] if k in sell else (price[k] // 2 if k in price else 0)
        fl, _ = loop_flags(conversions(trades, fuel), price, sale)
        if not fl:
            break
        for k, (cap, _, _) in fl.items():
            caps[k] = min(caps.get(k, INF), cap)
    return caps


def run(trades, current=False, plan_override=None, plan=None, fuel=0.0, stock_extra=(), gen_sell=None):
    price, sell_over, buy_off = price_table(current, plan, gen_sell)
    if plan_override:
        for k, v in plan_override.items():
            price[k] = v
    stock = mart_stock() | set(stock_extra)
    sale = lambda k: sell_over[k] if k in sell_over else (price[k] // 2 if k in price else 0)
    fails, notes = [], []
    # ---- rules
    for prof, levels in trades.items():
        for lvl in range(1, 6):
            if not levels.get(lvl) and not levels.get(str(lvl)):
                fails.append(f'rules: {prof} has no offer at level {lvl}')
    keys = Counter()
    for prof, lvl, i, o in offers(trades):
        a, na, b, nb, r, nr, uses, xp, mul = o[:9]
        tag = f'{prof} L{lvl} #{i} ({fmt(o)})'
        oid = o[9] if len(o) > 9 else None
        if not oid:
            fails.append(f'rules: {tag}: no offer id (saved uses and demand are keyed by it)')
        keys[(prof, lvl, oid)] += 1
        if not (1 <= na <= 64 and 1 <= nr <= 64 and (b is None or 1 <= nb <= 64)):
            fails.append(f'rules: {tag}: a count outside 1..64')
        if uses <= 0 or xp < 0 or mul not in (VT.MUL, VT.MUL_GEAR):
            fails.append(f'rules: {tag}: maxUses {uses}, xp {xp}, priceMul {mul}')
        if r in VT.NEVER_SOLD:
            fails.append(f'rules: {tag}: sells {r} (no path around the Nether)')
        if r == 'ender_pearl' and (prof, lvl) != tuple(VT.PEARL_ONLY):
            fails.append(f'rules: {tag}: ender pearls are only for the Master cleric')
        for k in (a, b, r):
            if k and k not in price:
                fails.append(f'rules: {tag}: {k} has no Mart price (every traded item needs a deliberate one)')
    for (prof, lvl, oid), n in keys.items():
        if n > 1:
            fails.append(f'rules: {prof} L{lvl}: offer id {oid} used {n} times')
    if 'emerald' in stock or ('emerald' not in buy_off and not current):
        fails.append('rules: a Mart may sell emeralds')
    if not current and 'emerald' in price:
        for k, (worth, how) in sorted(emerald_forms().items()):
            want = round(worth * price['emerald'])
            if price.get(k) != want:
                fails.append(f'rules: {k} ({how}) must be priced {want} (its emeralds at {price["emerald"]}), not {price.get(k)}: put it in MART_PLAN')
            if k in stock and k not in buy_off:
                fails.append(f'rules: a Mart may sell {k}, which holds emeralds')
    # ---- pump: cheapest yen cost of everything through Marts, conversions and trades
    conv_all = conversions(trades, fuel)
    cost, how, converged = cheapest(conv_all, price, stock, buy_off)
    if not converged:
        fails.append('pump: the cheapest costs keep falling (a chain of conversions and trades that multiplies items)')

    def chain(k, seen=()):
        if k not in how or k in seen:
            return []
        h = how[k]
        if h[0] == 'mart':
            return [f'buy {k} at a Mart for {h[1]}']
        out = []
        for p in h[2]:
            out += chain(p, seen + (k,))
        return out + [h[1]]

    pumps = []
    for k, c in cost.items():
        if c < INF and sale(k) > c + 1e-9:
            pumps.append((sale(k) - c, k))
            fails.append(f'pump: {k} costs {c:.1f} yen through ' + ' ; '.join(chain(k)) + f', and a Mart pays {sale(k)}')
    # ---- loop (generated worlds, design section 20): no Mart, villager, craft or smelt loop makes money even from
    # emeralds earned with raw goods: an emerald counts as what a Mart pays for it, and nothing made from emeralds
    # (bought from a villager, then crafted, smelted or broken) may sell for more than the emeralds' worth
    flagged = {}
    if not current:
        fl, lok = loop_flags(conv_all, price, sale)
        if not lok:
            fails.append('loop: the cheapest costs keep falling with every item at its Mart value')
        for k, (cap, c, ch) in sorted(fl.items()):
            flagged[k] = cap
            fails.append(f'loop: {k} can be made for {c:.1f} yen of Mart value ({" ; ".join(ch)}), and a generated world\'s Mart pays {sale(k)}: '
                         f'GEN_SELL[{k!r}] must be at most {cap}')
    # ---- launder: raw goods -> emeralds -> (crafting) -> Mart
    items = set(price) | {c[1] for c in conv_all} | {k for c in conv_all for k in c[0]}
    conv_plain = [c for c in conv_all if c[4] != 'trade']
    val, vhow, vconv = best_value(conv_plain, sale, items)
    if not vconv:
        fails.append('launder: the best Mart values keep rising (a chain of conversions that multiplies items)')
    e_val = val.get('emerald', sale('emerald'))
    worst = []
    for prof, lvl, i, o in offers(trades):
        a, na, b, nb, r, nr = o[:6]
        if r != 'emerald':
            continue
        given = na * sale(a) + (nb * sale(b) if b else 0)
        got = nr * e_val
        worst.append((given - got, prof, lvl, fmt(o), given))
        if got > given + 1e-9:
            via = f' (through {vhow["emerald"][0]})' if 'emerald' in vhow else ''
            fails.append(f'launder: {prof} L{lvl} {fmt(o)}: the goods fetch {given} yen at a Mart, the emeralds {got:.0f}{via}')
    worst.sort()
    # ---- report: an emerald's best Mart value when villager sales count too
    val_t, vhow_t, _ = best_value(conv_all, sale, items)
    per = []
    for prof, lvl, i, o in offers(trades):
        a, na, b, nb, r, nr = o[:6]
        if a != 'emerald':
            continue
        extra = nb * sale(b) if b else 0
        per.append(((nr * val.get(r, sale(r)) - extra) / na, prof, lvl, fmt(o)))
    per.sort(reverse=True)
    raw = sorted((given, prof, lvl, f) for _, prof, lvl, f, given in worst)
    best_raw = raw[0] if raw else None
    e_cost = cost.get('emerald', INF)
    notes.append(f'emerald: a Mart pays {sale("emerald")} yen, best Mart value through crafting {e_val:.0f}; no Mart sells one'
                 + (' (but one does)' if 'emerald' in stock else '')
                 + (f'; the cheapest emerald bought with yen costs {e_cost:.0f} (' + ' ; '.join(chain('emerald')) + ')' if e_cost < INF else '; no chain turns yen into emeralds'))
    notes.append('tightest launder margins (goods value minus emerald value): ' + ', '.join(f'{p} L{l} {f} {m:+.0f}' for m, p, l, f, g in worst[:4]))
    notes.append('most yen per emerald through a sale resold at a Mart: ' + ', '.join(f'{p} L{l} {f} = {v:.0f}' for v, p, l, f in per[:4]))
    if best_raw and per:
        notes.append(f'so the cheapest emerald in raw goods ({best_raw[1]} L{best_raw[2]} {best_raw[3]}, worth {best_raw[0]} yen) turns into at most '
                     f'{val_t.get("emerald", 0):.0f} yen of villager goods: x{val_t.get("emerald", 0) / max(1, best_raw[0]):.1f}, capped by maxUses per day and demand pricing'
                     + (f'; an emerald bought with yen costs {e_cost:.0f}, at least that' if e_cost < INF else ''))
    if pumps:
        notes.append(f'{len(pumps)} pump(s), biggest +{max(pumps)[0]:.0f} yen on {max(pumps)[1]}')
    traded = {o[4] for *_, o in offers(trades)}
    finite = {k: round(v, 2) for k, v in cost.items() if v < INF and k in traded}
    return {'ok': not fails, 'fails': fails, 'notes': notes, 'stocked': sorted(stock), 'tradeCosts': finite,
            'emeraldCost': e_cost, 'emeraldValue': e_val, 'emeraldValueWithTrades': val_t.get('emerald', 0),
            'conversions': len(conv_all), 'offers': sum(1 for _ in offers(trades)), 'flagged': flagged,
            'genSell': {k: sale(k) for k in (VT.GEN_SELL if gen_sell is None else gen_sell) if k in price}}


def _copy(trades):
    return json.loads(json.dumps({p: {str(k): v for k, v in lv.items()} for p, lv in trades.items()}))


def _copy_add(t, prof, lvl, offer):
    t = _copy(t)
    t[prof][lvl].append(offer)
    return t


def selftest(fuel=0.0):
    """Negative controls: each must fail, and with a line of the family named (so a control cannot pass by failing
    for an unrelated reason)."""
    t = _copy(VT.TRADES)
    plan_without_block = {k: v for k, v in VT.MART_PLAN.items() if k != 'emerald_block'}
    no_ga = {k: v for k, v in VT.GEN_SELL.items() if k != 'golden_apple'}
    loose = {**VT.GEN_SELL, 'iron_helmet': VT.GEN_SELL['iron_helmet'] + 1}
    t1 = _copy(t); t1['farmer']['4'].append(VT.buy('wheat_seeds', 10, 4))
    t2 = _copy(t); t2['cartographer']['2'].append(VT.buy('glass', 11, 2))
    t3 = _copy(t); t3['fletcher']['5'].append(VT.sell(1, 'eye_of_ender', 1, 5))
    t4 = _copy(t); t4['librarian']['5'].append(VT.sell(5, 'ender_pearl', 1, 5))
    t5 = _copy(t); t5['farmer']['1'].append(VT.sell(1, 'bread', 6, 1, uses=16))    # same id as the bread offer
    controls = [
        ('design seeds offer (10 wheat seeds -> 1 emerald)', 'pump', run(t1, fuel=fuel)),
        ('design glass offer (11 glass -> 1 emerald), as it was before the buy-back caps', 'pump', run(t2, fuel=fuel, gen_sell={})),
        ('an eye of ender for sale', 'rules', run(t3, fuel=fuel)),
        ('a pearl below the Master cleric', 'rules', run(t4, fuel=fuel)),
        ('two offers with one id', 'rules', run(t5, fuel=fuel)),
        ("emerald at the design's 50 yen (price 100)", 'launder',
         run(t, plan_override={'emerald': 100, 'emerald_block': 900}, fuel=fuel)),
        ("emerald at today's mcdata price (3000), MART_PLAN otherwise applied", 'launder',
         run(t, plan_override={'emerald': 3000, 'emerald_block': 27000}, fuel=fuel)),
        ("emerald block at today's 27000 (MART_PLAN without its entry)", 'launder', run(t, plan=plan_without_block, fuel=fuel)),
        ('no generated-world buy-back caps (GEN_SELL empty: the hay route sells a golden apple at 1400)', 'pump', run(t, gen_sell={}, fuel=fuel)),
        ('the golden apple left out of GEN_SELL', 'loop', run(t, gen_sell=no_ga, fuel=fuel)),
        ('an iron helmet cap one yen too high', 'loop', run(t, gen_sell=loose, fuel=fuel)),
        ('a new cheap sale with no cap (1 emerald -> 4 iron ingots)', 'loop', run(_copy_add(t, 'armorer', '2', VT.sell(1, 'iron_ingot', 4, 2)), fuel=fuel)),
    ]
    out = {}
    for name, fam, res in controls:
        hit = [f for f in res['fails'] if f.startswith(fam + ':')]
        out[name] = {'family': fam, 'failed': bool(hit), 'first': hit[:2] or res['fails'][:2]}
    return out


def main():
    current = '--current' in sys.argv
    if '--suggest' in sys.argv:
        caps = suggest(VT.TRADES)
        print('GEN_SELL = {')
        print('    ' + ', '.join(f'{k!r}: {v}' for k, v in sorted(caps.items())) + ',')
        print('}')
        return
    fuel = float(sys.argv[sys.argv.index('--fuel') + 1]) if '--fuel' in sys.argv else 0.0
    res = run(VT.TRADES, current=current, fuel=fuel)
    out = {'main': res}
    if '--selftest' in sys.argv:
        out['controls'] = selftest(fuel)
    if '--json' in sys.argv:
        print(json.dumps(out, indent=1, default=str))
    else:
        print(f'trade_check: {res["offers"]} offers, {res["conversions"]} conversions, {"OK" if res["ok"] else "FAILED"}'
              + (' (prices as mcdata.py has them now)' if current else ' (with MART_PLAN)') + (f', smelting fuel {fuel} yen' if fuel else ''))
        for f in res['fails']:
            print('  FAIL', f)
        for n in res['notes']:
            print('  ', n)
        if 'controls' in out:
            print('negative controls (each must fail with a line of its family):')
            for k, v in out['controls'].items():
                print(f'  {"failed as it should" if v["failed"] else "DID NOT FAIL"} ({v["family"]}): {k}' + (f'\n      {v["first"][0]}' if v['first'] else ''))
    bad_controls = 'controls' in out and not all(v['failed'] for v in out['controls'].values())
    sys.exit(0 if res['ok'] and not bad_controls else 1)


if __name__ == '__main__':
    main()
