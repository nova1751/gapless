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
parser.add_argument('--market', action='store_true', help='Expose the bundled host PluginMarket; does not install other plugins.')
parser.add_argument('--profile', type=Path, default=Path(os.environ.get('BETTERNCM_PROFILE', str(Path.home() / 'Library/Application Support/BetterNCM-mac'))))
args = parser.parse_args()
if args.remove and args.market:
    parser.error('--remove and --market cannot be used together')
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
    config_file = args.profile / 'config.json'
    config = None
    if args.market:
        if "'mac.pluginManager':" not in (root / 'src/config.mjs').read_text():
            raise SystemExit('Unsupported host market configuration; original settings retained.')
        config = json.loads(config_file.read_text()) if config_file.exists() else {}
        if not isinstance(config, dict):
            raise SystemExit('Invalid host config; original settings retained.')
    previous = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
    temporary = target.with_suffix('.js.tmp')
    temporary.write_bytes(code)
    os.replace(temporary, target)
    if config is not None:
        config['mac.pluginManager'] = 'true'
        config_file.parent.mkdir(parents=True, exist_ok=True)
        temporary_config = config_file.with_name('config.json.gapless-menu.tmp')
        temporary_config.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
        os.chmod(temporary_config, config_file.stat().st_mode & 0o777 if config_file.exists() else 0o600)
        os.replace(temporary_config, config_file)
    print(json.dumps({'menuVersion': menu_version, 'hostVersion': json.loads((root / 'package.json').read_text())['version'],
                      'sha256': hashlib.sha256(code).hexdigest(), 'previousSha256': previous,
                      'marketRequested': args.market, 'nextReload': True}))
