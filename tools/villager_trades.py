#!/usr/bin/env python3
"""Villager trades (world update design 5.6): the data, as plain tables. build_villagers.py exports it to
assets/mc/villagers/trades.json, src/trades.js runs it and tools/trade_check.py proves it is no money pump.
Tuning a trade means editing a row here and rebuilding; no code changes.

An offer is [costA, nA, costB or None, nB, result, nR, maxUses, xp, priceMul] (design 5.6). Each profession has a pool
of offers per level (1 Novice .. 5 Master); a villager gets 2 offers of each level it has reached, chosen from that
level's pool by a hash of its id and the level (src/trades.js offersFor), so its offers never change and are not saved.

Where the design's first-pass table names an item the game will not have when trades land (a name tag, a compass) the
offer is replaced by an existing item at Minecraft's price for that level, never by an eye, a pearl or a blaze item.
Every change from the design's table is listed in CHANGES with its reason.
"""

LEVELS = [0, 10, 70, 150, 250]                      # villager xp needed for Novice, Apprentice, Journeyman, Expert, Master
LEVEL_NAMES = ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master']
OFFERS_PER_LEVEL = 2
PLAYER_XP = [3, 6]                                  # the player's xp orbs per trade (Minecraft: 3 to 6), plus 5 on a level-up
LEVEL_UP_PLAYER_XP = 5
RESTOCK_TIME = 2000                                 # ticks into the day, at the job site (design 5.5)

# Minecraft's villager xp per trade, by level: buying raw goods from the player, selling to the player
XP_BUY = [2, 10, 20, 30, 30]
XP_SELL = [1, 5, 10, 15, 30]
MUL = 0.05            # demand price multiplier of most offers
MUL_GEAR = 0.2        # food, tools, weapons and armor (design 5.6: "0.2 for food and tool offers")

FOOD = {'bread', 'apple', 'cooked_chicken', 'golden_apple', 'cooked_porkchop', 'cooked_mutton', 'cooked_beef', 'cooked_cod',
        'cooked_salmon', 'melon_slice'}
GEAR_WORDS = ('_helmet', '_chestplate', '_leggings', '_boots', '_sword', '_axe', '_pickaxe', '_shovel', '_hoe')
GEAR = {'bow', 'shears', 'fishing_rod'}


def _mul(result):
    return MUL_GEAR if result in FOOD or result in GEAR or result.endswith(GEAR_WORDS) else MUL


def buy(item, n, lvl, uses=16, xp=None, id=None):
    """The villager buys n of an item for one emerald."""
    return [item, n, None, 0, 'emerald', 1, uses, XP_BUY[lvl - 1] if xp is None else xp, MUL, id or f'buy_{item}']


def sell(em, result, n, lvl, uses=None, xp=None, plus=None, id=None):
    """The villager sells n of an item for em emeralds (plus an item, as the fisherman's cooking)."""
    if uses is None:
        uses = 3 if result.startswith('diamond_') else 12
    b, nb = plus if plus else (None, 0)
    return ['emerald', em, b, nb, result, n, uses, XP_SELL[lvl - 1] if xp is None else xp, _mul(result), id or f'sell_{result}']


def _table():
    T = {}
    T['farmer'] = {
        1: [buy('wheat', 20, 1), sell(1, 'bread', 6, 1, uses=16)],
        2: [buy('pumpkin', 6, 2, uses=12), sell(1, 'apple', 4, 2, uses=16)],
        3: [buy('melon', 4, 3, uses=12), sell(3, 'cooked_chicken', 18, 3)],
        4: [sell(1, 'sugar', 4, 4), sell(1, 'hay_block', 1, 4)],
        5: [sell(3, 'golden_apple', 1, 5)],
    }
    T['librarian'] = {
        1: [buy('paper', 24, 1), sell(9, 'bookshelf', 1, 1)],
        2: [buy('book', 4, 2, uses=12), sell(1, 'glass', 4, 2)],
        3: [sell(1, 'jack_o_lantern', 1, 3)],     # (7c) the lantern is not an item yet: see CHANGES
        4: [sell(1, 'book', 1, 4)],
        5: [sell(12, 'glowstone', 3, 5)],
    }
    T['cleric'] = {
        1: [buy('rotten_flesh', 32, 1), sell(1, 'redstone', 2, 1)],
        2: [buy('gold_ingot', 2, 2, uses=12), sell(3, 'potion', 1, 2)],
        3: [sell(1, 'lapis_lazuli', 1, 3), sell(6, 'super_potion', 1, 3)],
        4: [sell(8, 'revive', 1, 4)],
        5: [sell(5, 'ender_pearl', 1, 5, uses=12), sell(10, 'full_heal', 1, 5)],
    }
    T['armorer'] = {
        1: [buy('coal', 15, 1), sell(5, 'iron_helmet', 1, 1)],
        2: [buy('iron_ingot', 4, 2, uses=12), sell(9, 'iron_chestplate', 1, 2)],
        3: [sell(7, 'iron_leggings', 1, 3), sell(4, 'iron_boots', 1, 3)],
        4: [buy('diamond', 1, 4, uses=12), sell(19, 'diamond_leggings', 1, 4)],
        5: [sell(21, 'diamond_chestplate', 1, 5), sell(13, 'diamond_helmet', 1, 5)],
    }
    T['weaponsmith'] = {
        1: [buy('coal', 15, 1), sell(3, 'iron_axe', 1, 1)],
        2: [buy('iron_ingot', 4, 2, uses=12), sell(7, 'iron_sword', 1, 2)],
        3: [buy('flint', 24, 3, uses=12)],
        4: [buy('diamond', 1, 4, uses=12), sell(17, 'diamond_axe', 1, 4)],
        5: [sell(13, 'diamond_sword', 1, 5)],
    }
    T['toolsmith'] = {
        1: [buy('coal', 15, 1), sell(1, 'stone_axe', 1, 1), sell(1, 'stone_pickaxe', 1, 1)],
        2: [buy('iron_ingot', 4, 2, uses=12)],
        3: [buy('flint', 30, 3, uses=12), sell(3, 'iron_pickaxe', 1, 3)],
        4: [buy('diamond', 1, 4, uses=12), sell(4, 'iron_shovel', 1, 4)],
        5: [sell(13, 'diamond_pickaxe', 1, 5)],
    }
    T['butcher'] = {
        1: [buy('chicken', 14, 1), sell(1, 'cooked_porkchop', 6, 1, uses=16)],
        2: [buy('porkchop', 7, 2), buy('coal', 10, 2)],
        3: [buy('mutton', 7, 3), buy('beef', 10, 3)],
        4: [sell(1, 'cooked_mutton', 5, 4)],
        5: [sell(1, 'cooked_beef', 8, 5)],
    }
    T['fletcher'] = {
        1: [buy('stick', 32, 1), sell(1, 'arrow', 16, 1)],
        2: [buy('flint', 10, 2, uses=12), sell(2, 'bow', 1, 2)],
        3: [buy('string', 14, 3)],
        4: [buy('feather', 24, 4)],
        5: [sell(8, 'arrow', 64, 5)],
    }
    T['cartographer'] = {
        1: [buy('paper', 24, 1), sell(1, 'paper', 3, 1)],
        2: [sell(1, 'torch', 4, 2)],
        3: [sell(1, 'glass', 4, 3)],
        4: [sell(1, 'book', 1, 4)],
        5: [sell(8, 'bucket', 1, 5)],
    }
    T['leatherworker'] = {
        1: [buy('leather', 6, 1), sell(3, 'leather_leggings', 1, 1)],
        2: [sell(7, 'leather_chestplate', 1, 2), buy('flint', 9, 2, uses=12)],
        3: [sell(5, 'leather_helmet', 1, 3), sell(4, 'leather_boots', 1, 3)],
        4: [buy('leather', 6, 4, uses=12)],
        5: [sell(1, 'campfire', 1, 5)],
    }
    T['mason'] = {
        1: [buy('clay_ball', 10, 1), sell(1, 'brick', 10, 1)],
        2: [buy('stone', 20, 2), sell(1, 'chiseled_stone_bricks', 4, 2)],
        3: [buy('cobblestone', 16, 3), sell(1, 'stone_bricks', 4, 3)],
        4: [buy('sandstone', 12, 4, uses=12)],
        5: [sell(1, 'clay', 1, 5)],
    }
    T['shepherd'] = {
        1: [buy('white_wool', 18, 1), sell(2, 'shears', 1, 1)],
        2: [sell(1, 'white_wool', 1, 2, uses=16)],
        3: [sell(3, 'white_bed', 1, 3)],
        4: [sell(1, 'white_wool', 3, 4, uses=16)],
        5: [sell(2, 'white_bed', 3, 5)],
    }
    T['fisherman'] = {
        1: [buy('string', 20, 1), buy('coal', 10, 1)],
        2: [sell(1, 'cooked_cod', 6, 2, uses=16, plus=('cod', 6)), buy('cod', 15, 2)],
        3: [sell(1, 'cooked_salmon', 6, 3, uses=16, plus=('salmon', 6)), buy('salmon', 13, 3)],
        4: [sell(3, 'fishing_rod', 1, 4)],
        5: [sell(1, 'campfire', 1, 5)],
    }
    return T


TRADES = _table()

# Every departure from the design's first-pass table (5.6), with the reason.
CHANGES = [
    ('farmer', 4, '10 wheat seeds -> 1 emerald', '1 emerald -> 1 hay_block',
     'wheat seeds are sold at the Viridian Mart for 2 yen: an emerald for 20 yen, then 1 emerald -> 6 bread sells for 180 (trade_check money pump)'),
    ('librarian', 5, '20 emerald -> 1 name tag', '12 emerald -> 3 glowstone',
     'no name tag in the game; an existing item at a Master price (Minecraft\'s 4 emeralds a glowstone) that no lower level offers '
     '(the first replacement, 8 emerald -> 3 bookshelf, made the Novice 9 emerald bookshelf pointless)'),
    ('cartographer', 2, '11 glass -> 1 emerald', '1 emerald -> 4 torch',
     'glass is sold at the Celadon Dept. Store for 12 yen: an emerald for 132 yen, then 1 emerald -> 8 cooked beef sells for 400 (trade_check money pump)'),
    ('cartographer', 5, '8 emerald -> 1 compass', '8 emerald -> 1 bucket', 'no compass in the game; an existing item at the Master price'),
    ('librarian', 4, '1 emerald -> 1 book...', '1 emerald -> 1 book', 'the design\'s own fallback, kept as written'),
    ('librarian', 3, '5 emerald -> 1 lantern', '1 emerald -> 1 jack_o_lantern',
     '(stage 7c) no lantern item yet (its only Journeyman offer, so the level showed nothing): the existing light block at '
     'Minecraft\'s lantern price (1 emerald); put the lantern back when it becomes an item'),
    # (stage 7c) the leatherworker's four leather armor offers stay as written: leather armor is not an item yet (it needs
    # worn sheets for Steve and every co-op skin), so src/trades.js offersFor hides them without moving any pick, and they
    # appear on their own once the items exist
]

# Mart price changes to existing items the trades need (in MART_PLAN below), with the reason.
PRICE_CHANGES = [
    ('emerald', 3000, 64, 'a Mart pays 32: the most that keeps "raw goods -> emerald -> Mart" at or below selling the goods'),
    ('emerald_block', 27000, 576, 'nine emeralds\' worth, derived from the recipe (trade_check checks it): at 27000 nine '
     'emeralds bought for 288 yen of rotten flesh sold as a block for 13500'),
    # (stage 7c, the economy decision of design section 20: the hay block keeps its price of 100; GEN_SELL closes the
    # hay route instead, since every villager sale now resells for at most its emeralds at 32 each)
]

# Mart prices the world update needs (design 5.6: "Emeralds and every new item get deliberate Mart prices"). A Mart pays
# half the price (or `sell`). trade_check.py uses these over mcdata.PRICES; mcdata.py must adopt them when trades are
# wired in (stage 7c). 'buyable': False means no Mart may stock it.
#   emerald: 64, so a Mart pays 32. The design's first pass said 50, but at 50 four of Minecraft's own buy offers (32
#   rotten flesh, 32 sticks, 16 cobblestone, 9 flint) would pay more through an emerald than the goods fetch at a Mart;
#   32 is the highest sale price that keeps every "raw goods -> emerald -> Mart" path at or below selling the goods.
#   This changes a Classic Mart's price for an emerald (today 3000, so 1500 paid), which is the design's decision (5.6).
#   emerald_block: always nine emeralds' worth. mcdata.py PRICES must adopt it in the same change as the emerald (stage
#   7c), or nine cheap emeralds sell as a block for 13500; trade_check fails if any item that compresses or uncompresses
#   emeralds is not priced at its emeralds' worth here.
#   (stage 7c) These prices apply in generated worlds only (trades.json martGen, src/mart.js); a Classic Mart keeps every
#   price as it was (design section 20), and Classic has no villagers.
EMERALD_PRICE = 64
MART_PLAN = {
    'emerald': {'price': EMERALD_PRICE, 'buyable': False},
    'emerald_block': {'price': 9 * EMERALD_PRICE, 'buyable': False},      # nine emeralds (trade_check derives it)
    'melon': {'price': 30}, 'melon_slice': {'price': 4}, 'sugar': {'price': 8}, 'lantern': {'price': 60},
    'clay_ball': {'price': 8}, 'brick': {'price': 10}, 'clay': {'price': 32},    # 10 clay balls (40) >= an emerald (32)
    # leather armor at its leather's price (5, 8, 7, 4 leather at 40), so crafting it and selling it gains nothing
    'leather_helmet': {'price': 200}, 'leather_chestplate': {'price': 320}, 'leather_leggings': {'price': 280}, 'leather_boots': {'price': 160},
}

# What a Mart pays in a generated world for the items villagers sell cheaply (the economy decision, design section 20):
# an emerald is worth what a Mart pays for it (32: Minecraft's own buys, 32 rotten flesh or 32 sticks, fetch exactly
# that), so nothing a villager sells, nor anything crafted, smelted or broken out of it, may fetch more than its
# emeralds at 32 each. tools/trade_check.py's `loop` family derives the cap of every item (the cheapest way to make it
# from Mart purchases, trades and conversions, emeralds at 32) and fails when an item here is missing or above it;
# `trade_check.py --suggest` prints this table. Classic Marts never use it.
GEN_SELL = {
    'apple': 8, 'arrow': 2, 'bread': 5, 'brick': 3, 'cooked_beef': 4, 'cooked_chicken': 5, 'cooked_mutton': 6, 'cooked_porkchop': 5,
    'diamond_axe': 544, 'diamond_chestplate': 672, 'diamond_helmet': 416, 'diamond_leggings': 608, 'diamond_pickaxe': 416,
    'diamond_sword': 416, 'golden_apple': 96, 'hay_block': 32, 'iron_axe': 96, 'iron_boots': 128, 'iron_chestplate': 288,
    'iron_helmet': 160, 'iron_leggings': 224, 'iron_pickaxe': 96, 'leather_leggings': 96, 'potion': 96, 'redstone': 16,
    'redstone_block': 144, 'revive': 256, 'shears': 64, 'super_potion': 192, 'wheat': 3, 'white_bed': 21, 'white_wool': 10,
    # a villager's cheap diamond gear plus a netherite ingot (at its Mart value) at a smithing upgrade
    'netherite_axe': 4664, 'netherite_chestplate': 4792, 'netherite_helmet': 4536, 'netherite_leggings': 4728,
    'netherite_pickaxe': 4536, 'netherite_sword': 4536,
    # crafted from the cleric's cheap redstone
    'poke_ball': 42,
}


# never sold by any villager (design 5.6: no path around the Nether); ender pearls only by the Master cleric
NEVER_SOLD = ['eye_of_ender', 'blaze_rod', 'blaze_powder']
PEARL_ONLY = ('cleric', 5)


def export():
    return {
        'version': 1,
        'levels': LEVELS, 'levelNames': LEVEL_NAMES, 'offersPerLevel': OFFERS_PER_LEVEL,
        'playerXp': PLAYER_XP, 'levelUpPlayerXp': LEVEL_UP_PLAYER_XP, 'restockTime': RESTOCK_TIME,
        'fields': ['costA', 'nA', 'costB', 'nB', 'result', 'nR', 'maxUses', 'xp', 'priceMul', 'id'],
        'trades': {p: {str(l): offers for l, offers in lv.items()} for p, lv in TRADES.items()},
        'martPlan': MART_PLAN, 'priceChanges': PRICE_CHANGES,
        # the generated worlds' Mart prices (src/mart.js applies them only there): MART_PLAN's prices, and what a Mart
        # pays (MART_PLAN's `sell`, else half the price, then GEN_SELL's caps)
        'martGen': {'price': {k: p['price'] for k, p in MART_PLAN.items()},
                    'sell': {**{k: p.get('sell', p['price'] // 2) for k, p in MART_PLAN.items()}, **GEN_SELL}},
        'neverSold': NEVER_SOLD, 'pearlOnly': list(PEARL_ONLY),
    }
