"""Package the Windows adapter for the exact installed NetEase client."""
import argparse
import json
from pathlib import Path
import re
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--client", type=Path, default=Path(r"C:\Program Files\NetEase\CloudMusic\package\orpheus.ntpk"))
parser.add_argument("--probe", action="store_true", help="Pass playback through and record native preloading.")
parser.add_argument("--diagnostics", action="store_true")
parser.add_argument("--temporary-bridge", action="store_true", help="Evaluation only: tail/head window with sequential native handback; output alignment not certified.")
args = parser.parse_args()
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8-sig"))
if args.temporary_bridge:
    manifest["description"] = "短时桥接试验版；原生交还尚未完成声音对齐验收"

with ZipFile(args.client) as archive:
    name, = [name for name in archive.namelist() if re.match(r"pub/hybrid/app\.chunk\..*\.js$", name)]
    client = archive.read(name).decode()
start = client.index("const F=async e=>{const{curPlayId:t,preloadIndex:n}=e")
end = client.index("}},function(e,t,n)", start) + 1
original = client[start:end]
assert original.count("await i.AudioPlayer.setPreloadInfoResult(") == 4
# Expose an observer on a separate factory instance. Webpack's native exports and
# callbacks still follow the original code. Only the observer receives full playInfo.
patched = original.replace("const F=async e=>{", "const F=async (e,observe,requestedRow)=>{", 1)
assert patched.count('if(d===r.i.PlayFm)') == 1
patched = patched.replace('if(d===r.i.PlayFm)', 'if(requestedRow){p=v=requestedRow}else if(d===r.i.PlayFm)', 1)
patched = patched.replace("await i.AudioPlayer.setPreloadInfoResult(", "await observe(")
patched = patched.replace("return void await observe(t)}catch(S)",
                          "return void await observe({...t,info:h.playInfo,row:p})}catch(S)")
assert "info:h.playInfo,row:p" in patched
# The native End handler replays the current queue row in single-track repeat.
# Reuse its normal source resolver and allow a fresh native Load to claim playback.
loop_anchor = "!v)return;for(let t=n;t>=0;t--)"
assert patched.count(loop_anchor) == 1
patched = patched.replace(loop_anchor, "!v)return;if(d===r.i.PlayOneCycle)p=v;else for(let t=n;t>=0;t--)")

patched += """
;return {
  read: () => c.a.getStore(),
  resolveCurrent: () => new Promise((resolve, reject) => {
    const state = c.a.getStore(), row = state.playing.curPlaying;
    if (!row) return resolve(null);
    F({curPlayId:state.playing.playId,preloadIndex:0},resolve,row).then(() => resolve(null),reject);
  }),
  pause: () => c.a.getDispatch()({ type:"playing/pause", payload:{} }),
  select: row => c.a.getDispatch()({
    type:"playing/playOneTrackInPlayingList",
    payload:{item:row,flag:0,switchType:"call"}
  }),
  next: id => new Promise((resolve, reject) => {
    const state = c.a.getStore();
    const playId = state.playing.playId;
    if (String(playId) !== id) return resolve(null);
    F({curPlayId:playId,preloadIndex:0},resolve).then(() => resolve(null),reject);
  })
};
"""
selector = "const selector = " + json.dumps({"original": original, "patched": patched}) + ";"
mode = json.dumps({"probe": args.probe, "diagnostics": args.diagnostics, "temporaryBridge": args.temporary_bridge})
def read(path):
    return path.read_text(encoding="utf-8-sig")

vendor = root.parent / 'vendor/crypto-js-4.2.0'
worker = '\n'.join(read(p) for p in [vendor / 'core.js', vendor / 'md5.js', root.parent / 'shared/cache-worker-runtime.js'])
main = "\n".join([f"const gaplessWindowsBuild = {mode};", selector,
                  'globalThis.gaplessCacheWorkerSource = ' + json.dumps(worker) + ';',
                  read(root.parent / 'shared/cache-worker.js'),
                  'new Function("module", "exports", "define", ' + json.dumps(read(root.parent / "vendor/flac-decoder-0.2.11/flac-decoder.min.js")) + ').call(globalThis);',
                  read(root.parent / "shared/audio-resources.js"),
                  read(root.parent / "shared/playback-clock.js"), read(root.parent / "shared/visual-pcm.js"), read(root.parent / "shared/bridge-window.js"), read(root.parent / "shared/native-handback.js"), read(root / "source.js"), read(root / "native-cache.js"), read(root / "toggle.js"), read(root / "probe.js"), read(root / "seek-range.js"), read(root / "streaming.js"), read(root / "player.js")])
output = root.parent / "dist" / f'gapless-player-windows-{manifest["version"]}{"-probe" if args.probe else "-bridge-trial" if args.temporary_bridge else ""}.plugin'
output.parent.mkdir(exist_ok=True)
subprocess.run(["node", "--check", "-"], input=main.encode(), check=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
    archive.writestr("startup_script.js", read(root / "startup.js"))
    archive.writestr("main.js", main)
    archive.write(root.parent / "LICENSE", "LICENSE")
    archive.write(vendor / 'LICENSE', 'vendor/crypto-js-LICENSE')
    for name in ["LICENSE", "libFLAC-COPYING"]:
        archive.write(root.parent / "vendor/flac-decoder-0.2.11" / name, "vendor/flac-" + name)
print(output)
