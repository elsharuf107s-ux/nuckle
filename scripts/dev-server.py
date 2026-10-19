#!/usr/bin/env python3
"""Serve the editable game over a forwarded Codespaces port."""
import argparse
import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from serve import NoCacheHandler


class GameHandler(NoCacheHandler):
    def send_head(self):
        # Do not expose Git metadata, local environments or downloaded source trees.
        from urllib.parse import unquote, urlsplit
        parts = unquote(urlsplit(self.path).path).split('/')
        if any(p.startswith('.') or p in {'vendor', 'node_modules', 'out'} for p in parts if p):
            self.send_error(404)
            return
        return super().send_head()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=5300)
    args = parser.parse_args()
    os.chdir(ROOT)
    print(f'Pokémon Redstone: listening on port {args.port}', flush=True)
    ThreadingHTTPServer((args.host, args.port), GameHandler).serve_forever()
