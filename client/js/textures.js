// Texture loading: voxel material texture arrays, decal and particle sprite atlases.

import * as THREE from 'three';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

async function arrayTextureFromStack(url, layerSize, colorSpace) {
  const img = await loadImage(url);
  const layers = Math.floor(img.height / layerSize);
  const c = document.createElement('canvas');
  c.width = layerSize;
  c.height = layerSize * layers;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = new Uint8Array(g.getImageData(0, 0, c.width, c.height).data.buffer);
  const tex = new THREE.DataArrayTexture(data, layerSize, layerSize, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return { tex, layers };
}

let voxelTex = null;
export async function loadVoxelTextures() {
  if (voxelTex) return voxelTex;
  try {
    const [a, n] = await Promise.all([
      arrayTextureFromStack('/assets/textures/voxel_albedo.png', 256, THREE.SRGBColorSpace),
      arrayTextureFromStack('/assets/textures/voxel_normal.png', 256, THREE.NoColorSpace),
    ]);
    voxelTex = { albedo: a.tex, normal: n.tex, layers: a.layers };
  } catch (e) {
    console.warn('voxel textures unavailable, using flat shading', e);
    voxelTex = { albedo: null, normal: null, layers: 0 };
  }
  return voxelTex;
}

const cache = new Map();
export function loadTexture(url, srgb = true) {
  if (cache.has(url)) return cache.get(url);
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  cache.set(url, tex);
  return tex;
}
