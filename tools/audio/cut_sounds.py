"""Cut the game's gun and rocket samples out of the recordings in client/assets/sounds/.

    python tools/audio/cut_sounds.py      (needs ffmpeg on PATH, numpy and scipy)

'gun sound.weba' is a 3 s automatic burst at 600 rpm (the rifle's rate): three single shots are cut from
it (start, middle, end of the burst), each followed by the room tail recorded after the last shot.
'rokcet launder.weba' holds a launch (0.2-0.9 s) and a big blast (1.7-3.5 s): used for the rocket launch
and the explosion. Everything is normalised to -1 dBFS, mono, 48 kHz.
"""
import os, subprocess, tempfile, wave
import numpy as np
from scipy.signal import find_peaks

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
SND = os.path.join(ROOT, 'client', 'assets', 'sounds')
SR = 48000


def decode(name):
    tmp = os.path.join(tempfile.gettempdir(), 'bpz_' + name.replace(' ', '_') + '.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(SND, name), '-ac', '1', '-ar', str(SR), tmp], check=True)
    w = wave.open(tmp)
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768


def save(name, x, peak_db=-1.0):
    x = x / np.abs(x).max() * 10 ** (peak_db / 20)
    w = wave.open(os.path.join(SND, name), 'wb')
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    w.close()


def fade(x, fin, fout):
    x = x.copy(); a, b = int(fin * SR), int(fout * SR)
    if a: x[:a] *= np.linspace(0, 1, a) ** 0.5
    if b: x[-b:] *= np.linspace(1, 0, b) ** 2
    return x


g = decode('gun sound.weba')
hp = np.diff(g, prepend=0)
env = np.sqrt(np.convolve(hp * hp, np.ones(48) / 48, 'same'))[::48]       # 1 ms steps
pk, _ = find_peaks(env, distance=70, height=np.percentile(env[300:3300], 60))
pk = [p for p in pk if 250 < p < 3450]
tail = g[int((pk[-1] + 95) * SR / 1000):int((pk[-1] + 700) * SR / 1000)]
for k, idx in enumerate([0, len(pk) // 2, len(pk) - 1]):
    s0 = int((pk[idx] - 3) * SR / 1000)
    body = g[s0:s0 + int(0.098 * SR)]
    xf = int(0.012 * SR)
    shot = np.concatenate([body[:-xf], body[-xf:] * np.linspace(1, 0, xf) + tail[:xf] * np.linspace(0, 1, xf), tail[xf:]])
    save(f'rifle_{k + 1}.wav', fade(shot, 0.001, 0.25))
r = decode('rokcet launder.weba')
save('rocket_launch.wav', fade(r[int(0.21 * SR):int(0.95 * SR)], 0.003, 0.3))
save('rocket_boom.wav', fade(r[int(1.70 * SR):int(3.55 * SR)], 0.004, 0.6), peak_db=-0.5)
print('wrote rifle_1..3.wav, rocket_launch.wav, rocket_boom.wav')
