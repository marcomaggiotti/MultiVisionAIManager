// A small 3D toon renderer for figures made of spheres and capsules (the cartoon cat).
// The same renderer as the exported video's (manager/api/app/media/cat_render.py), so the
// preview shows what the export will. Orthographic: x and y are the canvas's pixels, z goes
// away from the camera (smaller is nearer). Each primitive is a capsule from a to b whose
// radius goes from ra to rb (a sphere when a == b); the nearest surface wins at each pixel.
// Shaded in three soft bands, lit from the top left, glossy eyes and nose; markings follow
// the surface (stripes across limbs and tail, an oval belly in front, bands on the back,
// forehead stripes); an outline where a part ends or passes in front of another.

export type Vec3 = [number, number, number];
export type Rgb = [number, number, number];
export type Material = "plain" | "limb" | "torso" | "head";
export type Primitive = {
  a: Vec3; b: Vec3; ra: number; rb: number;
  material: Material; color: Rgb;
  group: number; // the part it belongs to: no outline between primitives of one part
  s0: number; s1: number; // the markings' coordinate along the part, at a and at b
  bands: number; // stripes per unit of that coordinate (limb)
  gloss: number;
  outline: boolean;
  hard: boolean; // outlined against any part behind it, however close (the eyes)
};
export type Rendered = { image: ImageData; x0: number; y0: number; shows: (primitive: number, x: number, y: number) => boolean };

export const FUR: Rgb = [240, 160, 75], STRIPE: Rgb = [196, 112, 40], CREAM: Rgb = [255, 232, 204], OUTLINE: Rgb = [59, 36, 20];
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const LIGHT = unit([-0.45, -0.7, -0.55]);
const HALF = unit([LIGHT[0], LIGHT[1], LIGHT[2] - 1]);
const FAR = 1e9;
const MATERIALS: Record<Material, number> = { plain: 0, limb: 1, torso: 2, head: 3 };

const smoothstep = (low: number, high: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

/** Draw the primitives. forward / left / up: the figure's directions (for its markings); gap: how
 * much nearer a part must be than the one behind it to get an outline; glow: the parts lit up;
 * body: the middle of the torso and its length (the belly and the back's bands are placed on it). */
export function render(primitives: Primitive[], forward: Vec3, left: Vec3, up: Vec3, outlineWidth: number, gap: number,
  glow: Map<number, Rgb>, body: { centre: Vec3; length: number }): Rendered | null {
  if (!primitives.length) return null;
  const margin = outlineWidth + 2;
  const x0 = Math.floor(Math.min(...primitives.map((p) => Math.min(p.a[0] - p.ra, p.b[0] - p.rb)))) - margin;
  const y0 = Math.floor(Math.min(...primitives.map((p) => Math.min(p.a[1] - p.ra, p.b[1] - p.rb)))) - margin;
  const x1 = Math.ceil(Math.max(...primitives.map((p) => Math.max(p.a[0] + p.ra, p.b[0] + p.rb)))) + margin;
  const y1 = Math.ceil(Math.max(...primitives.map((p) => Math.max(p.a[1] + p.ra, p.b[1] + p.rb)))) + margin;
  const width = x1 - x0, height = y1 - y0, count = width * height;
  const depth = new Float32Array(count).fill(FAR);
  const index = new Int32Array(count).fill(-1);
  const nx = new Float32Array(count), ny = new Float32Array(count), nz = new Float32Array(count), along = new Float32Array(count);

  primitives.forEach((p, number) => {
    const bx0 = Math.max(0, Math.floor(Math.min(p.a[0] - p.ra, p.b[0] - p.rb)) - x0);
    const by0 = Math.max(0, Math.floor(Math.min(p.a[1] - p.ra, p.b[1] - p.rb)) - y0);
    const bx1 = Math.min(width, Math.ceil(Math.max(p.a[0] + p.ra, p.b[0] + p.rb)) - x0 + 1);
    const by1 = Math.min(height, Math.ceil(Math.max(p.a[1] + p.ra, p.b[1] + p.rb)) - y0 + 1);
    const dx = p.b[0] - p.a[0], dy = p.b[1] - p.a[1], dz = p.b[2] - p.a[2], length2 = dx * dx + dy * dy;
    // a slanted capsule: on each row, only the pixels near its axis (within its largest radius)
    const axis = Math.sqrt(length2), normalX = axis > 1e-6 ? -dy / axis : 0, normalY = axis > 1e-6 ? dx / axis : 1;
    const reach = Math.max(p.ra, p.rb) + 1;
    for (let row = by0; row < by1; row++) {
      const y = row + y0 + 0.5;
      let first = bx0, last = bx1;
      if (Math.abs(normalX) > 1e-3) {
        const offset = (y - p.a[1]) * normalY;
        const xa = p.a[0] + (-reach - offset) / normalX, xb = p.a[0] + (reach - offset) / normalX;
        first = Math.max(bx0, Math.floor(Math.min(xa, xb)) - x0 - 1);
        last = Math.min(bx1, Math.ceil(Math.max(xa, xb)) - x0 + 2);
      }
      for (let column = first; column < last; column++) {
        const x = column + x0 + 0.5;
        // the point of the axis nearest the pixel, in the picture (a sphere: its centre; pointing at the camera: the nearer end)
        const s = length2 < 1e-6 ? (dz >= 0 ? 0 : 1) : Math.min(1, Math.max(0, ((x - p.a[0]) * dx + (y - p.a[1]) * dy) / length2));
        const radius = p.ra + s * (p.rb - p.ra);
        const px = x - (p.a[0] + s * dx), py = y - (p.a[1] + s * dy);
        const inside = radius * radius - (px * px + py * py);
        if (inside <= 0) continue;
        const lift = Math.sqrt(inside), z = p.a[2] + s * dz - lift, k = row * width + column;
        if (z >= depth[k]) continue;
        depth[k] = z; index[k] = number;
        nx[k] = px / radius; ny[k] = py / radius; nz[k] = -lift / radius;
        along[k] = p.s0 + s * (p.s1 - p.s0);
      }
    }
  });

  // per primitive: what the shading needs, in flat arrays (no allocation per pixel)
  const materialOf = new Int8Array(primitives.length), groupOf = new Int32Array(primitives.length);
  const colorOf = new Float32Array(primitives.length * 3), bandsOf = new Float32Array(primitives.length), glossOf = new Float32Array(primitives.length);
  const outlinedOf = new Uint8Array(primitives.length), neededOf = new Float32Array(primitives.length);
  const tintOf = new Float32Array(primitives.length * 3), tintedOf = new Uint8Array(primitives.length);
  primitives.forEach((p, i) => {
    materialOf[i] = MATERIALS[p.material]; groupOf[i] = p.group; bandsOf[i] = p.bands; glossOf[i] = p.gloss;
    outlinedOf[i] = p.outline ? 1 : 0; neededOf[i] = p.hard ? 0 : gap;
    colorOf.set(p.color, i * 3);
    const tint = glow.get(p.group);
    if (tint) { tintOf.set(tint, i * 3); tintedOf[i] = 1; }
  });
  // how far each pixel's own part goes on, up to the outline's width, in each direction: a pixel
  // inside its part (that far all round) cannot be on an outline, and skips the neighbours' check
  const partAt = new Int32Array(count);
  for (let k = 0; k < count; k++) partAt[k] = index[k] >= 0 ? groupOf[index[k]] : -1;
  const inside = new Uint8Array(count).fill(1);
  const runs = (start: number, stride: number, steps: number) => { // one line of pixels, both ways
    let run = 0;
    for (let i = 0, k = start; i < steps; i++, k += stride) {
      run = i > 0 && partAt[k] >= 0 && partAt[k] === partAt[k - stride] ? run + 1 : 0;
      if (run < outlineWidth) inside[k] = 0;
    }
    run = 0;
    for (let i = steps - 1, k = start + stride * (steps - 1); i >= 0; i--, k -= stride) {
      run = i < steps - 1 && partAt[k] >= 0 && partAt[k] === partAt[k + stride] ? run + 1 : 0;
      if (run < outlineWidth) inside[k] = 0;
    }
  };
  for (let row = 0; row < height; row++) runs(row * width, 1, width);
  for (let column = 0; column < width; column++) runs(column, width, height);
  const [fx, fy, fz] = forward, [lx, ly, lz] = left, [ux, uy, uz] = up;
  const [lightX, lightY, lightZ] = LIGHT, [halfX, halfY, halfZ] = HALF;
  const [cx, cy, cz] = body.centre, length = body.length;

  const image = new ImageData(width, height);
  const pixels = image.data;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const k = row * width + column, number = index[k];
      if (number < 0) continue;
      const n0 = nx[k], n1 = ny[k], n2 = nz[k];
      const front = n0 * fx + n1 * fy + n2 * fz, side = n0 * lx + n1 * ly + n2 * lz, top = n0 * ux + n1 * uy + n2 * uz;
      const material = materialOf[number];
      let r = FUR[0], g = FUR[1], b = FUR[2], marking = 0; // 0: the fur (or the part's colour), 1: stripe, 2: cream
      if (material === 0) { r = colorOf[number * 3]; g = colorOf[number * 3 + 1]; b = colorOf[number * 3 + 2]; }
      else if (material === 1) {
        if (bandsOf[number] > 0 && (((along[k] * bandsOf[number]) % 1) + 1) % 1 < 0.24) marking = 1;
      } else if (material === 2) { // by where the surface is on the body
        const rx = column + x0 + 0.5 - cx, ry = row + y0 + 0.5 - cy, rz = depth[k] - cz;
        const across = (rx * lx + ry * ly + rz * lz) / length, alongBody = (rx * ux + ry * uy + rz * uz) / length;
        const ahead = (rx * fx + ry * fy + rz * fz) / length;
        if (ahead > 0.05 && (across / 0.3) ** 2 + ((alongBody + 0.02) / 0.42) ** 2 < 1) marking = 2;
        else if (ahead < -0.05 && ((((alongBody / 0.16 + 0.3) % 1) + 1) % 1) < 0.36) marking = 1;
      } else if (top > 0.62 && front > -0.35 && (Math.abs(side) < 0.07 || Math.abs(Math.abs(side) - 0.26) < 0.05)) marking = 1;
      if (marking === 1) { r = STRIPE[0]; g = STRIPE[1]; b = STRIPE[2]; }
      else if (marking === 2) { r = CREAM[0]; g = CREAM[1]; b = CREAM[2]; }
      const tinted = tintedOf[number] === 1;
      if (tinted) { r = r * 0.72 + tintOf[number * 3] * 0.28; g = g * 0.72 + tintOf[number * 3 + 1] * 0.28; b = b * 0.72 + tintOf[number * 3 + 2] * 0.28; }
      // the outline: a neighbour (within the width) where the figure ends, or a part behind
      let edge = false;
      if (outlinedOf[number] && !inside[k]) {
        const needed = neededOf[number], group = groupOf[number], here = depth[k];
        for (let step = 1; step <= outlineWidth && !edge; step++) {
          for (let direction = 0; direction < 4 && !edge; direction++) {
            const r2 = row + (direction === 0 ? step : direction === 1 ? -step : 0);
            const c2 = column + (direction === 2 ? step : direction === 3 ? -step : 0);
            if (r2 < 0 || r2 >= height || c2 < 0 || c2 >= width) { edge = true; break; }
            const other = r2 * width + c2, otherNumber = index[other];
            if (otherNumber < 0 || (groupOf[otherNumber] !== group && depth[other] - here > needed)) edge = true;
          }
        }
      }
      const at = k * 4;
      if (edge) {
        if (tinted) { pixels[at] = tintOf[number * 3]; pixels[at + 1] = tintOf[number * 3 + 1]; pixels[at + 2] = tintOf[number * 3 + 2]; }
        else { pixels[at] = OUTLINE[0]; pixels[at + 1] = OUTLINE[1]; pixels[at + 2] = OUTLINE[2]; }
      } else {
        const diffuse = n0 * lightX + n1 * lightY + n2 * lightZ;
        const level = 0.58 + 0.42 * smoothstep(0, 0.25, diffuse) + 0.1 * smoothstep(0.78, 0.86, diffuse);
        const halfway = n0 * halfX + n1 * halfY + n2 * halfZ;
        const shine = glossOf[number] > 0 && halfway > 0 ? 255 * glossOf[number] * Math.pow(halfway, 40) : 0;
        pixels[at] = r * level + shine; pixels[at + 1] = g * level + shine; pixels[at + 2] = b * level + shine; // clamped by the array
      }
      pixels[at + 3] = 255;
    }
  }
  return {
    image, x0, y0,
    shows: (primitive, x, y) => {
      const column = Math.floor(x) - x0, row = Math.floor(y) - y0;
      return row >= 0 && row < height && column >= 0 && column < width && index[row * width + column] === primitive;
    },
  };
}
