#!/usr/bin/env python3
"""Package the Mac adaptation without building the Windows plugin."""
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent
manifest = json.loads((root / 'manifest.json').read_text())
output = root.parent / 'dist' / f'gapless-player-mac-{manifest["version"]}.plugin'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(root / 'manifest.json', 'manifest.json')
    archive.write(root / 'startup.js', 'startup_script.js')
    sources = [root.parent / 'shared' / 'audio-resources.js',
               root.parent / 'shared' / 'cache-worker.js',
               root.parent / 'shared' / 'playback-clock.js', root.parent / 'shared' / 'visual-pcm.js',
               root / 'native-cache.js', root / 'media-session.js', root / 'player.js']
    vendor = root.parent / 'vendor/crypto-js-4.2.0'
    worker = '\n'.join(path.read_text(encoding='utf-8') for path in [vendor / 'core.js', vendor / 'md5.js', root.parent / 'shared/cache-worker-runtime.js'])
    archive.writestr('player.js', 'globalThis.gaplessCacheWorkerSource = ' + json.dumps(worker) + ';\n'
                     + '\n'.join(path.read_text(encoding='utf-8') for path in sources))
    archive.write(root.parent / 'LICENSE', 'LICENSE')
    archive.write(vendor / 'LICENSE', 'vendor/crypto-js-LICENSE')
print(output)
