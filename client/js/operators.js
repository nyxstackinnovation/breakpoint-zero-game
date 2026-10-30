// The five playable operators (modelled in tools/blender/build_operators.py from the reference sheets in
// client/assets/character/). Each player always appears as the same operator: chosen from their id.

export const OPERATORS = [
  // fp: what your own forearms look like in first person (sleeve, cuff/wrap)
  // forearm: 'skin' (bare or rolled-up sleeves) or 'sleeve'
  { name: 'Viper', fp: { skin: 0x9a6d5e, forearm: 'skin', sleeve: 0x9a6d5e, cuff: 0x2a2826, wraps: true, glove: 0x1c1b1a, fingerless: true } },
  { name: 'Ranger', fp: { skin: 0x8b5c4f, forearm: 'skin', rolled: true, sleeve: 0x5b5d3e, cuff: 0xc8c4bb, glove: 0x22201d, fingerless: true } },
  { name: 'Nova', fp: { skin: 0xa87262, forearm: 'sleeve', sleeve: 0xdcd9d3, cuff: 0xc8313a, glove: 0x1c1c1d, fingerless: true } },
  { name: 'Ghost', fp: { skin: 0x9a6759, forearm: 'sleeve', sleeve: 0x26272b, cuff: 0x1a1a1c, glove: 0x1d1c1b, fingerless: false } },
  { name: 'Blaze', fp: { skin: 0x7c4e41, forearm: 'skin', rolled: true, sleeve: 0x1e1e21, cuff: 0xbab7b1, glove: 0x1d1d1e, fingerless: true } },
];

export function operatorFor(id) {
  return OPERATORS[((id - 1) % OPERATORS.length + OPERATORS.length) % OPERATORS.length];
}
