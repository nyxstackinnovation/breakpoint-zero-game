// A* pathfinding directly over the live voxel grid, so paths always reflect destruction.
// Nodes are standable voxel cells; edges are walks, one-voxel steps, two-voxel jumps and drops.

let scratch = null;

function getScratch(size) {
  if (!scratch || scratch.size !== size) {
    scratch = {
      size,
      g: new Float32Array(size),
      parent: new Int32Array(size),
      stamp: new Uint32Array(size),
      closed: new Uint32Array(size),
      gen: 0,
    };
  }
  return scratch;
}

class MinHeap {
  constructor() { this.f = []; this.i = []; }
  get size() { return this.f.length; }
  push(f, i) {
    const F = this.f, I = this.i;
    let n = F.length;
    F.push(f); I.push(i);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (F[p] <= F[n]) break;
      [F[p], F[n]] = [F[n], F[p]]; [I[p], I[n]] = [I[n], I[p]];
      n = p;
    }
  }
  pop() {
    const F = this.f, I = this.i;
    const top = I[0];
    const lf = F.pop(), li = I.pop();
    if (F.length) {
      F[0] = lf; I[0] = li;
      let n = 0;
      const len = F.length;
      for (;;) {
        const l = 2 * n + 1, r = l + 1;
        let m = n;
        if (l < len && F[l] < F[m]) m = l;
        if (r < len && F[r] < F[m]) m = r;
        if (m === n) break;
        [F[m], F[n]] = [F[n], F[m]]; [I[m], I[n]] = [I[n], I[m]];
        n = m;
      }
    }
    return top;
  }
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function bodyClear(w, x, y, z) {
  if (x < 0 || z < 0 || x >= w.sx || z >= w.sz || y < 1 || y + 3 >= w.sy) return false;
  const d = w.data;
  const base = x + w.sx * z;
  const L = w.layer;
  return d[base + L * y] === 0 && d[base + L * (y + 1)] === 0 && d[base + L * (y + 2)] === 0 && d[base + L * (y + 3)] === 0;
}

function standable(w, x, y, z) {
  if (!bodyClear(w, x, y, z)) return false;
  return w.data[x + w.sx * (z + w.sz * (y - 1))] !== 0;
}

// standable with enough horizontal clearance for a 0.6 m wide body
function roomy(w, x, y, z) {
  if (!standable(w, x, y, z)) return false;
  const ox = bodyClear(w, x + 1, y, z) || bodyClear(w, x - 1, y, z);
  const oz = bodyClear(w, x, y, z + 1) || bodyClear(w, x, y, z - 1);
  return ox && oz;
}

export function nearestStandable(w, x, y, z, range = 6) {
  if (standable(w, x, y, z)) return [x, y, z];
  for (let r = 1; r <= range; r++) {
    for (let dy = -r; dy <= r; dy++) {
      if (standable(w, x, y + dy, z)) return [x, y + dy, z];
    }
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (let dy = -2; dy <= 2; dy++) if (standable(w, x + dx, y + dy, z + dz)) return [x + dx, y + dy, z + dz];
    }
  }
  return null;
}

export function findPath(w, start, goal, maxExpand = 7000) {
  const s = nearestStandable(w, start[0], start[1], start[2], 3);
  const g = nearestStandable(w, goal[0], goal[1], goal[2], 6) || goal;
  if (!s) return null;
  const S = getScratch(w.size);
  S.gen++;
  const gen = S.gen;
  const idx = (x, y, z) => x + w.sx * (z + w.sz * y);
  const heap = new MinHeap();
  const si = idx(s[0], s[1], s[2]);
  const h = (x, y, z) => {
    const dx = Math.abs(x - g[0]), dz = Math.abs(z - g[2]);
    return (dx + dz) + (1.4142 - 2) * Math.min(dx, dz) + Math.abs(y - g[1]) * 0.5;
  };
  S.g[si] = 0; S.stamp[si] = gen; S.parent[si] = -1;
  heap.push(h(s[0], s[1], s[2]), si);
  let best = si, bestH = h(s[0], s[1], s[2]);
  let expanded = 0;
  const c = [0, 0, 0];
  while (heap.size && expanded < maxExpand) {
    const cur = heap.pop();
    if (S.closed[cur] === gen) continue;
    S.closed[cur] = gen;
    expanded++;
    w.coords(cur, c);
    const x = c[0], y = c[1], z = c[2];
    const hh = h(x, y, z);
    if (hh < bestH) { bestH = hh; best = cur; }
    if (Math.abs(x - g[0]) <= 1 && Math.abs(z - g[2]) <= 1 && Math.abs(y - g[1]) <= 2) { best = cur; break; }
    const gc = S.g[cur];
    const headroom1 = bodyClear(w, x, y + 1, z);
    const headroom2 = headroom1 && bodyClear(w, x, y + 2, z);
    for (let k = 0; k < 8; k++) {
      const dx = DIRS[k][0], dz = DIRS[k][1];
      const diag = dx !== 0 && dz !== 0;
      const nx = x + dx, nz = z + dz;
      if (diag && (!bodyClear(w, x + dx, y, z) || !bodyClear(w, x, y, z + dz))) continue;
      const base = diag ? 1.4142 : 1;
      let ny = -1, cost = 0;
      if (bodyClear(w, nx, y, nz)) {
        if (roomy(w, nx, y, nz)) { ny = y; cost = base; }
        else if (w.data[idx(nx, y - 1, nz)] === 0) {
          for (let d = 1; d <= 10; d++) {
            const yy = y - d;
            if (yy < 1) break;
            if (w.data[idx(nx, yy - 1, nz)] !== 0) {
              if (roomy(w, nx, yy, nz)) { ny = yy; cost = base + 0.25 * d; }
              break;
            }
          }
        }
      } else if (!diag) {
        if (headroom1 && roomy(w, nx, y + 1, nz)) { ny = y + 1; cost = base + 0.4; }
        else if (headroom2 && roomy(w, nx, y + 2, nz)) { ny = y + 2; cost = base + 2.5; }
      }
      if (ny < 0) continue;
      const ni = idx(nx, ny, nz);
      if (S.closed[ni] === gen) continue;
      const ng = gc + cost;
      if (S.stamp[ni] !== gen || ng < S.g[ni]) {
        S.stamp[ni] = gen; S.g[ni] = ng; S.parent[ni] = cur;
        heap.push(ng + h(nx, ny, nz) * 1.15, ni);
      }
    }
  }
  const path = [];
  let cur = best;
  let guard = 0;
  while (cur !== -1 && guard++ < 5000) {
    path.push(w.coords(cur, [0, 0, 0]));
    if (cur === si) break;
    cur = S.parent[cur];
  }
  path.reverse();
  return path.length ? path : null;
}

export { standable as navStandable };
