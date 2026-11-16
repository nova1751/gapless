#!/usr/bin/env python3
"""Install only our independent host menu prelude, without rewriting BetterNCM files."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', type=Path, default=Path('/Applications/BetterNCM.app'))
parser.add_argument('--remove', action='store_true', help='Remove this menu and restore the existing host menu on the next reload.')
args = parser.parse_args()
root = args.app / 'Contents/Resources/app'
source = Path(__file__).parent / 'host/plugin-menu.js'
target = root / 'src/prelude/gapless-plugin-menu.js'
marker = '/* MIT. gapless-mac-menu:'
if target.exists() and not target.read_text().startswith(marker):
    raise SystemExit('Refusing to overwrite an unrelated host prelude.')
if args.remove:
    if target.exists():
        target.unlink()
    print(json.dumps({'removed': True, 'nextReload': True}))
else:
    # These read-only guards identify the actual host interfaces used by this addon.
    bundle = (root / 'src/bundle.mjs').read_text()
    button = (root / 'src/prelude/plugin-button.js').read_text()
    server = (root / 'src/server.mjs').read_text()
    if not all(anchor in bundle for anchor in ['fs.readdirSync(preludeDir)', '.endsWith(\'.js\')']):
        raise SystemExit('Unsupported host prelude discovery; original menu retained.')
    if 'bncm-plugins-btn' not in button or not all(route in server for route in ["'/internal/plugins'", "'/internal/plugins/enabled'"]):
        raise SystemExit('Unsupported host menu API; original menu retained.')
    code = source.read_bytes()
    menu_version = re.search(r"Object\.freeze\(\{ version: '([^']+)' \}\)", code.decode()).group(1)
    previous = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
    temporary = target.with_suffix('.js.tmp')
    temporary.write_bytes(code)
    os.replace(temporary, target)
    print(json.dumps({'menuVersion': menu_version, 'hostVersion': json.loads((root / 'package.json').read_text())['version'],
                      'sha256': hashlib.sha256(code).hexdigest(), 'previousSha256': previous, 'nextReload': True}))
