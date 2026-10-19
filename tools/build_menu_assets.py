#!/usr/bin/env python3
"""The world update's menu textures (design sections 6.3, 6.4, 7): copies Minecraft's own GUI pieces from the vendored
client jar into assets/mc/menu/, which only src/ui/mcgui.js loadMenuAssets() reads (on first use of a world menu, the
creative inventory or a hardcore screen; a Classic page never requests them).

  python3 tools/build_menu_assets.py

Writes nothing outside assets/mc/menu/ and downloads nothing. Every source is in vendor/minecraft/jar (Minecraft 1.21.4).
The creative tab sprites (28 files of 26 x 32) are packed into one strip, creative_tabs.png: rows top unselected, top
selected, bottom unselected, bottom selected; column c is Minecraft's tab_*_<c+1>.
"""
import argparse
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GUI = ROOT / 'vendor/minecraft/jar/assets/minecraft/textures/gui'
TX = ROOT / 'vendor/minecraft/jar/assets/minecraft/textures'
OUT = ROOT / 'assets/mc/menu'

COPY = {
    # widgets (nine-slice sprites, sizes from their .mcmeta)
    'button': 'sprites/widget/button.png', 'button_highlighted': 'sprites/widget/button_highlighted.png',
    'button_disabled': 'sprites/widget/button_disabled.png',
    'text_field': 'sprites/widget/text_field.png', 'text_field_highlighted': 'sprites/widget/text_field_highlighted.png',
    'tab': 'sprites/widget/tab.png', 'tab_highlighted': 'sprites/widget/tab_highlighted.png',
    'tab_selected': 'sprites/widget/tab_selected.png', 'tab_selected_highlighted': 'sprites/widget/tab_selected_highlighted.png',
    'scroller': 'sprites/widget/scroller.png', 'scroller_background': 'sprites/widget/scroller_background.png',
    # screen furniture
    'menu_background': 'menu_background.png', 'menu_list_background': 'menu_list_background.png',
    'header_separator': 'header_separator.png', 'footer_separator': 'footer_separator.png',
    'join': 'sprites/world_list/join.png', 'join_highlighted': 'sprites/world_list/join_highlighted.png',
    # the creative inventory
    'creative_items': 'container/creative_inventory/tab_items.png',
    'creative_search': 'container/creative_inventory/tab_item_search.png',
    'creative_inventory': 'container/creative_inventory/tab_inventory.png',
    'creative_scroller': 'sprites/container/creative_inventory/scroller.png',
    'creative_scroller_disabled': 'sprites/container/creative_inventory/scroller_disabled.png',
    # hardcore hearts (hud/heart/*hardcore*)
    'heart_hardcore_container': 'sprites/hud/heart/container_hardcore.png',
    'heart_hardcore_container_blinking': 'sprites/hud/heart/container_hardcore_blinking.png',
    'heart_hardcore_full': 'sprites/hud/heart/hardcore_full.png', 'heart_hardcore_half': 'sprites/hud/heart/hardcore_half.png',
    'heart_hardcore_full_blinking': 'sprites/hud/heart/hardcore_full_blinking.png',
    'heart_hardcore_half_blinking': 'sprites/hud/heart/hardcore_half_blinking.png',
    'heart_hardcore_poisoned_full': 'sprites/hud/heart/poisoned_hardcore_full.png',
    'heart_hardcore_poisoned_half': 'sprites/hud/heart/poisoned_hardcore_half.png',
    'heart_hardcore_absorbing_full': 'sprites/hud/heart/absorbing_hardcore_full.png',
    'heart_hardcore_absorbing_half': 'sprites/hud/heart/absorbing_hardcore_half.png',
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    missing = []
    for k, rel in COPY.items():
        src = GUI / rel
        if not src.exists():
            missing.append(rel)
            continue
        # the creative panels only use their top-left 196 x 136; crop so the files stay small
        if k in ('creative_items', 'creative_search', 'creative_inventory'):
            Image.open(src).convert('RGBA').crop((0, 0, 196, 136)).save(OUT / f'{k}.png', optimize=True)
        else:
            shutil.copyfile(src, OUT / f'{k}.png')
    # the old dirt-style menu background (design 7.6): Minecraft's dirt block texture, tiled at 2x and darkened at runtime
    shutil.copyfile(TX / 'block/dirt.png', OUT / 'dirt.png')
    # creative tab strip
    strip = Image.new('RGBA', (7 * 26, 4 * 32), (0, 0, 0, 0))
    for row, (side, state) in enumerate([('top', 'unselected'), ('top', 'selected'), ('bottom', 'unselected'), ('bottom', 'selected')]):
        for c in range(7):
            src = GUI / f'sprites/container/creative_inventory/tab_{side}_{state}_{c + 1}.png'
            if not src.exists():
                missing.append(str(src.relative_to(GUI)))
                continue
            strip.paste(Image.open(src).convert('RGBA'), (c * 26, row * 32))
    strip.save(OUT / 'creative_tabs.png', optimize=True)
    if missing:
        print('missing:', *missing, sep='\n  ')
        sys.exit(1)
    total = sum(p.stat().st_size for p in OUT.iterdir())
    print(f'assets/mc/menu: {len(list(OUT.iterdir()))} files, {total} bytes')


if __name__ == '__main__':
    # no options: -h / --help prints the usage above and an unknown argument is an error, neither writes anything
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args()
    main()
