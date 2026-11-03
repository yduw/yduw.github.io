/*
 * "On the shoulders of giants": a small 3D scene (a boy standing on the shoulder of a mossy stone
 * giant, both watching the sun rise over a misty valley) rendered with WebGL2 as a pen-and-ink drawing.
 *
 * Pass 1 ray-marches signed distance fields. For every pixel it writes the ink "fill" (form-following
 * hatching, stipple, cracks, sky strokes, sun rays), an object id, depth and normal.
 * Pass 2 draws outlines from depth/normal/id discontinuities, adds grass blades, and composites ink
 * on paper.
 *
 * No dependencies. Exposes window.renderGiant(canvas, options) -> Promise.
 */
(function () {
  'use strict';

  var VERT = [
    '#version 300 es',
    'in vec2 aPos;',
    'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var COMMON = `
precision highp float;
precision highp int;
const float ID_SKY = 0.0, ID_TERRAIN = 1.0, ID_GIANT = 2.0, ID_BOY = 3.0, ID_DARK = 4.0,
            ID_TREE = 5.0, ID_TRUNK = 6.0, ID_CLOUD = 7.0, ID_MIST = 8.0, ID_SCARF = 9.0, ID_RIDGE = 10.0;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float noise1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), f); }
float noise2(vec2 x) {
  vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise2(p); p = p * 2.03 + vec2(1.3, 7.1); a *= 0.5; } return s / 0.9375; }
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * noise3(p); p = p * 2.02 + vec3(3.1, 1.7, 5.3); a *= 0.5; } return s / 0.875; }

// coverage of anti-aliased lines at integer values of s. fw: change of s per pixel, frac: inked fraction.
float lineAA(float s, float fw, float frac) {
  float d = abs(s - floor(s + 0.5));
  float hw = 0.5 * clamp(frac, 0.0, 1.0);
  float aa = 0.7 * fw;
  return (1.0 - smoothstep(hw - aa, hw + aa, d)) * smoothstep(0.0, 0.08, frac);
}
`;

  var PASS1 = '#version 300 es\n' + COMMON + `
uniform vec2 uRes;
uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform float uFocal, uScale;
uniform vec3 uSun;
uniform vec3 uBoyPos;
uniform float uBoyYaw;
uniform vec3 uTreePos;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

const float MIST_Y = 3.4;
const float BOY_S = 1.6;
const float SUN_R = 0.019;
const vec3 HEAD_C = vec3(0.0, 11.0, -0.55);

// ---------------- primitives ----------------
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-6); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a; float l2 = dot(ba, ba); float rr = r1 - r2; float a2 = l2 - rr * rr; float il2 = 1.0 / l2;
  vec3 pa = p - a; float y = dot(pa, ba); float z = y - l2;
  vec3 xv = pa * l2 - ba * y; float x2 = dot(xv, xv);
  float y2 = y * y * l2; float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
float sdRoundBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float sdTorus(vec3 p, vec2 t) { vec2 q = vec2(length(p.xz) - t.x, p.y); return length(q) - t.y; }
float sdRibbon(vec3 p, vec3 a, vec3 b, float hw, float ht, float tw0, float tw1) {
  vec3 ba = b - a;
  float h = clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0);
  vec3 d = p - (a + ba * h);
  vec3 T = normalize(ba);
  vec3 W0 = normalize(vec3(0.0, 1.0, 0.0) - T * T.y);
  vec3 T0 = cross(T, W0);
  float tw = mix(tw0, tw1, h);
  vec3 Wd = cos(tw) * W0 + sin(tw) * T0;
  vec3 Th = cross(T, Wd);
  vec3 q = abs(vec3(dot(d, Wd), dot(d, Th), dot(d, T))) - vec3(hw, ht, 0.0);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - 0.004;
}
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// ---------------- terrain ----------------
float terrainH(vec2 q) {
  float x = q.x, z = q.y;
  float h = 1.2 * smoothstep(4.0, 22.0, z);
  h -= 30.0 * smoothstep(-6.0, -24.0, z);
  h -= 0.008 * x * x;
  h += 1.5 * (fbm2(q * 0.06) - 0.5) + 0.35 * (noise2(q * 0.5) - 0.5);
  return h;
}

// ---------------- the giant ----------------
float sdGiant(vec3 p) {
  float bd = length(p - vec3(0.0, 6.0, -1.6)) - 9.6;
  if (bd > 1.0) return bd;
  float d = sdEllipsoid(p - vec3(0.0, 2.0, 0.1), vec3(3.3, 2.1, 2.7));
  d = smin(d, sdEllipsoid(p - vec3(0.0, 4.4, 0.25), vec3(3.0, 2.7, 2.2)), 1.2);
  d = smin(d, sdEllipsoid(p - vec3(0.0, 6.7, -0.05), vec3(3.45, 2.55, 2.3)), 1.4);
  vec3 nb = vec3(0.0, 8.55, -0.15);
  vec3 sl = vec3(-3.7, 7.95, -0.25), sr = vec3(3.7, 7.95, -0.25);
  d = smin(d, sdCapsule(p, nb, sl, 0.95), 0.9);
  d = smin(d, sdCapsule(p, nb, sr, 0.95), 0.9);
  d = smin(d, length(p - vec3(-3.95, 7.75, -0.25)) - 1.22, 0.6);
  d = smin(d, length(p - vec3(3.95, 7.75, -0.25)) - 1.22, 0.6);
  d = smin(d, sdEllipsoid(p - vec3(0.0, 6.6, 1.2), vec3(2.9, 2.4, 1.3)), 1.2);
  d = smax(d, -sdCapsule(p, vec3(0.0, 3.0, 2.85), vec3(0.0, 7.8, 2.6), 0.22), 0.6);
  d = smin(d, sdCapsule(p, vec3(0.0, 8.3, -0.15), vec3(0.0, 9.9, -0.5), 0.82), 0.6);
  d = smin(d, sdEllipsoid(p - HEAD_C, vec3(1.22, 1.36, 1.28)), 0.5);
  float hairCap = sdEllipsoid(p - (HEAD_C + vec3(0.0, 0.18, 0.08)), vec3(1.33, 1.3, 1.38));
  hairCap = smax(hairCap, (HEAD_C.y - 0.5 - 0.35 * (p.z - HEAD_C.z)) - p.y, 0.25);
  hairCap += 0.16 * (noise3(p * 3.2) - 0.5);
  d = smin(d, hairCap, 0.12);
  d = smin(d, sdEllipsoid(p - (HEAD_C + vec3(-1.08, -0.08, 0.15)), vec3(0.2, 0.42, 0.3)), 0.12);
  d = smin(d, sdEllipsoid(p - (HEAD_C + vec3(1.08, -0.08, 0.15)), vec3(0.2, 0.42, 0.3)), 0.12);
  vec3 el = vec3(-4.6, 4.9, -1.8), er = vec3(4.6, 4.9, -1.8);
  d = smin(d, sdRoundCone(p, vec3(-3.95, 7.6, -0.3), el, 1.05, 0.8), 0.5);
  d = smin(d, sdRoundCone(p, vec3(3.95, 7.6, -0.3), er, 1.05, 0.8), 0.5);
  d = smin(d, sdRoundCone(p, el, vec3(-2.7, 4.1, -5.0), 0.8, 0.62), 0.3);
  d = smin(d, sdRoundCone(p, er, vec3(2.7, 4.1, -5.0), 0.8, 0.62), 0.3);
  vec3 kl = vec3(-2.35, 3.5, -5.3), kr = vec3(2.35, 3.5, -5.3);
  d = smin(d, sdRoundCone(p, vec3(-1.9, 1.7, -0.9), kl, 1.45, 1.0), 0.8);
  d = smin(d, sdRoundCone(p, vec3(1.9, 1.7, -0.9), kr, 1.45, 1.0), 0.8);
  d = smin(d, sdRoundCone(p, kl, vec3(-2.15, 0.6, -7.1), 0.95, 0.7), 0.4);
  d = smin(d, sdRoundCone(p, kr, vec3(2.15, 0.6, -7.1), 0.95, 0.7), 0.4);
  d += (0.11 * (noise3(p * 0.85) - 0.5) + 0.05 * (noise3(p * 2.4) - 0.5)) * smoothstep(1.5, 0.3, d);
  return d;
}

float giantSurfaceY(vec2 xz) {
  float y = 13.5;
  for (int i = 0; i < 48; i++) {
    float d = sdGiant(vec3(xz.x, y, xz.y));
    if (d < 0.002) break;
    y -= max(d * 0.9, 0.004);
  }
  return y;
}

// ---------------- the boy (unit height, scaled) ----------------
vec3 gBoy, gTree;
vec2 sdBoy(vec3 pw) {
  vec3 p = pw - gBoy;
  float bd = length(p - vec3(0.0, 0.8, 0.0)) - 1.35;
  if (bd > 0.4) return vec2(bd, 0.0);
  p.xz = rot(uBoyYaw) * p.xz;
  p /= BOY_S;
  float d = sdRoundCone(p, vec3(0.0, 0.5, 0.0), vec3(0.0, 0.72, 0.0), 0.092, 0.108);
  d = smin(d, sdEllipsoid(p - vec3(0.0, 0.728, 0.0), vec3(0.138, 0.05, 0.075)), 0.03);
  d = smin(d, sdRoundCone(p, vec3(-0.058, 0.5, 0.0), vec3(-0.085, 0.07, 0.01), 0.055, 0.038), 0.02);
  d = smin(d, sdRoundCone(p, vec3(0.058, 0.5, 0.0), vec3(0.092, 0.07, -0.015), 0.055, 0.038), 0.02);
  // arms akimbo: elbows out, hands resting on the hips
  vec3 shR = vec3(0.118, 0.71, 0.0), elR = vec3(0.235, 0.6, 0.03), haR = vec3(0.112, 0.505, 0.0);
  d = smin(d, sdCapsule(p, shR, elR, 0.034), 0.02);
  d = smin(d, sdCapsule(p, elR, haR, 0.029), 0.012);
  vec3 shL = vec3(-0.118, 0.71, 0.0), elL = vec3(-0.235, 0.6, 0.03), haL = vec3(-0.112, 0.505, 0.0);
  d = smin(d, sdCapsule(p, shL, elL, 0.034), 0.02);
  d = smin(d, sdCapsule(p, elL, haL, 0.029), 0.012);
  d = min(d, sdRoundBox(p - vec3(0.0, 0.62, 0.105), vec3(0.06, 0.07, 0.03), 0.018));
  d = min(d, sdCapsule(p, vec3(0.085, 0.725, 0.06), vec3(0.04, 0.68, 0.1), 0.01));
  d = min(d, sdCapsule(p, vec3(-0.085, 0.725, 0.06), vec3(-0.04, 0.68, 0.1), 0.01));
  d = smin(d, sdCapsule(p, vec3(0.0, 0.73, 0.0), vec3(0.0, 0.82, -0.005), 0.038), 0.02);
  d = min(d, length(p - vec3(0.0, 0.885, -0.008)) - 0.082);
  // dark parts: hair, scarf, boots
  float hair = sdEllipsoid(p - vec3(0.0, 0.905, 0.016), vec3(0.09, 0.08, 0.09)) + 0.012 * (noise3(p * 55.0) - 0.5);
  hair = min(hair, sdCapsule(p, vec3(-0.03, 0.925, 0.06), vec3(-0.105, 0.945, 0.125), 0.019));
  hair = min(hair, sdCapsule(p, vec3(0.025, 0.95, 0.05), vec3(-0.035, 0.985, 0.125), 0.016));
  hair = min(hair, sdCapsule(p, vec3(-0.06, 0.885, 0.05), vec3(-0.13, 0.87, 0.1), 0.016));
  float scarf = sdTorus(p - vec3(0.0, 0.765, 0.0), vec2(0.06, 0.026));
  vec3 s0 = vec3(-0.03, 0.755, 0.06), s1 = vec3(-0.1, 0.705, 0.12), s2 = vec3(-0.18, 0.745, 0.17),
       s3 = vec3(-0.27, 0.69, 0.2), s4 = vec3(-0.36, 0.73, 0.22), s5 = vec3(-0.45, 0.675, 0.23);
  scarf = min(scarf, sdRibbon(p, s0, s1, 0.036, 0.007, 0.0, 0.5));
  scarf = min(scarf, sdRibbon(p, s1, s2, 0.034, 0.007, 0.5, 1.1));
  scarf = min(scarf, sdRibbon(p, s2, s3, 0.03, 0.006, 1.1, 0.3));
  scarf = min(scarf, sdRibbon(p, s3, s4, 0.027, 0.006, 0.3, -0.5));
  scarf = min(scarf, sdRibbon(p, s4, s5, 0.022, 0.005, -0.5, 0.2));
  vec3 t1 = vec3(-0.07, 0.66, 0.1), t2 = vec3(-0.14, 0.6, 0.14), t3 = vec3(-0.22, 0.625, 0.17);
  scarf = min(scarf, sdRibbon(p, s0, t1, 0.026, 0.006, 0.2, 0.8));
  scarf = min(scarf, sdRibbon(p, t1, t2, 0.024, 0.006, 0.8, 0.2));
  scarf = min(scarf, sdRibbon(p, t2, t3, 0.02, 0.005, 0.2, -0.4));
  float boots = min(sdEllipsoid(p - vec3(-0.085, 0.032, -0.02), vec3(0.05, 0.034, 0.085)),
                    sdEllipsoid(p - vec3(0.094, 0.032, -0.045), vec3(0.05, 0.034, 0.085)));
  float dk = min(hair, boots);
  float m = 0.0;
  float r = d;
  if (dk < r) { r = dk; m = 1.0; }
  if (scarf < r) { r = scarf; m = 2.0; }
  return vec2(r * BOY_S, m);
}

// ---------------- little tree on the giant's other shoulder ----------------
const float TREE_S = 0.6;
vec2 sdTree(vec3 pw) {
  vec3 p = (pw - gTree) / TREE_S;
  float bd = length(p - vec3(0.0, 1.3, 0.0)) - 1.7;
  if (bd > 0.4) return vec2(bd * TREE_S, 0.0);
  float trunk = sdRoundCone(p, vec3(0.0, -0.3, 0.0), vec3(-0.1, 1.15, 0.05), 0.13, 0.055);
  trunk = min(trunk, sdCapsule(p, vec3(-0.05, 0.6, 0.02), vec3(0.3, 1.0, -0.05), 0.04));
  trunk = min(trunk, sdCapsule(p, vec3(-0.08, 0.82, 0.03), vec3(-0.42, 1.12, 0.1), 0.035));
  float fol = length(p - vec3(-0.08, 1.48, 0.0)) - 0.55;
  fol = smin(fol, length(p - vec3(0.34, 1.26, -0.05)) - 0.37, 0.18);
  fol = smin(fol, length(p - vec3(-0.48, 1.26, 0.08)) - 0.36, 0.18);
  fol = smin(fol, length(p - vec3(0.06, 1.8, -0.02)) - 0.36, 0.18);
  fol += 0.16 * (fbm3(p * 4.5) - 0.5);
  fol *= 0.8;
  return fol < trunk ? vec2(fol * TREE_S, 1.0) : vec2(trunk * TREE_S, 0.0);
}

// ---------------- clouds ----------------
float sdClouds(vec3 p) {
  vec3 q = p - vec3(-99.0, 112.0, -545.0);
  float d = length(q) - 125.0;
  if (d < 8.0) {
    float c = sdEllipsoid(q - vec3(0.0, -14.0, 0.0), vec3(70.0, 16.0, 34.0));
    c = smin(c, length(q - vec3(-34.0, 4.0, 6.0)) - 26.0, 6.0);
    c = smin(c, length(q - vec3(-6.0, 16.0, 0.0)) - 32.0, 6.0);
    c = smin(c, length(q - vec3(30.0, 6.0, 8.0)) - 24.0, 6.0);
    c = smin(c, length(q - vec3(56.0, -6.0, 10.0)) - 15.0, 5.0);
    c = smin(c, length(q - vec3(-60.0, -8.0, 8.0)) - 15.0, 5.0);
    c = smin(c, length(q - vec3(8.0, 46.0, -4.0)) - 22.0, 6.0);
    c = smin(c, length(q - vec3(-22.0, 34.0, 4.0)) - 18.0, 6.0);
    c = smin(c, length(q - vec3(28.0, 34.0, 0.0)) - 16.0, 5.0);
    c = smax(c, -(q.y + 24.0), 4.0);
    c += 5.0 * (fbm3(q * 0.045) - 0.5);
    d = c;
  }
  // long thin streaks low in the sky
  vec3 s = p - vec3(150.0, 30.0, -620.0);
  float ds = 1e9;
  if (false) {
    float st = sdEllipsoid(s, vec3(170.0, 5.5, 60.0));
    st = smin(st, sdEllipsoid(s - vec3(-120.0, 13.0, 10.0), vec3(110.0, 4.0, 40.0)), 6.0);
    st += 5.0 * (fbm3(s * vec3(0.012, 0.08, 0.03)) - 0.5);
    ds = st;
  }
  return min(d, ds);
}

// ---------------- distant ridges (analytic curtains) ----------------
const vec4 RIDGE[4] = vec4[4](vec4(110.0, -2.0, 14.0, 1.0 / 34.0), vec4(190.0, 0.0, 25.0, 1.0 / 55.0),
                              vec4(320.0, 2.0, 37.0, 1.0 / 90.0), vec4(560.0, 4.0, 60.0, 1.0 / 150.0));
float sunAz() { return atan(uSun.x, -uSun.z); }
float ridgeH(int k, float x) {
  vec4 r = RIDGE[k];
  float u = x * r.w + float(k) * 17.3 + 4.0;
  float s = 0.0, a = 0.55, f = 1.0;
  for (int i = 0; i < 5; i++) { float n = noise1(u * f); n = 1.0 - abs(2.0 * n - 1.0); s += a * n * n; a *= 0.5; f *= 2.13; }
  // a gap in the ranges where the sun comes up
  float az = atan(x - uCamPos.x, uCamPos.z + r.x);
  float gap = 1.0 - 0.7 * exp(-pow((az - sunAz() + 0.005) / 0.045, 2.0));
  float h = r.y + r.z * s * gap;
  // conifers along the two nearer ridgelines
  if (k < 2) {
    float w = k == 0 ? 1.3 : 2.2;
    float cell = floor(x / w);
    for (int j = -1; j <= 1; j++) {
      float cc = cell + float(j);
      float hh = hash11(cc * 1.7 + float(k) * 9.0);
      if (hh < 0.45) continue;
      float cx = (cc + 0.5 + 0.3 * (hash11(cc + 3.1) - 0.5)) * w;
      float th = (k == 0 ? 3.2 : 4.5) * (0.6 + 0.6 * hash11(cc * 2.3));
      float tw = th * 0.24;
      float base = r.y + r.z * s * gap;
      h = max(h, base - 0.6 + th * (1.0 - abs(x - cx) / tw));
    }
  }
  return h;
}

vec2 mapScene(vec3 p) {
  vec2 res = vec2(sdGiant(p), ID_GIANT);
  vec2 b = sdBoy(p);
  if (b.x < res.x) res = vec2(b.x, b.y > 1.5 ? ID_SCARF : (b.y > 0.5 ? ID_DARK : ID_BOY));
  vec2 t = sdTree(p);
  if (t.x < res.x) res = vec2(t.x, t.y > 0.5 ? ID_TREE : ID_TRUNK);
  float c = sdClouds(p);
  if (c < res.x) res = vec2(c, ID_CLOUD);
  return res;
}
float mapShadow(vec3 p) {
  float d = min(sdGiant(p), sdBoy(p).x);
  return min(d, sdTree(p).x);
}
vec3 calcNormal(vec3 p, float t) {
  float e = 0.0012 * t + 0.002;
  vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * mapScene(p + k.xyy * e).x + k.yyx * mapScene(p + k.yyx * e).x +
                   k.yxy * mapScene(p + k.yxy * e).x + k.xxx * mapScene(p + k.xxx * e).x);
}
float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.08;
  for (int i = 0; i < 40; i++) {
    float h = mapShadow(ro + rd * t);
    res = min(res, 9.0 * h / t);
    t += clamp(h, 0.06, 1.6);
    if (res < 0.003 || t > 36.0) break;
  }
  return clamp(res, 0.0, 1.0);
}
float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) { float h = 0.06 + 0.24 * float(i); float d = mapScene(p + n * h).x; occ += (h - d) * sca; sca *= 0.72; }
  return clamp(1.0 - 1.1 * occ, 0.0, 1.0);
}

// hatching whose screen spacing stays close to S0 pixels at any distance or slant
float hatchLOD(float s, float fw, float frac, float S0) {
  float lod = log2(max(fw * S0, 1e-5));
  float L = floor(lod), f = lod - L;
  float sc = exp2(-L);
  float c0 = lineAA(s * sc, fw * sc, frac);
  float c1 = lineAA(s * sc * 0.5, fw * sc * 0.5, frac);
  return mix(c0, c1, f);
}
float worldHatch(vec3 p, vec3 A, vec3 dpdx, vec3 dpdy, float frac, float S0, float wob) {
  float s = dot(p, A) * 4.0 + wob * (noise3(p * 0.6) - 0.5);
  float fw = length(vec2(dot(A, dpdx), dot(A, dpdy))) * 4.0;
  return hatchLOD(s, fw, frac, S0);
}
float screenHatch(vec2 fc, float ang, float S, float frac) {
  vec2 d = vec2(cos(ang), sin(ang));
  float s = dot(fc, d) / S;
  return lineAA(s + 0.35 * (noise2(fc * 0.02) - 0.5), 1.0 / S, frac);
}
float stipple(vec2 q, float cell, float pxPerUnit, float density) {
  vec2 c = floor(q / cell);
  float ink = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cc = c + vec2(float(i), float(j));
    if (hash12(cc) > density) continue;
    vec2 pt = (cc + vec2(hash12(cc + 7.1), hash12(cc + 3.7))) * cell;
    float dpx = length(q - pt) * pxPerUnit;
    float r = (0.7 + 0.7 * hash12(cc + 1.3)) * uScale;
    ink = max(ink, 1.0 - smoothstep(r - 0.6 * uScale, r + 0.6 * uScale, dpx));
  }
  return ink;
}

float skyInk(vec3 rd, vec2 fc) {
  float fpx = uFocal * uRes.y * 0.5;
  float cs = dot(rd, uSun);
  float dpx = acos(clamp(cs, -1.0, 1.0)) * fpx;
  float Rs = SUN_R * fpx;
  float ink = 1.0 - smoothstep(0.7 * uScale, 1.6 * uScale, abs(dpx - Rs));
  ink = max(ink, 0.6 * (1.0 - smoothstep(0.4 * uScale, 1.1 * uScale, abs(dpx - Rs * 1.22))) * step(0.5, noise1(atan(rd.y - uSun.y, rd.x - uSun.x) * 9.0)));
  if (dpx < Rs) return ink;
  vec3 sr = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
  vec3 su = cross(sr, uSun);
  vec3 v = rd - uSun * cs;
  float th = atan(dot(v, su), dot(v, sr));
  float NR = 38.0;
  float idx = floor(th / 6.2831853 * NR + 0.5);
  float thc = idx * 6.2831853 / NR + (hash11(idx + 3.0) - 0.5) * 0.035;
  float lenR = Rs * (1.9 + 5.5 * pow(hash11(idx * 1.37 + 0.5), 1.6)) * (mod(idx, 2.0) < 0.5 ? 1.0 : 0.5);
  float dperp = abs(th - thc) * dpx;
  float wR = mix(1.1, 0.35, smoothstep(Rs * 1.4, lenR, dpx)) * uScale;
  float rayOn = smoothstep(Rs * 1.45, Rs * 1.75, dpx) * (1.0 - smoothstep(lenR * 0.8, lenR, dpx));
  ink = max(ink, rayOn * (1.0 - smoothstep(wR - 0.55 * uScale, wR + 0.55 * uScale, dperp)));
  // horizontal pen strokes in the sky, thinning out toward the sunrise
  float S = 7.0 * uScale;
  float sl = rd.y * fpx / S;
  float li = floor(sl + 0.5);
  float azpx = atan(rd.x, -rd.z) * fpx;
  float dash = smoothstep(0.45, 0.55, noise1(azpx / (70.0 * uScale) + li * 7.31));
  float dark = 0.42 * smoothstep(0.16, 0.34, rd.y);
  float glow = smoothstep(Rs * 3.0, Rs * 16.0, dpx);
  ink = max(ink, lineAA(sl + 0.2 * (noise1(azpx / (25.0 * uScale)) - 0.5), 1.0 / S, dark * dash * glow * 0.4));
  return ink;
}

void encodeOut(float ink, float id, float t, vec3 n, float grass, float fade) {
  float v = clamp(log2(max(t, 1.0)) / 12.0, 0.0, 1.0) * 65535.0;
  float hi = floor(v / 256.0), lo = v - hi * 256.0;
  oA = vec4(clamp(ink, 0.0, 1.0), id / 255.0, hi / 255.0, floor(lo) / 255.0);
  float a = fade > 0.02 ? 0.5 + 0.5 * clamp(fade, 0.0, 1.0) : 0.49 * clamp(grass, 0.0, 1.0);
  oB = vec4(n * 0.5 + 0.5, a);
}

void main() {
  gBoy = vec3(uBoyPos.x, giantSurfaceY(uBoyPos.xz) - 0.035, uBoyPos.z);
  gTree = vec3(uTreePos.x, giantSurfaceY(uTreePos.xz) - 0.12, uTreePos.z);
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (2.0 * fc - uRes) / uRes.y;
  vec3 rdRaw = uv.x * uCamR + uv.y * uCamU + uFocal * uCamF;
  float rl = length(rdRaw);
  vec3 rd = rdRaw / rl;
  vec3 ro = uCamPos;
  float kpx = 2.0 / uRes.y;
  vec3 drdx = (uCamR - rd * dot(rd, uCamR)) / rl * kpx;
  vec3 drdy = (uCamU - rd * dot(rd, uCamU)) / rl * kpx;

  // analytic intersections: ridges and the mist that fills the valley
  float tR = 1e9; int kR = -1;
  if (rd.z < -1e-4) {
    for (int k = 0; k < 4; k++) {
      float t = (ro.z + RIDGE[k].x) / (-rd.z);
      vec3 q = ro + rd * t;
      if (q.y < ridgeH(k, q.x)) { tR = t; kR = k; break; }
    }
  }
  float tM = rd.y < -1e-4 ? (MIST_Y - ro.y) / rd.y : 1e9;

  float tmax = min(min(tR, tM), 1200.0);
  float t = 0.5;
  vec2 hit = vec2(1e9, -1.0);
  for (int i = 0; i < 220; i++) {
    vec3 p = ro + rd * t;
    vec2 h = mapScene(p);
    if (h.x < 0.0007 * t) { hit = vec2(t, h.y); break; }
    t += h.x * 0.85;
    if (t > tmax) break;
  }

  if (hit.y < 0.0) {
    if (tM < tR) {
      // a few wisps drawn across the sea of mist
      vec3 q = ro + rd * tM;
      vec3 qdx = tM * (drdx - rd * drdx.y / rd.y), qdy = tM * (drdy - rd * drdy.y / rd.y);
      float s = q.z * 0.5 + 3.0 * (noise1(q.x * 0.025) - 0.5);
      float fw = length(vec2(qdx.z, qdy.z)) * 0.5;
      float dash = smoothstep(0.55, 0.7, noise2(vec2(q.x * 0.03, q.z * 0.08)));
      float wisp = hatchLOD(s, fw, 0.13 * dash, 22.0 * uScale) * smoothstep(1400.0, 300.0, tM);
      encodeOut(wisp, ID_MIST, tM, vec3(0.0), 0.0, 0.0);
      return;
    }
    if (kR >= 0) {
      vec3 q = ro + rd * tR;
      float k = float(kR);
      float h = ridgeH(kR, q.x);
      float hs = ridgeH(kR, q.x + 2.0) - ridgeH(kR, q.x - 2.0);
      float g = 0.62 - 0.14 * k;
      g += hs > 0.0 ? 0.12 : -0.1;
      float rim = smoothstep(0.0, 2.5 + k * 1.5, h - q.y);
      float mist = smoothstep(MIST_Y - 0.5, MIST_Y + 9.0 + 3.0 * k, q.y);
      float frac = g * mist * mix(0.25, 1.0, rim);
      float ang = hs > 0.0 ? -0.32 : 0.3;
      float ink = screenHatch(fc, ang, (5.5 + 0.8 * k) * uScale, frac * 0.55);
      if (kR == 0) ink = max(ink, screenHatch(fc, 1.45, 6.0 * uScale, smoothstep(0.45, 0.8, frac) * 0.35));
      encodeOut(ink, ID_RIDGE + k, tR, vec3(0.0, 0.0, 1.0), 0.0, 0.0);
      return;
    }
    encodeOut(skyInk(rd, fc), ID_SKY, 4000.0, vec3(0.0), 0.0, 0.0);
    return;
  }

  t = hit.x;
  float id = hit.y;
  vec3 p = ro + rd * t;
  vec3 N = calcNormal(p, t);
  float rn = dot(rd, N);
  rn = sign(rn) * max(abs(rn), 0.08);
  vec3 dpdx = t * (drdx - rd * dot(drdx, N) / rn);
  vec3 dpdy = t * (drdy - rd * dot(drdy, N) / rn);
  float pxPerUnit = 1.0 / max(length(dpdx), 1e-5);

  float dif = clamp(dot(N, uSun), 0.0, 1.0);
  float sh = dif > 0.001 ? softShadow(p + N * 0.03, uSun) : 0.0;
  float ao = calcAO(p, N);
  float rim = pow(clamp(1.0 + dot(rd, N), 0.0, 1.0), 2.5) * clamp(dot(N, uSun) * 1.5 + 0.55, 0.0, 1.0);
  vec3 Lf = normalize(vec3(0.5, 0.8, 0.45));
  float fil = clamp(dot(N, Lf), 0.0, 1.0);
  float tone = (0.33 + 0.55 * fil + 0.12 * N.y) * mix(0.6, 1.0, ao) + 0.85 * dif * sh + 0.6 * rim;
  float press = 0.75 + 0.5 * noise3(p * 1.9 + 4.0);
  float ink = 0.0, grass = 0.0;

  if (id == ID_GIANT) {
    float g = 1.0 - clamp(tone, 0.0, 1.0);
    vec3 A1 = normalize(vec3(0.6, 1.0, 0.2));
    vec3 A2 = normalize(vec3(-0.9, 0.5, 0.3));
    float brk = mix(smoothstep(0.32, 0.5, noise3(p * 2.2 + 1.0)), 1.0, smoothstep(0.45, 0.75, g));
    float c1 = worldHatch(p, A1, dpdx, dpdy, smoothstep(0.3, 0.9, g) * 0.55 * press * brk, 9.0 * uScale, 0.8);
    float c2 = worldHatch(p, A2, dpdx, dpdy, smoothstep(0.56, 0.95, g) * 0.5 * press, 9.5 * uScale, 0.8);
    float c3 = screenHatch(fc, -0.25, 6.0 * uScale, smoothstep(0.8, 1.0, g) * 0.45);
    ink = 1.0 - (1.0 - c1) * (1.0 - c2) * (1.0 - c3);
    // cracks in the stone
    float cn = noise3(p * 0.42 + 7.0);
    float fwc = max(fwidth(cn), 1e-4) * uScale;
    float crack = 1.0 - smoothstep(0.6 * fwc, 1.6 * fwc, abs(cn - 0.5));
    crack *= smoothstep(0.55, 0.68, noise3(p * 0.18 + 3.0)) * smoothstep(0.25, 0.0, N.y);
    ink = max(ink, crack * 0.9);
    // moss: stipple and grass on the upward-facing surfaces
    float moss = smoothstep(0.38, 0.7, N.y) * smoothstep(0.45, 0.62, fbm3(p * 0.55));
    ink = max(ink, stipple(p.xz, 0.11, pxPerUnit, 0.3 * moss));
    grass = moss * 0.2;
    // hair: short strokes flowing down the back of the head
    vec3 hv = p - HEAD_C;
    float inHair = smoothstep(-0.05, 0.12, p.y - (HEAD_C.y - 0.5 - 0.35 * hv.z)) * step(length(hv), 1.9);
    if (inHair > 0.0) {
      vec3 hn = normalize(hv);
      vec2 huv = vec2(atan(hn.x, hn.z) * 9.0, acos(clamp(hn.y, -1.0, 1.0)) * 11.0);
      vec2 hc = floor(huv);
      float hs = 0.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 cc = hc + vec2(float(i), float(j));
        vec2 o = cc + vec2(hash12(cc), hash12(cc + 4.3)) ;
        vec2 dd = huv - o;
        float along = clamp(dd.y, 0.0, 0.9);
        float bend = 0.18 * along * along;
        float dist = length(vec2(dd.x - bend, dd.y - along));
        float fwh = max(length(fwidth(huv)), 1e-3);
        float w = (0.55 + 0.5 * (1.0 - along / 0.9)) * fwh * uScale;
        if (hash12(cc + 9.7) < 0.35 + 0.6 * g) hs = max(hs, 1.0 - smoothstep(w, w + fwh, dist));
      }
      ink = mix(ink, max(ink * 0.6, hs), inHair);
      grass = max(grass, inHair * smoothstep(0.2, 0.6, N.y) * 0.45);
    }
  } else if (id == ID_BOY) {
    float halo = pow(clamp(1.0 + dot(rd, N), 0.0, 1.0), 3.0);
    float g = 1.0 - clamp(tone * 0.55 + 1.3 * halo * clamp(N.x * 0.6 + N.y * 0.5 + 0.6, 0.0, 1.0), 0.0, 1.0);
    ink = smoothstep(0.35, 0.6, g);
    ink = max(ink, screenHatch(fc, 0.9, 3.0 * uScale, smoothstep(0.1, 0.4, g) * 0.6));
  } else if (id == ID_DARK) {
    float halo = pow(clamp(1.0 + dot(rd, N), 0.0, 1.0), 3.0);
    ink = 1.0 - smoothstep(0.35, 0.7, halo * clamp(N.x * 0.6 + N.y * 0.5 + 0.6, 0.0, 1.0)) * 0.85;
  } else if (id == ID_SCARF) {
    float g = 1.0 - clamp(tone, 0.0, 1.0);
    ink = screenHatch(fc, 1.3, 3.2 * uScale, smoothstep(0.35, 0.9, g) * 0.45);
  } else if (id == ID_TREE) {
    float g = 1.0 - clamp(tone * 0.9, 0.0, 1.0);
    float c1 = worldHatch(p, normalize(vec3(0.5, 1.0, 0.2)), dpdx, dpdy, smoothstep(0.15, 0.9, g) * 0.6 * press, 5.0 * uScale, 2.0);
    float c2 = screenHatch(fc, -0.9, 4.2 * uScale, smoothstep(0.5, 1.0, g) * 0.55);
    ink = 1.0 - (1.0 - c1) * (1.0 - c2);
    // leafy scallop marks
    vec2 lc = floor(fc / (7.0 * uScale));
    vec2 lp = (fc / (7.0 * uScale)) - lc - vec2(0.5);
    float leaf = abs(length(lp * vec2(1.0, 1.6)) - 0.34);
    ink = max(ink, (1.0 - smoothstep(0.04, 0.1, leaf)) * step(lp.y, 0.0) * smoothstep(0.3, 0.6, g) * step(0.35, hash12(lc)));
  } else if (id == ID_TRUNK) {
    ink = max(screenHatch(fc, 1.45, 3.0 * uScale, 0.6), smoothstep(0.4, 0.2, tone));
  } else if (id == ID_CLOUD) {
    float aerial = clamp(t / 900.0, 0.0, 1.0);
    float ct = 0.62 + 0.38 * N.y + 0.5 * rim + 0.4 * dif;
    ct = mix(ct, 1.0, 0.2 * aerial);
    float g = 1.0 - clamp(ct, 0.0, 1.0);
    float c1 = worldHatch(p, vec3(0.0, 1.0, 0.0), dpdx, dpdy, smoothstep(0.3, 0.75, g) * 0.4 * press, 7.0 * uScale, 1.2);
    float c2 = worldHatch(p, normalize(vec3(1.0, 0.6, 0.0)), dpdx, dpdy, smoothstep(0.62, 0.9, g) * 0.32, 7.5 * uScale, 1.2);
    ink = 1.0 - (1.0 - c1) * (1.0 - c2);
  } else {
    // terrain
    float mist = smoothstep(MIST_Y - 0.5, MIST_Y + 7.0, p.y);
    if (p.y < MIST_Y + 0.3) { encodeOut(0.0, ID_MIST, t, vec3(0.0), 0.0, 0.0); return; }
    float g = (1.0 - clamp(tone, 0.0, 1.0)) * mist;
    float c1 = worldHatch(p, normalize(vec3(0.05, 1.0, 0.0)), dpdx, dpdy, smoothstep(0.3, 0.9, g) * 0.5 * press, 8.0 * uScale, 2.5);
    float c2 = screenHatch(fc, 1.1, 6.5 * uScale, smoothstep(0.62, 1.0, g) * 0.4);
    ink = 1.0 - (1.0 - c1) * (1.0 - c2);
    grass = mist * smoothstep(70.0, 25.0, t) * (0.22 + 0.4 * smoothstep(0.4, 0.8, g));
  }
  float fade = 0.0;
  if (id == ID_GIANT) {
    float m = smoothstep(MIST_Y + 0.3, MIST_Y + 4.8, p.y + 0.9 * (noise1(p.x * 0.9) - 0.5));
    ink *= m;
    fade = 1.0 - m;
  }
  encodeOut(ink, id, t, N, grass, fade);
}
`;

  var PASS2 = '#version 300 es\n' + COMMON + `
uniform sampler2D tA, tB;
uniform vec2 uRes;
uniform float uScale, uFpx;
out vec4 frag;

float decodeDepth(vec4 a) { float v = (floor(a.z * 255.0 + 0.5) * 256.0 + floor(a.w * 255.0 + 0.5)) / 65535.0; return exp2(v * 12.0); }
float idOf(vec4 a) { return floor(a.y * 255.0 + 0.5); }
ivec2 clampC(vec2 c) { return clamp(ivec2(c), ivec2(0), ivec2(uRes) - 1); }

float edgeStrength(float i1, float d1, vec3 n1, float i2, float d2, vec3 n2, int ring) {
  if (i1 == ID_MIST || i2 == ID_MIST) return 0.0;
  float nearD = min(d1, d2);
  float nearI = d1 < d2 ? i1 : i2;
  if (i1 != i2) {
    bool r1 = i1 >= ID_RIDGE, r2 = i2 >= ID_RIDGE;
    if ((r1 || i1 == ID_SKY) && (r2 || i2 == ID_SKY)) {
      float k = nearI - ID_RIDGE;
      if (ring == 1 && k > 0.5) return 0.0;
      return mix(0.95, 0.5, k / 3.0);
    }
    if (nearI == ID_CLOUD || (i1 == ID_CLOUD && i2 == ID_SKY) || (i2 == ID_CLOUD && i1 == ID_SKY)) return ring == 1 ? 0.0 : 0.8;
    if ((i1 == ID_BOY || i1 == ID_DARK) && (i2 == ID_BOY || i2 == ID_DARK)) return ring == 1 ? 0.0 : 0.6;
    return 1.0;
  }
  if (i1 == ID_SKY || i1 >= ID_RIDGE) return 0.0;
  float rel = abs(d1 - d2) / nearD;
  if (rel > 0.06) return ring == 1 ? (i1 == ID_TERRAIN ? 0.0 : 0.85) : 1.0;
  if (ring == 0) return smoothstep(0.32, 0.65, 1.0 - dot(n1, n2)) * 0.75;
  return 0.0;
}

float blades(vec2 fc, float myDepth) {
  float cw = 4.0 * uScale, ch = 4.5 * uScale, maxH = 44.0 * uScale;
  float any = 0.0;
  for (int i = 0; i < 5; i++) {
    float a1 = texelFetch(tB, clampC(fc - vec2(-6.0 * uScale, float(i) * maxH / 4.0)), 0).a;
    float a2 = texelFetch(tB, clampC(fc - vec2(6.0 * uScale, float(i) * maxH / 4.0)), 0).a;
    any = max(any, max(a1 < 0.495 ? a1 : 0.0, a2 < 0.495 ? a2 : 0.0));
  }
  if (any < 0.01) return 0.0;
  float ink = 0.0;
  float cx0 = floor(fc.x / cw) - 1.0;
  float cy1 = floor(fc.y / ch);
  for (int j = 0; j < 11; j++) {
    for (int i = 0; i < 6; i++) {
      vec2 cell = vec2(cx0 + float(i), cy1 - float(j));
      vec2 root = (cell + vec2(hash12(cell + 1.7), hash12(cell + 5.3))) * vec2(cw, ch);
      ivec2 rc = clampC(root);
      vec4 rb = texelFetch(tB, rc, 0);
      if (rb.a > 0.495 || hash12(cell + 0.37) > rb.a * 2.04) continue;
      vec4 ra = texelFetch(tA, rc, 0);
      float rid = idOf(ra);
      float rdep = decodeDepth(ra);
      if (myDepth < rdep * 0.97) continue;
      float wh = rid == ID_GIANT ? 0.085 : 0.42;
      float H = min(maxH, wh * uFpx / rdep) * (0.5 + 0.7 * hash12(cell + 9.1));
      if (H < 2.0 * uScale) continue;
      float sy = (fc.y - root.y) / H;
      if (sy < 0.0 || sy > 1.0) continue;
      float lean = (-0.36 + 0.3 * (hash12(cell + 2.9) - 0.5)) * H;
      float xc = root.x + lean * sy * sy;
      float slope = 2.0 * lean * sy / H;
      float dist = abs(fc.x - xc) / sqrt(1.0 + slope * slope);
      float w = (1.1 * (1.0 - sy) + 0.2) * uScale * (rid == ID_GIANT ? 0.8 : 1.0);
      ink = max(ink, 1.0 - smoothstep(w - 0.55 * uScale, w + 0.55 * uScale, dist));
    }
  }
  return ink;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec4 a = texelFetch(tA, clampC(fc), 0), b = texelFetch(tB, clampC(fc), 0);
  float id = idOf(a), dep = decodeDepth(a);
  vec3 n = b.xyz * 2.0 - 1.0;
  float fill = a.x;

  float e = 0.0;
  vec2 wob = (vec2(noise2(fc * 0.012 / uScale), noise2(fc * 0.012 / uScale + 17.0)) - 0.5) * 2.2 * uScale;
  for (int ring = 0; ring < 2; ring++) {
    float r = (ring == 0 ? 1.4 : 2.8) * uScale;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.785398 + float(ring) * 0.3927;
      vec2 o = vec2(cos(ang), sin(ang)) * r + wob * 0.5;
      ivec2 sc = clampC(fc + o);
      vec4 a2 = texelFetch(tA, sc, 0), b2 = texelFetch(tB, sc, 0);
      e = max(e, edgeStrength(id, dep, n, idOf(a2), decodeDepth(a2), b2.xyz * 2.0 - 1.0, ring));
    }
  }
  float fadeC = b.a > 0.495 ? (b.a - 0.5) * 2.0 : 0.0;
  e *= 1.0 - smoothstep(0.1, 0.9, fadeC);
  float bl = blades(fc, dep);
  float ink = max(max(fill, e), bl);

  // let the drawing dissolve unevenly into the paper at the edges
  vec2 uv = fc / uRes;
  float border = min(min(uv.x, 1.0 - uv.x) * uRes.x, min(uv.y, 1.0 - uv.y) * uRes.y) / uRes.y;
  float fade = smoothstep(0.0, 0.035, border + (noise2(fc * 0.006 / uScale) - 0.5) * 0.035);
  ink *= fade;
  vec3 paper = vec3(1.0);
  vec3 inkC = vec3(0.08, 0.08, 0.09);
  frag = vec4(mix(paper, inkC, clamp(ink, 0.0, 1.0)), 1.0);
}
`;

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }
  function link(gl, vsSrc, fsSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    return { prog: p, vs: vs, fs: fs };
  }
  function check(gl, l) {
    if (!gl.getProgramParameter(l.prog, gl.LINK_STATUS)) {
      var msg = gl.getShaderInfoLog(l.fs) || gl.getProgramInfoLog(l.prog) || 'link failed';
      throw new Error(msg);
    }
  }
  function frame() { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); }

  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

  var DEFAULTS = {
    cam: [4.2, 9.9, 36.0],
    target: [0.9, 11.5, -10.0],
    fovY: 28,
    sunAz: 3.85,
    sunEl: 0.55,
    boy: [3.0, 9.2, -0.35],
    boyYaw: 0.0,
    tree: [-0.55, 12.15, -0.5]
  };

  function renderGiant(canvas, options) {
    var o = {};
    var k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (options || {})) o[k] = options[k];

    var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) return Promise.reject(new Error('WebGL2 unavailable'));
    var W = canvas.width, H = canvas.height;
    var ext = gl.getExtension('KHR_parallel_shader_compile');

    var p1 = link(gl, VERT, PASS1);
    var p2 = link(gl, VERT, PASS2);

    function ready() {
      if (!ext) return Promise.resolve();
      return new Promise(function (resolve) {
        (function poll() {
          if (gl.getProgramParameter(p1.prog, ext.COMPLETION_STATUS_KHR) && gl.getProgramParameter(p2.prog, ext.COMPLETION_STATUS_KHR)) resolve();
          else setTimeout(poll, 30);
        })();
      });
    }

    return ready().then(function () {
      check(gl, p1);
      check(gl, p2);

      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      function tex() {
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      }
      var tA = tex(), tB = tex();
      var fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tA, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, tB, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');

      var F = norm(sub(o.target, o.cam));
      var R = norm(cross(F, [0, 1, 0]));
      var U = cross(R, F);
      var focal = 1 / Math.tan(o.fovY * Math.PI / 360);
      var az = o.sunAz * Math.PI / 180, el = o.sunEl * Math.PI / 180;
      var sun = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
      var scale = H / 1300;

      gl.useProgram(p1.prog);
      function u(name) { return gl.getUniformLocation(p1.prog, name); }
      gl.uniform2f(u('uRes'), W, H);
      gl.uniform3fv(u('uCamPos'), o.cam);
      gl.uniform3fv(u('uCamR'), R);
      gl.uniform3fv(u('uCamU'), U);
      gl.uniform3fv(u('uCamF'), F);
      gl.uniform1f(u('uFocal'), focal);
      gl.uniform1f(u('uScale'), scale);
      gl.uniform3fv(u('uSun'), sun);
      gl.uniform3fv(u('uBoyPos'), o.boy);
      gl.uniform1f(u('uBoyYaw'), o.boyYaw);
      gl.uniform3fv(u('uTreePos'), o.tree);
      gl.viewport(0, 0, W, H);

      // render the expensive pass in strips so no single draw call runs long
      var strips = Math.max(4, Math.ceil(H / 160));
      var i = 0;
      gl.enable(gl.SCISSOR_TEST);
      function strip() {
        if (i >= strips) return Promise.resolve();
        var y0 = Math.floor(i * H / strips), y1 = Math.floor((i + 1) * H / strips);
        gl.useProgram(p1.prog);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.scissor(0, y0, W, y1 - y0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        i++;
        return frame().then(strip);
      }
      return strip().then(function () {
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(p2.prog);
        var v = function (name) { return gl.getUniformLocation(p2.prog, name); };
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tA);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tB);
        gl.uniform1i(v('tA'), 0);
        gl.uniform1i(v('tB'), 1);
        gl.uniform2f(v('uRes'), W, H);
        gl.uniform1f(v('uScale'), scale);
        gl.uniform1f(v('uFpx'), focal * H * 0.5);
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.deleteTexture(tA); gl.deleteTexture(tB); gl.deleteFramebuffer(fb); gl.deleteBuffer(buf);
        return frame();
      });
    });
  }

  window.renderGiant = renderGiant;
})();
