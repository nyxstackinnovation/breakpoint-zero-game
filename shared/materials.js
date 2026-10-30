// Surface materials for voxels: texture layer, texture scale and impact/footstep class.

export const MAT = {
  plain: 0, concrete: 1, brick: 2, plaster: 3, wood: 4, metal: 5, corrugated: 6, asphalt: 7,
  paving: 8, grass: 9, sand: 10, rock: 11, shingles: 12, leaves: 13, floor: 14, fabric: 15, stone: 16, mud: 17,
};

export const MAT_NAMES = Object.keys(MAT);

// metres covered by one repeat of the texture
export const MAT_SCALE = [2, 2.5, 1.6, 2.5, 1.6, 2, 1.2, 2.5, 2, 1, 2.5, 3, 1.6, 1, 2, 1, 1, 2.5];

// impact / footstep class per material
export const MAT_CLASS = ['concrete', 'concrete', 'concrete', 'concrete', 'wood', 'metal', 'metal', 'concrete',
  'concrete', 'dirt', 'dirt', 'concrete', 'concrete', 'foliage', 'concrete', 'dirt', 'concrete', 'dirt'];
