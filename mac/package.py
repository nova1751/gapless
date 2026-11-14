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
               root.parent / 'shared' / 'playback-clock.js', root / 'native-cache.js', root / 'media-session.js', root / 'player.js']
    archive.writestr('player.js', '\n'.join(path.read_text() for path in sources))
    archive.write(root.parent / 'LICENSE', 'LICENSE')
print(output)
