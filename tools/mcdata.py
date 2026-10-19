#!/usr/bin/env python3
"""Minecraft's rules for Redstone, as data: items and blocks, tools, food, fuel, smelting, recipes and
mob drops. Values follow Java Edition (hardness, tool speeds and tiers, durability, food points and
saturation, fuel ticks, smelting XP). tools/build_minecraft.py renders an icon for every item and writes
this out as assets/mc/items.json for the game.

Icons: 'item:<texture>' is a flat item texture, 'block:<top>,<front>,<side>' an isometric block
icon, 'pret:<path>' a FireRed graphic (the Poké Balls), 'atlas:<index>' a Kanto world tile (assets/world,
so build the world first), 'custom:<name>' something built in code.
World looks: 'raised' blocks stand on land (top + front faces), 'sprite' things are drawn upright on
the ground (torches, flowers, saplings), 'fence', 'door', 'bed', 'chest' are models, 'frdoor' is a
FireRed house door standing on its own (closed, and swung open from the door's own animation frames).
"""
import json
from pathlib import Path

WORLD = Path(__file__).resolve().parent.parent / 'assets' / 'world' / 'world.json'

TIERS = {'wooden': dict(speed=2, tier=1, dur=59, dmg=4), 'stone': dict(speed=4, tier=2, dur=131, dmg=5),
         'iron': dict(speed=6, tier=3, dur=250, dmg=6), 'golden': dict(speed=12, tier=1, dur=32, dmg=4),
         'diamond': dict(speed=8, tier=4, dur=1561, dmg=7), 'netherite': dict(speed=9, tier=5, dur=2031, dmg=8)}
TOOL_DMG = {'sword': 0, 'axe': 3, 'pickaxe': -2, 'shovel': -1.5, 'hoe': -3}  # added to the tier's sword damage
TOOL_SPEED = {'sword': 1.6, 'axe': 0.9, 'pickaxe': 1.2, 'shovel': 1.0, 'hoe': 1.0}   # attacks per second

ITEMS = {}


def item(id, name, icon, **kw):
    ITEMS[id] = dict(name=name, icon=icon, stack=kw.pop('stack', 64), **kw)


# ---------------------------------------------------------------- blocks
B = lambda top, front=None, side=None: f'block:{top},{front or top},{side or front or top}'
item('oak_log', 'Oak Log', B('oak_log_top', 'oak_log'), block=dict(look='raised', top='oak_log_top', front='oak_log', hard=2.0, tool='axe', sound='wood'), fuel=300)
item('oak_planks', 'Oak Planks', B('oak_planks'), block=dict(look='raised', top='oak_planks', front='oak_planks', hard=2.0, tool='axe', sound='wood'), fuel=300)
item('cobblestone', 'Cobblestone', B('cobblestone'), block=dict(look='raised', top='cobblestone', front='cobblestone', hard=2.0, tool='pickaxe', need=1, sound='stone'))
item('stone', 'Stone', B('stone'), block=dict(look='raised', top='stone', front='stone', hard=1.5, tool='pickaxe', need=1, drop='cobblestone', sound='stone'))
item('stone_bricks', 'Stone Bricks', B('stone_bricks'), block=dict(look='raised', top='stone_bricks', front='stone_bricks', hard=1.5, tool='pickaxe', need=1, sound='stone'))
item('bricks', 'Bricks', B('bricks'), block=dict(look='raised', top='bricks', front='bricks', hard=2.0, tool='pickaxe', need=1, sound='stone'))
item('white_concrete', 'White Concrete', B('white_concrete'), block=dict(look='raised', top='white_concrete', front='white_concrete', hard=1.8, tool='pickaxe', need=1, sound='stone'))
item('blue_concrete', 'Blue Concrete', B('blue_concrete'), block=dict(look='raised', top='blue_concrete', front='blue_concrete', hard=1.8, tool='pickaxe', need=1, sound='stone'))
item('green_concrete', 'Green Concrete', B('green_concrete'), block=dict(look='raised', top='green_concrete', front='green_concrete', hard=1.8, tool='pickaxe', need=1, sound='stone'))
for _c, _n in (('lime', 'Lime'), ('orange', 'Orange'), ('purple', 'Purple'), ('pink', 'Pink'), ('light_blue', 'Light Blue'), ('yellow', 'Yellow'), ('light_gray', 'Light Gray')):
    item(f'{_c}_concrete', f'{_n} Concrete', B(f'{_c}_concrete'), block=dict(look='raised', top=f'{_c}_concrete', front=f'{_c}_concrete', hard=1.8, tool='pickaxe', need=1, sound='stone'))
item('sandstone', 'Sandstone', B('sandstone_top', 'sandstone'), block=dict(look='raised', top='sandstone_top', front='sandstone', hard=0.8, tool='pickaxe', need=1, sound='stone'))
item('dirt', 'Dirt', B('dirt'), block=dict(look='raised', top='dirt', front='dirt', hard=0.5, tool='shovel', sound='gravel'))
item('sand', 'Sand', B('sand'), block=dict(look='raised', top='sand', front='sand', hard=0.5, tool='shovel', sound='sand'))
item('glass', 'Glass', B('glass'), block=dict(look='raised', top='glass', front='glass', hard=0.3, drop=None, sound='glass', see=True))
item('white_wool', 'White Wool', B('white_wool'), block=dict(look='raised', top='white_wool', front='white_wool', hard=0.8, tool='shears', sound='cloth'))
item('crafting_table', 'Crafting Table', B('crafting_table_top', 'crafting_table_front', 'crafting_table_side'),
     block=dict(look='raised', top='crafting_table_top', front='crafting_table_front', hard=2.5, tool='axe', sound='wood', use='craft'), fuel=300)
item('furnace', 'Furnace', B('furnace_top', 'furnace_front', 'furnace_side'),
     block=dict(look='raised', top='furnace_top', front='furnace_front', lit='furnace_front_on', hard=3.5, tool='pickaxe', need=1, sound='stone', use='furnace'))
item('chest', 'Chest', 'custom:chest', block=dict(look='chest', hard=2.5, tool='axe', sound='wood', use='chest'), fuel=300)
item('tnt', 'TNT', B('tnt_top', 'tnt_side'), block=dict(look='raised', top='tnt_top', front='tnt_side', hard=0.0, sound='grass', use='tnt'))
item('bookshelf', 'Bookshelf', B('oak_planks', 'bookshelf'), block=dict(look='raised', top='oak_planks', front='bookshelf', hard=1.5, tool='axe', sound='wood'), fuel=300)
item('torch', 'Torch', 'item:torch', block=dict(look='sprite', tex='torch', hard=0.0, sound='wood', walk=True, light=14))
item('oak_door', 'Oak Door', 'item:oak_door', block=dict(look='door', hard=3.0, tool='axe', sound='wood', use='door'), fuel=200)
item('white_bed', 'White Bed', 'custom:bed', stack=1, block=dict(look='bed', hard=0.2, sound='wood', use='bed'))
item('oak_fence', 'Oak Fence', 'custom:fence:oak_planks', block=dict(look='fence', tex='oak_planks', hard=2.0, tool='axe', sound='wood'), fuel=300)
item('birch_fence', 'Birch Fence', 'custom:fence:birch_planks', block=dict(look='fence', tex='birch_planks', hard=2.0, tool='axe', sound='wood'), fuel=300)
item('oak_sign', 'Oak Sign', 'item:oak_sign', stack=16, block=dict(look='sign', hard=1.0, tool='axe', sound='wood', use='sign'), fuel=200)
item('oak_sapling', 'Oak Sapling', 'item:oak_sapling', block=dict(look='sprite', tex='oak_sapling', hard=0.0, sound='grass', walk=True, plant='grass'), fuel=100)
item('poppy', 'Poppy', 'item:poppy', block=dict(look='sprite', tex='poppy', hard=0.0, sound='grass', walk=True, plant='grass'))
item('dandelion', 'Dandelion', 'item:dandelion', block=dict(look='sprite', tex='dandelion', hard=0.0, sound='grass', walk=True, plant='grass'))
item('oak_leaves', 'Oak Leaves', 'block:oak_leaves,oak_leaves,oak_leaves', block=dict(look='raised', top='oak_leaves', front='oak_leaves', hard=0.2, tool='hoe', sound='grass', tint='leaf', see=True))
item('hay_block', 'Hay Bale', B('hay_block_top', 'hay_block_side'), block=dict(look='raised', top='hay_block_top', front='hay_block_side', hard=0.5, tool='hoe', sound='grass'))
item('pumpkin', 'Pumpkin', B('pumpkin_top', 'pumpkin_side'), block=dict(look='raised', top='pumpkin_top', front='pumpkin_side', hard=1.0, tool='axe', sound='wood'))
item('jack_o_lantern', "Jack o'Lantern", B('pumpkin_top', 'jack_o_lantern', 'pumpkin_side'), block=dict(look='raised', top='pumpkin_top', front='jack_o_lantern', hard=1.0, tool='axe', sound='wood', light=15))
for ore, drop_item in (('coal', 'coal'), ('iron', 'iron_ingot'), ('gold', 'gold_ingot'), ('diamond', 'diamond'), ('redstone', 'redstone'), ('lapis', 'lapis_lazuli'), ('emerald', 'emerald')):
    name = {'lapis': 'Lapis Lazuli'}.get(ore, ore.capitalize())
    item(f'{ore}_block', f'Block of {name}', B(f'{ore}_block'), block=dict(look='raised', top=f'{ore}_block', front=f'{ore}_block', hard=5.0, tool='pickaxe', need=1, sound='stone',
                                                                              light=7 if ore == 'redstone' else 0), fuel=16000 if ore == 'coal' else None)
item('copper_block', 'Block of Copper', B('copper_block'), block=dict(look='raised', top='copper_block', front='copper_block', hard=3.0, tool='pickaxe', need=2, sound='stone'))
# FireRed's house doors: one item per door style in Kanto (tools/build_world.py exports the styles). Mining a
# building's door gives its style; X opens and closes a placed one, and it fits back into a matching doorway.
for _d in json.load(open(WORLD))['doors'] if WORLD.exists() else []:
    item('door_' + _d['style'], _d['name'], f"atlas:{_d['closed']}",
         block=dict(look='frdoor', style=_d['style'], entry=_d['closed'], open=_d['open'], anim=_d['anim'], hard=3.0, tool='axe',
                    sound='wood' if _d['sound'] == 'door' else 'stone', use='door', slide=_d['sound'] == 'sliding'),
         **({'fuel': 200} if _d['sound'] == 'door' else {}))

# ---------------------------------------------------------------- materials
for id, name in (('stick', 'Stick'), ('coal', 'Coal'), ('charcoal', 'Charcoal'), ('raw_iron', 'Raw Iron'), ('iron_ingot', 'Iron Ingot'),
                 ('raw_gold', 'Raw Gold'), ('gold_ingot', 'Gold Ingot'), ('raw_copper', 'Raw Copper'), ('copper_ingot', 'Copper Ingot'), ('diamond', 'Diamond'), ('emerald', 'Emerald'), ('redstone', 'Redstone Dust'),
                 ('lapis_lazuli', 'Lapis Lazuli'), ('flint', 'Flint'), ('string', 'String'), ('feather', 'Feather'), ('leather', 'Leather'),
                 ('bone', 'Bone'), ('bone_meal', 'Bone Meal'), ('gunpowder', 'Gunpowder'), ('wheat', 'Wheat'), ('wheat_seeds', 'Wheat Seeds'),
                 ('egg', 'Egg'), ('stone_button', 'Stone Button'), ('arrow', 'Arrow')):
    kw = {}
    if id in ('coal', 'charcoal'):
        kw['fuel'] = 1600
    if id == 'stick':
        kw['fuel'] = 100
    if id == 'egg':
        kw['stack'] = 16
    icon = 'custom:button' if id == 'stone_button' else f'item:{id}'
    item(id, name, icon, **kw)
ITEMS['wheat_seeds']['plant'] = 'farmland'
ITEMS['bone_meal']['use'] = 'bonemeal'

# ---------------------------------------------------------------- tools and weapons
for t, tv in TIERS.items():
    if t == 'netherite':
        continue    # appended with the Nether items below, so the older icon indexes stay put
    for kind in ('sword', 'pickaxe', 'axe', 'shovel', 'hoe'):
        name = {'wooden': 'Wooden', 'stone': 'Stone', 'iron': 'Iron', 'golden': 'Golden', 'diamond': 'Diamond', 'netherite': 'Netherite'}[t] + ' ' + kind.capitalize()
        dmg = max(1, tv['dmg'] + TOOL_DMG[kind])
        item(f'{t}_{kind}', name, f'item:{t}_{kind}', stack=1, tool=dict(kind=kind, tier=tv['tier'], speed=tv['speed'], dur=tv['dur'], dmg=dmg, rate=TOOL_SPEED[kind], mat=t),
             fuel=200 if t == 'wooden' else None, **({'fireproof': True} if t == 'netherite' else {}))
item('shears', 'Shears', 'item:shears', stack=1, tool=dict(kind='shears', tier=0, speed=5, dur=238, dmg=1, rate=4, mat='iron'))
item('flint_and_steel', 'Flint and Steel', 'item:flint_and_steel', stack=1, tool=dict(kind='igniter', tier=0, speed=1, dur=64, dmg=1, rate=4, mat='iron'), use='ignite')
item('fishing_rod', 'Fishing Rod', 'item:fishing_rod', stack=1, tool=dict(kind='rod', tier=0, speed=1, dur=64, dmg=1, rate=4, mat='wood'), use='fish', fuel=300)
item('bow', 'Bow', 'item:bow', stack=1, tool=dict(kind='bow', tier=0, speed=1, dur=384, dmg=1, rate=1, mat='wood'), use='bow', fuel=300)
item('bucket', 'Bucket', 'item:bucket', stack=16, use='bucket')
item('water_bucket', 'Water Bucket', 'item:water_bucket', stack=1, use='pour')
item('milk_bucket', 'Milk Bucket', 'item:milk_bucket', stack=1, food=dict(hunger=0, sat=0, milk=True))
item('oak_boat', 'Oak Boat', 'item:oak_boat', stack=1, use='boat', fuel=1200)
# armor: points, durability, toughness and knockback resistance per piece (Java Edition)
ARMOR_MATS = {'iron': dict(name='Iron', tough=0, kb=0), 'diamond': dict(name='Diamond', tough=2, kb=0), 'netherite': dict(name='Netherite', tough=3, kb=0.1)}
def armor_set(mat, mv):
    for piece, pname, pts, d in (('helmet', 'Helmet', {'iron': 2, 'diamond': 3, 'netherite': 3}, {'iron': 165, 'diamond': 363, 'netherite': 407}),
                                 ('chestplate', 'Chestplate', {'iron': 6, 'diamond': 8, 'netherite': 8}, {'iron': 240, 'diamond': 528, 'netherite': 592}),
                                 ('leggings', 'Leggings', {'iron': 5, 'diamond': 6, 'netherite': 6}, {'iron': 225, 'diamond': 495, 'netherite': 555}),
                                 ('boots', 'Boots', {'iron': 2, 'diamond': 3, 'netherite': 3}, {'iron': 195, 'diamond': 429, 'netherite': 481})):
        item(f'{mat}_{piece}', f"{mv['name']} {pname}", f'item:{mat}_{piece}', stack=1, armor=dict(slot=piece, mat=mat, points=pts[mat], dur=d[mat], tough=mv['tough'], kb=mv['kb']),
             **({'fireproof': True} if mat == 'netherite' else {}))


armor_set('iron', ARMOR_MATS['iron'])
armor_set('diamond', ARMOR_MATS['diamond'])

# ---------------------------------------------------------------- food: hunger points, saturation
FOOD = {'apple': ('Apple', 4, 2.4), 'bread': ('Bread', 5, 6.0), 'beef': ('Raw Beef', 3, 1.8), 'cooked_beef': ('Steak', 8, 12.8),
        'porkchop': ('Raw Porkchop', 3, 1.8), 'cooked_porkchop': ('Cooked Porkchop', 8, 12.8), 'chicken': ('Raw Chicken', 2, 1.2),
        'cooked_chicken': ('Cooked Chicken', 6, 7.2), 'mutton': ('Raw Mutton', 2, 1.2), 'cooked_mutton': ('Cooked Mutton', 6, 9.6),
        'cod': ('Raw Cod', 2, 0.4), 'cooked_cod': ('Cooked Cod', 5, 6.0), 'salmon': ('Raw Salmon', 2, 0.4), 'cooked_salmon': ('Cooked Salmon', 6, 9.6),
        'rotten_flesh': ('Rotten Flesh', 4, 0.8), 'golden_apple': ('Golden Apple', 4, 9.6)}
for id, (name, h, s) in FOOD.items():
    item(id, name, f'item:{id}', food=dict(hunger=h, sat=s, **({'hungerEffect': 0.8} if id == 'rotten_flesh' else {}),
                                           **({'regen': 5, 'absorb': 4} if id == 'golden_apple' else {})))

# ---------------------------------------------------------------- Poké Balls (crafted Pixelmon-style from Minecraft materials)
item('poke_ball', 'Poké Ball', 'pret:graphics/interface/ball/poke.png', ball=dict(kind='poke', mult=10))
item('great_ball', 'Great Ball', 'pret:graphics/interface/ball/great.png', ball=dict(kind='great', mult=15))
item('ultra_ball', 'Ultra Ball', 'pret:graphics/interface/ball/ultra.png', ball=dict(kind='ultra', mult=20))

# FireRed medicine, sold at Poké Marts: FireRed's own icons, prices and descriptions. `med` is what it does:
# hp (points, or 'full'), cure (a status, or 'all'), revive.
_FR = {d['itemId']: d for d in json.load(open(Path(__file__).resolve().parent.parent / 'vendor' / 'pokefirered' / 'src' / 'data' / 'items.json'))['items']}
def _fr(id, fr_id, png, pal, name, **med):
    d = _FR[fr_id]
    item(id, name, f'fr:{png}:{pal}', price=d['price'], frName=d['english'], desc=d['description_english'].replace('\\n', '\n'), med=med)
_fr('potion', 'ITEM_POTION', 'potion', 'potion', 'Potion', hp=20)
_fr('super_potion', 'ITEM_SUPER_POTION', 'potion', 'super_potion', 'Super Potion', hp=50)
_fr('hyper_potion', 'ITEM_HYPER_POTION', 'potion', 'hyper_potion', 'Hyper Potion', hp=200)
_fr('max_potion', 'ITEM_MAX_POTION', 'large_potion', 'max_potion', 'Max Potion', hp='full')
_fr('full_restore', 'ITEM_FULL_RESTORE', 'large_potion', 'full_restore', 'Full Restore', hp='full', cure='all')
_fr('revive', 'ITEM_REVIVE', 'revive', 'revive', 'Revive', revive=True)
_fr('antidote', 'ITEM_ANTIDOTE', 'antidote', 'antidote', 'Antidote', cure='PSN')
_fr('paralyze_heal', 'ITEM_PARALYZE_HEAL', 'status_heal', 'paralyze_heal', 'Parlyz Heal', cure='PAR')
_fr('awakening', 'ITEM_AWAKENING', 'status_heal', 'awakening', 'Awakening', cure='SLP')
_fr('burn_heal', 'ITEM_BURN_HEAL', 'status_heal', 'burn_heal', 'Burn Heal', cure='BRN')
_fr('ice_heal', 'ITEM_ICE_HEAL', 'status_heal', 'ice_heal', 'Ice Heal', cure='FRZ')
_fr('full_heal', 'ITEM_FULL_HEAL', 'full_heal', 'full_heal', 'Full Heal', cure='all')
for _b, _id in (('poke_ball', 'ITEM_POKE_BALL'), ('great_ball', 'ITEM_GREAT_BALL'), ('ultra_ball', 'ITEM_ULTRA_BALL')):
    ITEMS[_b].update(price=_FR[_id]['price'], frName=_FR[_id]['english'], desc=_FR[_id]['description_english'].replace('\\n', '\n'))
# crafted balls are cheap to make, so a Mart pays little for them
ITEMS['poke_ball']['sell'], ITEMS['great_ball']['sell'], ITEMS['ultra_ball']['sell'] = 50, 70, 120

# the campfire: cooks up to four raw foods for free, lights the night, hurts to stand in (Java Edition)
item('campfire', 'Campfire', 'item:campfire', block=dict(look='campfire', hard=2.0, tool='axe', sound='wood', walk=True, use='campfire', drop='charcoal', dropN=2))

FIRST_NETHER = 'obsidian'    # everything from here on is the Nether's (tools/build_minecraft.py keeps older indexes stable)

# ---------------------------------------------------------------- the Nether's blocks (Java Edition hardness, tools and drops)
# `need` is the pickaxe tier that harvests it (1 wood, 2 stone, 3 iron, 4 diamond, 5 netherite). `dropN`..`dropMax` is
# a random count, `xp` the [min, max] orbs a mined ore gives, `slow` a walking-speed factor, `hurt` damage per second
# standing on it, `fireproof` items survive lava. Lava, the portal and soul fire are world blocks you never hold
# (`hidden`): they exist here for their looks, light and rules; lava and the portal animate at runtime (items.json anim).
item('obsidian', 'Obsidian', B('obsidian'), block=dict(look='raised', top='obsidian', front='obsidian', hard=50.0, tool='pickaxe', need=4, sound='stone'))
item('netherrack', 'Netherrack', B('netherrack'), block=dict(look='raised', top='netherrack', front='netherrack', hard=0.4, tool='pickaxe', need=1, sound='netherrack', burns=True))
item('nether_bricks', 'Nether Bricks', B('nether_bricks'), block=dict(look='raised', top='nether_bricks', front='nether_bricks', hard=2.0, tool='pickaxe', need=1, sound='nether_bricks'))
item('nether_quartz_ore', 'Nether Quartz Ore', B('nether_quartz_ore'), block=dict(look='raised', top='nether_quartz_ore', front='nether_quartz_ore', hard=3.0, tool='pickaxe', need=1, sound='nether_ore', drop='quartz', xp=[2, 5]))
item('nether_gold_ore', 'Nether Gold Ore', B('nether_gold_ore'), block=dict(look='raised', top='nether_gold_ore', front='nether_gold_ore', hard=3.0, tool='pickaxe', need=1, sound='nether_ore', drop='gold_nugget', dropN=2, dropMax=6, xp=[0, 1]))
item('ancient_debris', 'Ancient Debris', B('ancient_debris_top', 'ancient_debris_side'), fireproof=True,
     block=dict(look='raised', top='ancient_debris_top', front='ancient_debris_side', hard=30.0, tool='pickaxe', need=4, sound='ancient_debris'))
item('glowstone', 'Glowstone', B('glowstone'), block=dict(look='raised', top='glowstone', front='glowstone', hard=0.3, sound='glass', drop='glowstone_dust', dropN=2, dropMax=4, light=15))
item('soul_sand', 'Soul Sand', B('soul_sand'), block=dict(look='raised', top='soul_sand', front='soul_sand', hard=0.5, tool='shovel', sound='soul_sand', slow=0.6))
item('soul_soil', 'Soul Soil', B('soul_soil'), block=dict(look='raised', top='soul_soil', front='soul_soil', hard=0.5, tool='shovel', sound='soul_soil'))
item('bone_block', 'Bone Block', B('bone_block_top', 'bone_block_side'), block=dict(look='raised', top='bone_block_top', front='bone_block_side', hard=2.0, tool='pickaxe', need=1, sound='bone_block'))
item('magma_block', 'Magma Block', B('magma'), block=dict(look='raised', top='magma', front='magma', hard=0.5, tool='pickaxe', need=1, sound='stone', light=3, hurt=1))
item('lava', 'Lava', 'item:lava_still', hidden=True, block=dict(look='liquid', tex='lava_still', hard=-1, sound='stone', light=15, liquid=True, anim='lava'))
item('nether_portal', 'Nether Portal', 'item:nether_portal', hidden=True, block=dict(look='portal', tex='nether_portal', hard=-1, sound='glass', walk=True, light=11, drop=None, anim='portal'))
item('soul_fire', 'Soul Fire', 'item:soul_fire_0', hidden=True, block=dict(look='sprite', tex='soul_fire_0', hard=0.0, sound='grass', walk=True, light=10, drop=None, hurt=2, anim='soul_fire'))
for id, name in (('nether_brick', 'Nether Brick'), ('quartz', 'Nether Quartz'), ('gold_nugget', 'Gold Nugget'), ('glowstone_dust', 'Glowstone Dust'),
                 ('blaze_rod', 'Blaze Rod'), ('blaze_powder', 'Blaze Powder'), ('ghast_tear', 'Ghast Tear'), ('magma_cream', 'Magma Cream'),
                 ('nether_wart', 'Nether Wart'), ('netherite_scrap', 'Netherite Scrap'), ('netherite_ingot', 'Netherite Ingot'), ('fire_charge', 'Fire Charge')):
    item(id, name, f'item:{id}')
ITEMS['blaze_rod']['fuel'] = 2400
ITEMS['netherite_scrap']['fireproof'] = ITEMS['netherite_ingot']['fireproof'] = True
ITEMS['nether_wart']['plant'] = 'soul_sand'     # planted on soul sand; grows through the block looks nether_wart:0..2
ITEMS['fire_charge']['use'] = 'ignite'          # lights a fire like flint and steel, using up one charge
item('lava_bucket', 'Lava Bucket', 'item:lava_bucket', stack=1, use='pour', fuel=20000, remainder='bucket')
_nt = TIERS['netherite']
for kind in ('sword', 'pickaxe', 'axe', 'shovel', 'hoe'):
    item(f'netherite_{kind}', f'Netherite {kind.capitalize()}', f'item:netherite_{kind}', stack=1, fireproof=True,
         tool=dict(kind=kind, tier=_nt['tier'], speed=_nt['speed'], dur=_nt['dur'], dmg=max(1, _nt['dmg'] + TOOL_DMG[kind]), rate=TOOL_SPEED[kind], mat='netherite'))
armor_set('netherite', ARMOR_MATS['netherite'])

FIRST_END = 'ender_pearl'    # everything from here on is The End's and the stronghold's (indexes after the Nether's)

# ---------------------------------------------------------------- The End and the stronghold (Java Edition hardness, tools and drops)
# `use` names what X does with it (the runtime's job): pearl (throw and teleport), eye (fly toward the stronghold, or
# fill an end portal frame), end_crystal (place on obsidian or bedrock), dragon_egg (teleports when hit or used).
item('ender_pearl', 'Ender Pearl', 'item:ender_pearl', stack=16, use='pearl')
item('eye_of_ender', 'Eye of Ender', 'item:ender_eye', use='eye')
item('end_crystal', 'End Crystal', 'item:end_crystal', use='end_crystal')
item('dragon_egg', 'Dragon Egg', 'custom:dragon_egg', use='dragon_egg',
     block=dict(look='egg', tex='dragon_egg', hard=-1, sound='stone', light=1, use='dragon_egg'))
item('paper', 'Paper', 'item:paper')
item('book', 'Book', 'item:book')
item('end_stone', 'End Stone', B('end_stone'), block=dict(look='raised', top='end_stone', front='end_stone', hard=3.0, tool='pickaxe', need=1, sound='stone'))
item('end_stone_bricks', 'End Stone Bricks', B('end_stone_bricks'), block=dict(look='raised', top='end_stone_bricks', front='end_stone_bricks', hard=3.0, tool='pickaxe', need=1, sound='stone'))
for _v, _n in (('mossy_', 'Mossy '), ('cracked_', 'Cracked '), ('chiseled_', 'Chiseled ')):
    item(f'{_v}stone_bricks', f'{_n}Stone Bricks', B(f'{_v}stone_bricks'), block=dict(look='raised', top=f'{_v}stone_bricks', front=f'{_v}stone_bricks', hard=1.5, tool='pickaxe', need=1, sound='stone'))
# infested blocks look exactly like the real ones, break in an instant with anything and let a silverfish out (no drop)
for _v, _n in (('', ''), ('mossy_', 'Mossy '), ('cracked_', 'Cracked '), ('chiseled_', 'Chiseled ')):
    item(f'infested_{_v}stone_bricks', f'Infested {_n}Stone Bricks', B(f'{_v}stone_bricks'), hidden=True,
         block=dict(look='raised', top=f'{_v}stone_bricks', front=f'{_v}stone_bricks', hard=0.75, sound='stone', drop=None, infested='silverfish'))
item('iron_bars', 'Iron Bars', 'item:iron_bars', block=dict(look='bars', tex='iron_bars', hard=5.0, tool='pickaxe', need=1, sound='stone', see=True))
# a cobweb slows whatever walks through it far more than soul sand; swords and shears cut it 15 times faster (`cut`)
item('cobweb', 'Cobweb', 'item:cobweb', block=dict(look='sprite', tex='cobweb', hard=4.0, tool='sword', cut=['sword', 'shears'], sound='cobweb', walk=True, slow=0.25, drop='string', see=True))
item('spawner', 'Monster Spawner', B('spawner'), hidden=True, block=dict(look='raised', top='spawner', front='spawner', hard=5.0, tool='pickaxe', need=1, sound='spawner', drop=None, xp=[15, 43], see=True, spawns='silverfish'))
# the portal frame: block looks 'end_portal_frame' and 'end_portal_frame:eye'; the eye gives light 1 (Minecraft)
item('end_portal_frame', 'End Portal Frame', 'custom:portal_frame', hidden=True, block=dict(look='frame', hard=-1, sound='stone', drop=None, eyeLight=1))
item('end_portal', 'End Portal', 'custom:end_portal', hidden=True, block=dict(look='endportal', hard=-1, sound='glass', walk=True, light=15, drop=None, anim='end_portal'))
item('bedrock', 'Bedrock', B('bedrock'), hidden=True, block=dict(look='raised', top='bedrock', front='bedrock', hard=-1, sound='stone', drop=None))

FIRST_WITHER = 'wither_skeleton_skull'    # everything from here on is the Wither update's (indexes after The End's)

# ---------------------------------------------------------------- the Wither and the beacon (Java Edition hardness, tools and drops)
# The skull is a block (hardness 1, any tool): on the ground it shows its face toward where it faces (block looks
# 'wither_skeleton_skull', ':up', ':left', ':right'), on a wall ':wall'; X with a skull facing soul sand puts it on top
# (the soul sand looks 'soul_sand:skull', ':up', ':left', ':right'), the summoning T's top row. `use` names what X does.
item('wither_skeleton_skull', 'Wither Skeleton Skull', 'custom:wither_skull', use='skull',
     block=dict(look='skull', hard=1.0, sound='stone', use='skull'))
# The Nether star never burns, is never destroyed by explosions and never despawns, and always shines (`glint`)
item('nether_star', 'Nether Star', 'item:nether_star', fireproof=True, blastproof=True, noDespawn=True, glint=True)
# The beacon: hardness 3, any tool, drops itself, light 15; X opens the beacon screen (`use`)
item('beacon', 'Beacon', 'custom:beacon', block=dict(look='beacon', hard=3.0, sound='glass', light=15, use='beacon', see=True))
item('netherite_block', 'Block of Netherite', B('netherite_block'), fireproof=True,
     block=dict(look='raised', top='netherite_block', front='netherite_block', hard=50.0, tool='pickaxe', need=4, sound='netherite'))
# Wither roses: a flower (planted on grass, dirt, netherrack, soul sand or soul soil); touching one gives Wither
item('wither_rose', 'Wither Rose', 'item:wither_rose', block=dict(look='sprite', tex='wither_rose', hard=0.0, sound='grass', walk=True,
     plant='grass', plantOn=['grass', 'dirt', 'netherrack', 'soul_sand', 'soul_soil'], wither=True))
# the beacon's pyramid blocks (Minecraft's #beacon_base_blocks that exist here)
BEACON_BASE = ['iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'netherite_block']
for _id in BEACON_BASE:
    ITEMS[_id]['beaconBase'] = True

FIRST_WORLD = 'birch_log'    # everything from here on is the world update's (indexes after the Wither's)

# ---------------------------------------------------------------- the world update (stage 5a): woods, plants, clay, snow, ice
# Five more woods with their logs, planks and saplings (Minecraft's; a sapling grows that species' FireRed tree,
# design 3.8 and 4.5). `plant` says where a block may be put down: 'grass' Minecraft's soil (grass of any tint,
# snowy grass, podzol, mud in a generated world), 'sand', 'cane' (soil or sand beside water), 'bush' (sand or
# soil), 'water' (on water). `prick`: walking into it hurts (cactus). Generated worlds draw sugar cane, cactus,
# dead bushes, lily pads, pumpkins and melons top-down from the tile bank (world.js), placed or generated alike.
SPECIES_WOODS = [('birch', 'Birch'), ('spruce', 'Spruce'), ('dark_oak', 'Dark Oak'), ('acacia', 'Acacia'), ('jungle', 'Jungle')]
for _w, _n in SPECIES_WOODS:
    item(f'{_w}_log', f'{_n} Log', B(f'{_w}_log_top', f'{_w}_log'), block=dict(look='raised', top=f'{_w}_log_top', front=f'{_w}_log', hard=2.0, tool='axe', sound='wood'), fuel=300)
    item(f'{_w}_planks', f'{_n} Planks', B(f'{_w}_planks'), block=dict(look='raised', top=f'{_w}_planks', front=f'{_w}_planks', hard=2.0, tool='axe', sound='wood'), fuel=300)
    item(f'{_w}_sapling', f'{_n} Sapling', f'item:{_w}_sapling', block=dict(look='sprite', tex=f'{_w}_sapling', hard=0.0, sound='grass', walk=True, plant='grass'), fuel=100)
item('sugar_cane', 'Sugar Cane', 'item:item/sugar_cane', block=dict(look='sprite', tex='item/sugar_cane', hard=0.0, sound='grass', walk=True, plant='cane'))
item('sugar', 'Sugar', 'item:sugar')
item('cactus', 'Cactus', B('cactus_top', 'cactus_side'), block=dict(look='raised', top='cactus_top', front='cactus_side', hard=0.4, sound='cloth', plant='sand', prick=1))
item('dead_bush', 'Dead Bush', 'item:dead_bush', block=dict(look='sprite', tex='dead_bush', hard=0.0, sound='grass', walk=True, plant='bush', drop='stick', dropN=0, dropMax=2), fuel=100)
item('lily_pad', 'Lily Pad', 'tint:lily_pad:32,128,48', block=dict(look='sprite', tex='lily_pad', tint=[32, 128, 48], hard=0.0, sound='grass', walk=True, plant='water'))
item('melon', 'Melon', B('melon_top', 'melon_side'), block=dict(look='raised', top='melon_top', front='melon_side', hard=1.0, tool='axe', sound='wood', drop='melon_slice', dropN=3, dropMax=7))
item('melon_slice', 'Melon Slice', 'item:melon_slice', food=dict(hunger=2, sat=1.2))
item('clay_ball', 'Clay Ball', 'item:clay_ball')
item('clay', 'Clay', B('clay'), block=dict(look='raised', top='clay', front='clay', hard=0.6, tool='shovel', sound='gravel', drop='clay_ball', dropN=4))
item('brick', 'Brick', 'item:brick')
item('snowball', 'Snowball', 'item:snowball', stack=16)
item('snow_block', 'Snow Block', B('snow'), block=dict(look='raised', top='snow', front='snow', hard=0.2, tool='shovel', sound='sand', drop='snowball', dropN=4))
item('ice', 'Ice', B('ice'), block=dict(look='raised', top='ice', front='ice', hard=0.5, tool='pickaxe', sound='glass', drop=None, see=True))
# (stage 7a) the villages' job-site blocks (design 5.4) and the bell, Minecraft's looks and hardness; recipes, prices and
# what they do (a villager's job, the bell's warning) are stages 7b and 7c's
for _id, _n, _top, _front, _h, _tool, _snd in (
        ('composter', 'Composter', 'composter_top', 'composter_side', 0.6, 'axe', 'wood'),
        ('lectern', 'Lectern', 'lectern_top', 'lectern_front', 2.5, 'axe', 'wood'),
        ('blast_furnace', 'Blast Furnace', 'blast_furnace_top', 'blast_furnace_front', 3.5, 'pickaxe', 'stone'),
        ('grindstone', 'Grindstone', 'grindstone_round', 'grindstone_side', 2.0, 'pickaxe', 'stone'),
        ('smithing_table', 'Smithing Table', 'smithing_table_top', 'smithing_table_front', 2.5, 'axe', 'wood'),
        ('smoker', 'Smoker', 'smoker_top', 'smoker_front', 3.5, 'pickaxe', 'stone'),
        ('fletching_table', 'Fletching Table', 'fletching_table_top', 'fletching_table_front', 2.5, 'axe', 'wood'),
        ('cartography_table', 'Cartography Table', 'cartography_table_top', 'cartography_table_side3', 2.5, 'axe', 'wood'),
        ('cauldron', 'Cauldron', 'cauldron_top', 'cauldron_side', 2.0, 'pickaxe', 'stone'),
        ('stonecutter', 'Stonecutter', 'stonecutter_top', 'stonecutter_side', 3.5, 'pickaxe', 'stone'),
        ('loom', 'Loom', 'loom_top', 'loom_front', 2.5, 'axe', 'wood'),
        ('barrel', 'Barrel', 'barrel_top', 'barrel_side', 2.5, 'axe', 'wood')):
    _b = dict(look='raised', top=_top, front=_front, hard=_h, tool=_tool, sound=_snd)
    if _tool == 'pickaxe':
        _b['need'] = 1
    item(_id, _n, B(_top, _front), block=_b)
item('brewing_stand', 'Brewing Stand', 'item:brewing_stand', block=dict(look='sprite', tex='item/brewing_stand', hard=0.5, tool='pickaxe', need=1, sound='stone'))
item('bell', 'Bell', 'item:bell', block=dict(look='sprite', tex='item/bell', hard=5.0, tool='pickaxe', need=1, sound='stone'))
# Recipe tags (Minecraft's #planks and #logs): a key or ingredient '#name' matches any member (src/items.js)
TAGS = {'planks': ['oak_planks'] + [f'{_w}_planks' for _w, _ in SPECIES_WOODS], 'logs': ['oak_log'] + [f'{_w}_log' for _w, _ in SPECIES_WOODS]}

# ---------------------------------------------------------------- recipes
RECIPES = []


def shaped(out, n, rows, key):
    RECIPES.append(dict(out=out, n=n, rows=rows, key=key))


def shapeless(out, n, ins):
    RECIPES.append(dict(out=out, n=n, ins=ins))


shapeless('oak_planks', 4, ['oak_log'])
shaped('stick', 4, ['P', 'P'], {'P': '#planks'})
shaped('crafting_table', 1, ['PP', 'PP'], {'P': '#planks'})
shaped('furnace', 1, ['CCC', 'C C', 'CCC'], {'C': 'cobblestone'})
shaped('chest', 1, ['PPP', 'P P', 'PPP'], {'P': '#planks'})
shaped('torch', 4, ['C', 'S'], {'C': 'coal', 'S': 'stick'})
shaped('torch', 4, ['C', 'S'], {'C': 'charcoal', 'S': 'stick'})
HEADS = {'wooden': '#planks', 'stone': 'cobblestone', 'iron': 'iron_ingot', 'golden': 'gold_ingot', 'diamond': 'diamond'}
for t, m in HEADS.items():
    shaped(f'{t}_pickaxe', 1, ['XXX', ' S ', ' S '], {'X': m, 'S': 'stick'})
    shaped(f'{t}_axe', 1, ['XX', 'XS', ' S'], {'X': m, 'S': 'stick'})
    shaped(f'{t}_shovel', 1, ['X', 'S', 'S'], {'X': m, 'S': 'stick'})
    shaped(f'{t}_sword', 1, ['X', 'X', 'S'], {'X': m, 'S': 'stick'})
    shaped(f'{t}_hoe', 1, ['XX', ' S', ' S'], {'X': m, 'S': 'stick'})
shaped('oak_door', 3, ['PP', 'PP', 'PP'], {'P': 'oak_planks'})
shaped('white_bed', 1, ['WWW', 'PPP'], {'W': 'white_wool', 'P': '#planks'})
shaped('white_wool', 1, ['SS', 'SS'], {'S': 'string'})
shaped('tnt', 1, ['GSG', 'SGS', 'GSG'], {'G': 'gunpowder', 'S': 'sand'})
shaped('oak_fence', 3, ['PSP', 'PSP'], {'P': 'oak_planks', 'S': 'stick'})
shaped('oak_boat', 1, ['P P', 'PPP'], {'P': 'oak_planks'})
shaped('oak_sign', 3, ['PPP', 'PPP', ' S '], {'P': 'oak_planks', 'S': 'stick'})
shaped('bookshelf', 1, ['PPP', 'PPP', 'PPP'], {'P': '#planks'})
shaped('bucket', 1, ['I I', ' I '], {'I': 'iron_ingot'})
shaped('shears', 1, [' I', 'I '], {'I': 'iron_ingot'})
shapeless('flint_and_steel', 1, ['iron_ingot', 'flint'])
shaped('fishing_rod', 1, ['  S', ' ST', 'S T'], {'S': 'stick', 'T': 'string'})
shaped('bow', 1, [' ST', 'S T', ' ST'], {'S': 'stick', 'T': 'string'})
shaped('arrow', 4, ['F', 'S', 'E'], {'F': 'flint', 'S': 'stick', 'E': 'feather'})
shapeless('bone_meal', 3, ['bone'])
shaped('bread', 1, ['WWW'], {'W': 'wheat'})
shaped('hay_block', 1, ['WWW', 'WWW', 'WWW'], {'W': 'wheat'})
shapeless('wheat', 9, ['hay_block'])
shaped('stone_bricks', 4, ['SS', 'SS'], {'S': 'stone'})
shaped('sandstone', 1, ['SS', 'SS'], {'S': 'sand'})
shapeless('stone_button', 1, ['stone'])
shapeless('jack_o_lantern', 1, ['pumpkin', 'torch'])
shaped('golden_apple', 1, ['GGG', 'GAG', 'GGG'], {'G': 'gold_ingot', 'A': 'apple'})
for ore, it in (('coal', 'coal'), ('iron', 'iron_ingot'), ('gold', 'gold_ingot'), ('diamond', 'diamond'), ('redstone', 'redstone'), ('lapis', 'lapis_lazuli'), ('emerald', 'emerald')):
    shaped(f'{ore}_block', 1, ['XXX', 'XXX', 'XXX'], {'X': it})
    shapeless(it, 9, [f'{ore}_block'])
shaped('copper_block', 1, ['XXX', 'XXX', 'XXX'], {'X': 'copper_ingot'})
shapeless('copper_ingot', 9, ['copper_block'])
# the Nether
shaped('gold_ingot', 1, ['NNN', 'NNN', 'NNN'], {'N': 'gold_nugget'})
shapeless('gold_nugget', 9, ['gold_ingot'])
shaped('glowstone', 1, ['DD', 'DD'], {'D': 'glowstone_dust'})
shapeless('blaze_powder', 2, ['blaze_rod'])
shaped('nether_bricks', 1, ['BB', 'BB'], {'B': 'nether_brick'})
shaped('bone_block', 1, ['BBB', 'BBB', 'BBB'], {'B': 'bone_meal'})
shapeless('bone_meal', 9, ['bone_block'])
shaped('magma_block', 1, ['MM', 'MM'], {'M': 'magma_cream'})
shapeless('fire_charge', 3, ['gunpowder', 'blaze_powder', 'coal'])
shapeless('fire_charge', 3, ['gunpowder', 'blaze_powder', 'charcoal'])
shapeless('netherite_ingot', 1, ['netherite_scrap'] * 4 + ['gold_ingot'] * 4)
# The netherite upgrade: Minecraft does it on a smithing table with a netherite upgrade template; here it is
# a shapeless craft of the diamond piece and a netherite ingot (a simplification: no table, no template).
for _k in ('sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots'):
    shapeless(f'netherite_{_k}', 1, [f'diamond_{_k}', 'netherite_ingot'])
# The End (Minecraft's recipes; chiseled stone bricks are a simplification: two stone bricks stacked, Minecraft
# stacks two stone brick slabs, and the game has no slabs)
shapeless('eye_of_ender', 1, ['ender_pearl', 'blaze_powder'])
shaped('end_crystal', 1, ['GGG', 'GEG', 'GTG'], {'G': 'glass', 'E': 'eye_of_ender', 'T': 'ghast_tear'})
shaped('end_stone_bricks', 4, ['EE', 'EE'], {'E': 'end_stone'})
shaped('chiseled_stone_bricks', 1, ['S', 'S'], {'S': 'stone_bricks'})
shaped('iron_bars', 16, ['III', 'III'], {'I': 'iron_ingot'})
shapeless('book', 1, ['paper', 'paper', 'paper', 'leather'])
for mat, m in (('iron', 'iron_ingot'), ('diamond', 'diamond')):
    shaped(f'{mat}_helmet', 1, ['XXX', 'X X'], {'X': m})
    shaped(f'{mat}_chestplate', 1, ['X X', 'XXX', 'XXX'], {'X': m})
    shaped(f'{mat}_leggings', 1, ['XXX', 'X X', 'X X'], {'X': m})
    shaped(f'{mat}_boots', 1, ['X X', 'X X'], {'X': m})
# Poké Balls: a red (redstone), blue (lapis) or black-and-gold (coal, gold) cap over an iron shell, with
# a stone button in the middle, the way Pixelmon builds them from Minecraft parts.
shaped('campfire', 1, [' S ', 'SCS', 'LLL'], {'S': 'stick', 'C': 'coal', 'L': '#logs'})
shaped('campfire', 1, [' S ', 'SCS', 'LLL'], {'S': 'stick', 'C': 'charcoal', 'L': '#logs'})
shaped('poke_ball', 4, [' R ', 'IBI', ' I '], {'R': 'redstone', 'I': 'iron_ingot', 'B': 'stone_button'})
shaped('great_ball', 4, [' L ', 'IBI', ' I '], {'L': 'lapis_lazuli', 'I': 'iron_ingot', 'B': 'stone_button'})
shaped('ultra_ball', 4, ['CGC', 'IBI', ' I '], {'C': 'coal', 'G': 'gold_ingot', 'I': 'iron_ingot', 'B': 'stone_button'})
# the Wither update (Minecraft's recipes)
shaped('beacon', 1, ['GGG', 'GSG', 'OOO'], {'G': 'glass', 'S': 'nether_star', 'O': 'obsidian'})
shaped('netherite_block', 1, ['XXX', 'XXX', 'XXX'], {'X': 'netherite_ingot'})
shapeless('netherite_ingot', 9, ['netherite_block'])
# the world update (stage 5a): Minecraft's recipes for the new woods, plants, clay and snow
for _w, _ in SPECIES_WOODS:
    shapeless(f'{_w}_planks', 4, [f'{_w}_log'])
shaped('birch_fence', 3, ['PSP', 'PSP'], {'P': 'birch_planks', 'S': 'stick'})
shapeless('sugar', 1, ['sugar_cane'])
shaped('paper', 3, ['CCC'], {'C': 'sugar_cane'})
shaped('melon', 1, ['MMM', 'MMM', 'MMM'], {'M': 'melon_slice'})
shaped('clay', 1, ['CC', 'CC'], {'C': 'clay_ball'})
shaped('bricks', 1, ['BB', 'BB'], {'B': 'brick'})
shaped('snow_block', 1, ['SS', 'SS'], {'S': 'snowball'})

# furnace: input -> (output, xp)
SMELT = {'raw_iron': ('iron_ingot', 0.7), 'raw_gold': ('gold_ingot', 1.0), 'raw_copper': ('copper_ingot', 0.7), 'cobblestone': ('stone', 0.1), 'sand': ('glass', 0.1),
         'oak_log': ('charcoal', 0.15), 'beef': ('cooked_beef', 0.35), 'porkchop': ('cooked_porkchop', 0.35), 'chicken': ('cooked_chicken', 0.35),
         'mutton': ('cooked_mutton', 0.35), 'cod': ('cooked_cod', 0.35), 'salmon': ('cooked_salmon', 0.35),
         'netherrack': ('nether_brick', 0.1), 'ancient_debris': ('netherite_scrap', 2.0), 'nether_gold_ore': ('gold_ingot', 1.0),
         'nether_quartz_ore': ('quartz', 0.2), 'stone_bricks': ('cracked_stone_bricks', 0.1)}
# the world update: every log burns to charcoal, a clay ball fires into a brick (Minecraft)
SMELT.update({f'{_w}_log': ('charcoal', 0.15) for _w, _ in SPECIES_WOODS})
SMELT['clay_ball'] = ('brick', 0.3)

# campfire: raw food -> cooked, 600 ticks each, no XP
CAMPFIRE = {k: SMELT[k][0] for k in ('beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon')}

# What a Poké Mart pays is half of these (FireRed's rule). FireRed building blocks are worth nothing,
# so tearing towns down earns no money.
PRICES = dict(oak_log=20, oak_planks=6, cobblestone=4, stone=8, stone_bricks=10, sandstone=16, dirt=2, sand=4, glass=12, white_wool=40,
    oak_leaves=2, hay_block=100, pumpkin=40, jack_o_lantern=60, crafting_table=30, furnace=40, chest=60, tnt=300, bookshelf=60, torch=10,
    oak_door=12, white_bed=140, oak_fence=10, birch_fence=10, oak_sign=14, oak_sapling=10, poppy=10, dandelion=10, campfire=60,
    coal_block=270, iron_block=1440, gold_block=2700, diamond_block=18000, redstone_block=360, lapis_block=540, emerald_block=27000, copper_block=500,
    stick=2, coal=30, charcoal=24, raw_iron=100, iron_ingot=160, raw_gold=200, gold_ingot=300, raw_copper=40, copper_ingot=60, diamond=2000,
    emerald=3000, redstone=40, lapis_lazuli=60, flint=10, string=20, feather=10, leather=40, bone=20, bone_meal=8, gunpowder=60, wheat=10,
    wheat_seeds=2, egg=20, stone_button=8, arrow=10, shears=320, flint_and_steel=170, fishing_rod=50, bow=70, bucket=480, water_bucket=480,
    milk_bucket=500, oak_boat=30, apple=40, bread=60, beef=40, cooked_beef=100, porkchop=40, cooked_porkchop=100, chicken=30, cooked_chicken=80,
    mutton=30, cooked_mutton=80, cod=30, cooked_cod=70, salmon=40, cooked_salmon=90, rotten_flesh=2, golden_apple=2800,
    iron_helmet=800, iron_chestplate=1280, iron_leggings=1120, iron_boots=640, diamond_helmet=10000, diamond_chestplate=16000,
    diamond_leggings=14000, diamond_boots=8000,
    # the Nether (the spec's Mart prices first)
    quartz=40, gold_nugget=30, glowstone_dust=30, blaze_rod=300, ghast_tear=600, netherite_ingot=9000, obsidian=50,
    netherrack=2, nether_brick=6, nether_bricks=24, nether_quartz_ore=60, nether_gold_ore=60, glowstone=120, soul_sand=6, soul_soil=6,
    bone_block=60, magma_block=200, blaze_powder=150, magma_cream=200, nether_wart=20, ancient_debris=2000, netherite_scrap=2000,
    lava_bucket=500, fire_charge=100,
    netherite_helmet=19000, netherite_chestplate=25000, netherite_leggings=23000, netherite_boots=17000)
# The End and the stronghold (the dragon egg has no price: a Mart won't buy it)
PRICES.update(ender_pearl=200, eye_of_ender=400, end_crystal=1500, paper=10, book=60, end_stone=4, end_stone_bricks=6,
              mossy_stone_bricks=12, cracked_stone_bricks=10, chiseled_stone_bricks=14, iron_bars=20, cobweb=20)
# the Wither update (the Nether star and the beacon have no price: a Mart won't buy them)
PRICES.update(wither_skeleton_skull=3000, netherite_block=81000, wither_rose=10)
# the world update: the woods at oak's prices; melon, slice, sugar, clay ball, brick and clay as the villagers track's
# MART_PLAN (tools/villager_trades.py) sets them, so trade_check.py's arbitrage check holds
for _w, _ in SPECIES_WOODS:
    PRICES.update({f'{_w}_log': 20, f'{_w}_planks': 6, f'{_w}_sapling': 10})
PRICES.update(sugar_cane=10, sugar=8, cactus=10, dead_bush=2, lily_pad=10, melon=30, melon_slice=4, clay_ball=8, clay=32, brick=10,
              snowball=2, snow_block=8, ice=20)
for _m, _p in (('wooden', (20, 30, 30, 10, 20)), ('stone', (16, 20, 20, 8, 12)), ('iron', (330, 490, 490, 170, 330)),
               ('golden', (600, 900, 900, 300, 600)), ('diamond', (4000, 6000, 6000, 2000, 4000)),
               ('netherite', (13000, 15000, 15000, 11000, 13000))):
    for _k, _v in zip(('sword', 'pickaxe', 'axe', 'shovel', 'hoe'), _p):
        PRICES[f'{_m}_{_k}'] = _v
for _id, _p in PRICES.items():
    if _id in ITEMS and 'price' not in ITEMS[_id]:
        ITEMS[_id]['price'] = _p

# mobs: health, damage, drops [(item, min, max, chance)], xp, speed (seconds per tile)
MOBS = {
    'zombie': dict(name='Zombie', hp=20, dmg=3, xp=5, step=0.62, hostile=True, drops=[('rotten_flesh', 0, 2, 1.0), ('iron_ingot', 1, 1, 0.025)]),
    'skeleton': dict(name='Skeleton', hp=20, dmg=3, xp=5, step=0.5, hostile=True, ranged=True, drops=[('bone', 0, 2, 1.0), ('arrow', 0, 2, 1.0)]),
    'creeper': dict(name='Creeper', hp=20, dmg=0, xp=5, step=0.55, hostile=True, explode=True, drops=[('gunpowder', 0, 2, 1.0)]),
    'spider': dict(name='Spider', hp=16, dmg=2, xp=5, step=0.34, hostile=True, drops=[('string', 0, 2, 1.0)]),
    'sheep': dict(name='Sheep', hp=8, dmg=0, xp=2, step=0.7, drops=[('white_wool', 1, 1, 1.0), ('mutton', 1, 2, 1.0)]),
    'cow': dict(name='Cow', hp=10, dmg=0, xp=2, step=0.8, drops=[('leather', 0, 2, 1.0), ('beef', 1, 3, 1.0)]),
    'pig': dict(name='Pig', hp=10, dmg=0, xp=2, step=0.7, drops=[('porkchop', 1, 3, 1.0)]),
    'chicken': dict(name='Chicken', hp=4, dmg=0, xp=1, step=0.6, drops=[('feather', 0, 2, 1.0), ('chicken', 1, 1, 1.0)]),
    # the Nether (only spawns there). neutral: ignores Steve until hit, then its group within `group` cells joins in.
    # fly: floats over lava and walls. fireball: the projectile's explosion power and direct-hit damage.
    'zombified_piglin': dict(name='Zombified Piglin', hp=20, dmg=5, xp=5, step=0.62, neutral=True, group=16,
                             drops=[('rotten_flesh', 0, 1, 1.0), ('gold_nugget', 0, 1, 1.0), ('golden_sword', 1, 1, 0.085)]),
    'ghast': dict(name='Ghast', hp=10, dmg=0, xp=5, step=0.9, hostile=True, fly=True, ranged=True, keep=[6, 12], fireball=dict(power=1, dmg=6, fire=True, every=[3, 5]),
                  drops=[('ghast_tear', 0, 1, 1.0), ('gunpowder', 0, 2, 1.0)]),
    'magma_cube': dict(name='Magma Cube', hp=16, dmg=6, xp=4, step=0.7, hostile=True, hop=True,
                       sizes={'large': dict(hp=16, dmg=6, xp=4, splits='medium'), 'medium': dict(hp=4, dmg=4, xp=2, splits='small'), 'small': dict(hp=1, dmg=3, xp=1)},
                       drops=[('magma_cream', 1, 1, 0.25)]),
    'blaze': dict(name='Blaze', hp=20, dmg=6, xp=10, step=0.7, hostile=True, fly=True, ranged=True, fireball=dict(power=0, dmg=5, fire=True, burst=3, every=[3, 5]),
                  drops=[('blaze_rod', 0, 1, 1.0)]),
    'wither_skeleton': dict(name='Wither Skeleton', hp=20, dmg=8, xp=5, step=0.55, hostile=True,
                            drops=[('coal', 1, 1, 0.33), ('bone', 0, 2, 1.0), ('stone_sword', 1, 1, 0.085)]),
    # The End and the stronghold. enderman: neutral, provoked by a hit or by Steve's stare; teleports, hates water, dodges
    # arrows. silverfish: from infested blocks and the portal room's spawner; a hurt one wakes infested blocks within `wake`.
    'enderman': dict(name='Enderman', hp=40, dmg=7, xp=5, step=0.42, neutral=True, teleports=True, stare=8, drops=[('ender_pearl', 0, 1, 1.0)]),
    'silverfish': dict(name='Silverfish', hp=8, dmg=1, xp=5, step=0.3, hostile=True, wake=5, drops=[]),
    # the world update (3.16, generated land only): a desert's zombie is a husk (no burning in daylight), a snowy biome's
    # skeleton a stray (its arrows slow Steve for 3 s). Their sounds are not fetched: they stay silent.
    'husk': dict(name='Husk', hp=20, dmg=3, xp=5, step=0.62, hostile=True, drops=[('rotten_flesh', 0, 2, 1.0), ('iron_ingot', 1, 1, 0.025)]),
    'stray': dict(name='Stray', hp=20, dmg=3, xp=5, step=0.5, hostile=True, ranged=True, slow=3, drops=[('bone', 0, 2, 1.0), ('arrow', 0, 2, 1.0)]),
}
