/*
 * "On the shoulders of giants": a small 3D scene (a boy in a new Victorian coat standing on the shoulder
 * of an old, rusted steam automaton; both face the viewer and look up toward the top-left corner)
 * rendered with WebGL2 as a loose pen-and-ink sketch.
 *
 * Pass 1 ray-marches signed distance fields. For every pixel it writes the ink "fill" (pen hatching,
 * stipple, rivets and other surface marks, sky strokes, the sun), an object id, depth and normal.
 * Pass 2 draws sketchy outlines from depth/normal/id discontinuities, adds grass blades, and
 * composites ink on paper.
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
            ID_TREE = 5.0, ID_TRUNK = 6.0, ID_CLOUD = 7.0, ID_MIST = 8.0, ID_SCARF = 9.0, ID_SKIN = 10.0,
            ID_BRASS = 11.0, ID_RIDGE = 20.0;

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
uniform vec3 uLight;
uniform vec2 uSunUV;
uniform vec3 uBoyPos;
uniform float uBoyYaw;
uniform vec3 uTreePos;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

const float MIST_Y = -9.0;
const float BOY_S = 1.6;
const float TREE_S = 0.7;
const vec3 NECK_PIVOT = vec3(0.0, 9.85, 0.15);
const float HEAD_YAW = -0.76, HEAD_PITCH = -0.42;
const float BOY_HEAD_YAW = -0.75, BOY_HEAD_PITCH = -0.5;

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
float sdTorusZ(vec3 p, float R, float r) { vec2 q = vec2(length(p.xy) - R, p.z); return length(q) - r; }
float sdCylZ(vec3 p, float r, float h) { vec2 d = abs(vec2(length(p.xy), p.z)) - vec2(r, h); return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)); }
float sdCylX(vec3 p, float r, float h) { return sdCylZ(p.zyx, r, h); }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c); }
vec3 rotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
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

// ---------------- the land ----------------
float terrainH(vec2 q) {
  float x = q.x, z = q.y;
  float h = 5.3 * exp(-pow((z - 11.0) / 8.0, 2.0)) * (1.0 - 0.3 * smoothstep(6.0, 30.0, abs(x - 2.0)));
  h -= 16.0 * (1.0 - smoothstep(-45.0, -3.0, z));
  h += 0.9 * (fbm2(q * 0.05) - 0.5) + 0.25 * (noise2(q * 0.4) - 0.5);
  return h;
}

// ---------------- the old automaton ----------------
vec3 toHead(vec3 p) { return rotX(rotY(p - NECK_PIVOT, -HEAD_YAW), -HEAD_PITCH); }

float sdRobotHead(vec3 h) {
  vec3 c = h - vec3(0.0, 1.0, 0.1);
  float d = sdEllipsoid(c - vec3(0.0, 0.12, -0.05), vec3(1.18, 1.1, 1.12));
  d = smin(d, sdRoundBox(c - vec3(0.0, -0.38, 0.05), vec3(0.98, 0.55, 0.95), 0.42), 0.3);
  d = smax(d, c.z - 1.06, 0.18);
  d = smin(d, sdRoundBox(c - vec3(0.0, 0.44, 0.98), vec3(1.0, 0.1, 0.13), 0.06), 0.04);
  vec3 e = vec3(abs(c.x) - 0.43, c.y - 0.1, c.z - 1.06);
  d = min(d, sdTorusZ(e, 0.25, 0.07));
  d = min(d, sdRoundBox(c - vec3(0.0, -0.12, 1.08), vec3(0.09, 0.22, 0.07), 0.05));
  d = min(d, sdRoundBox(c - vec3(0.0, -0.56, 1.02), vec3(0.46, 0.17, 0.08), 0.07));
  vec3 ea = vec3(abs(c.x) - 1.16, c.y + 0.02, c.z - 0.05);
  d = min(d, sdCylX(ea, 0.38, 0.09));
  d = min(d, sdCylX(ea - vec3(0.09, 0.0, 0.0), 0.16, 0.07));
  return d;
}

float sdRobotBody(vec3 p) {
  vec3 m = vec3(abs(p.x), p.y, p.z);
  float d = sdRoundBox(p - vec3(0.0, 6.4, 0.0), vec3(2.7, 2.5, 1.8), 1.3);
  float shell = sdRoundBox(p - vec3(0.0, 6.4, 0.0), vec3(2.78, 2.58, 1.88), 1.38);
  d = min(d, max(shell, abs(p.y - 7.45) - 0.13));
  d = min(d, max(shell, abs(p.y - 4.95) - 0.13));
  vec3 fd = p - vec3(0.0, 6.05, 1.8);
  d = min(d, sdTorusZ(fd, 0.8, 0.1));
  d = min(d, sdCylZ(fd, 0.74, 0.05));
  d = smin(d, sdTorus(p - vec3(0.0, 8.95, 0.0), vec2(1.05, 0.3)), 0.15);
  d = min(d, sdCapsule(p, vec3(0.0, 8.9, 0.05), NECK_PIVOT + vec3(0.0, 0.2, 0.0), 0.6));
  d = min(d, sdTorus(p - vec3(0.0, 9.45, 0.1), vec2(0.62, 0.07)));
  vec3 sp = vec3(3.55, 8.3, 0.0);
  d = smin(d, sdEllipsoid(m - sp, vec3(1.5, 1.2, 1.45)), 0.2);
  d = min(d, sdEllipsoid(m - (sp + vec3(0.15, -0.5, 0.0)), vec3(1.66, 0.72, 1.6)));
  d = min(d, sdEllipsoid(m - (sp + vec3(0.25, -0.95, 0.0)), vec3(1.72, 0.5, 1.64)));
  vec3 el = vec3(4.5, 4.7, 0.6);
  d = smin(d, sdRoundCone(m, sp + vec3(0.3, -0.9, 0.05), el, 0.95, 0.82), 0.2);
  d = min(d, length(m - el) - 0.95);
  d = min(d, sdRoundCone(m, el, vec3(4.35, 1.4, 2.2), 0.82, 0.7));
  vec3 sa = vec3(1.6, 8.4, -1.3), sb = vec3(2.0, 12.4, -1.75);
  d = min(d, sdCapsule(m, sa, sb, 0.34));
  d = min(d, sdTorus(m - sb, vec2(0.4, 0.13)));
  d = min(d, sdTorus(m - mix(sa, sb, 0.62), vec2(0.37, 0.07)));
  return d;
}

float sdGiant(vec3 p) {
  float bd = length(p - vec3(0.0, 8.0, 0.0)) - 8.3;
  if (bd > 1.0) return bd;
  float d = sdRobotBody(p);
  vec3 h = toHead(p);
  float hb = length(h - vec3(0.0, 1.0, 0.1)) - 1.9;
  d = smin(d, hb > 0.5 ? hb : sdRobotHead(h), 0.12);
  d += 0.035 * (noise3(p * 1.3) - 0.5) * (1.0 - smoothstep(0.2, 1.0, d));
  return d;
}

float giantSurfaceY(vec2 xz) {
  float y = 14.0;
  for (int i = 0; i < 56; i++) {
    float d = sdGiant(vec3(xz.x, y, xz.y));
    if (d < 0.002) break;
    y -= max(d * 0.9, 0.004);
  }
  return y;
}

// ---------------- the boy (unit height, scaled) ----------------
vec3 gBoy, gTree;
vec3 toBoyHead(vec3 p) { return rotX(rotY(p - vec3(0.0, 0.82, 0.0), -BOY_HEAD_YAW), -BOY_HEAD_PITCH); }
// materials: 0 coat, 1 dark (hair, boots), 2 scarf, 3 skin, 4 brass
vec2 sdBoy(vec3 pw) {
  vec3 p = pw - gBoy;
  float bd = length(p - vec3(0.0, 0.8, 0.0)) - 1.4;
  if (bd > 0.4) return vec2(bd, 0.0);
  p.xz = rot(uBoyYaw) * p.xz;
  p /= BOY_S;
  float coat = sdRoundCone(p, vec3(-0.058, 0.5, 0.0), vec3(-0.07, 0.24, 0.0), 0.05, 0.041);
  coat = min(coat, sdRoundCone(p, vec3(0.058, 0.5, 0.0), vec3(0.074, 0.24, 0.0), 0.05, 0.041));
  float dark = min(sdRoundCone(p, vec3(-0.07, 0.26, 0.0), vec3(-0.075, 0.035, 0.0), 0.046, 0.041),
                   sdRoundCone(p, vec3(0.074, 0.26, 0.0), vec3(0.08, 0.035, 0.0), 0.046, 0.041));
  dark = min(dark, sdEllipsoid(p - vec3(-0.078, 0.03, 0.035), vec3(0.046, 0.032, 0.08)));
  dark = min(dark, sdEllipsoid(p - vec3(0.084, 0.03, 0.035), vec3(0.046, 0.032, 0.08)));
  // frock coat: body plus a flared skirt open at the front, pushed by the wind
  coat = min(coat, sdRoundCone(p, vec3(0.0, 0.5, 0.0), vec3(0.0, 0.72, 0.0), 0.096, 0.112));
  coat = smin(coat, sdEllipsoid(p - vec3(0.0, 0.73, 0.0), vec3(0.14, 0.05, 0.075)), 0.03);
  vec3 k = p; k.x -= 0.16 * clamp(0.53 - p.y, 0.0, 0.3); k.z += 0.05 * clamp(0.53 - p.y, 0.0, 0.3);
  float skirt = sdRoundCone(k, vec3(0.0, 0.53, 0.0), vec3(0.015, 0.29, -0.01), 0.1, 0.15);
  skirt = max(skirt, -max(0.04 - k.z, abs(k.x) - 0.035 - (0.53 - p.y) * 0.3));
  skirt = max(skirt, max(p.y - 0.535, 0.285 - p.y));
  coat = min(coat, skirt);
  coat = smin(coat, sdTorus(p - vec3(0.0, 0.765, 0.0), vec2(0.066, 0.026)), 0.01);
  // arms: one pointing up-left, the other with a hand on the hip
  vec3 shR = vec3(-0.118, 0.712, 0.0), elR = vec3(-0.232, 0.81, 0.06), haR = vec3(-0.335, 0.925, 0.12);
  coat = smin(coat, sdCapsule(p, shR, elR, 0.035), 0.02);
  coat = min(coat, sdRoundCone(p, elR, haR, 0.031, 0.036));
  float skin = length(p - (haR + vec3(-0.018, 0.02, 0.008))) - 0.025;
  skin = min(skin, sdCapsule(p, haR + vec3(-0.018, 0.02, 0.008), haR + vec3(-0.068, 0.075, 0.03), 0.0095));
  vec3 shL = vec3(0.118, 0.712, 0.0), elL = vec3(0.236, 0.6, -0.03), haL = vec3(0.112, 0.505, 0.0);
  coat = smin(coat, sdCapsule(p, shL, elL, 0.035), 0.02);
  coat = smin(coat, sdCapsule(p, elL, haL, 0.031), 0.012);
  skin = min(skin, length(p - haL - vec3(0.004, -0.006, 0.0)) - 0.024);
  // satchel on the hip and its strap across the chest
  coat = min(coat, sdRoundBox(p - vec3(-0.13, 0.45, 0.025), vec3(0.03, 0.055, 0.07), 0.014));
  coat = min(coat, sdCapsule(p, vec3(0.085, 0.735, 0.075), vec3(-0.115, 0.5, 0.08), 0.011));
  // head, turned to look up and to the left
  vec3 hp = toBoyHead(p);
  skin = min(skin, sdCapsule(p, vec3(0.0, 0.74, 0.0), vec3(0.0, 0.83, 0.0), 0.036));
  skin = min(skin, length(hp - vec3(0.0, 0.065, 0.0)) - 0.082);
  skin = min(skin, length(hp - vec3(0.0, 0.055, 0.083)) - 0.012);
  float hair = sdEllipsoid(hp - vec3(0.0, 0.09, -0.016), vec3(0.092, 0.078, 0.09)) + 0.012 * (noise3(hp * 55.0) - 0.5);
  hair = max(hair, (0.075 + 0.35 * hp.z) - hp.y);
  hair = min(hair, sdCapsule(hp, vec3(0.03, 0.13, -0.02), vec3(0.115, 0.14, -0.065), 0.02));
  hair = min(hair, sdCapsule(hp, vec3(0.05, 0.1, -0.05), vec3(0.13, 0.085, -0.09), 0.017));
  hair = min(hair, sdCapsule(hp, vec3(-0.02, 0.15, 0.0), vec3(0.04, 0.17, -0.06), 0.016));
  dark = min(dark, hair);
  // brass goggles pushed up on the hair
  vec3 gq = hp - vec3(0.0, 0.135, 0.06);
  gq = rotX(gq, 0.7);
  float brass = min(sdTorusZ(gq - vec3(0.034, 0.0, 0.0), 0.022, 0.008), sdTorusZ(gq + vec3(0.034, 0.0, 0.0), 0.022, 0.008));
  brass = min(brass, sdTorus(hp - vec3(0.0, 0.12, 0.0), vec2(0.088, 0.006)));
  // scarf streaming to the right in the wind
  float scarf = sdTorus(p - vec3(0.0, 0.77, 0.0), vec2(0.058, 0.025));
  vec3 s0 = vec3(0.03, 0.76, -0.05), s1 = vec3(0.1, 0.71, -0.11), s2 = vec3(0.18, 0.75, -0.16),
       s3 = vec3(0.27, 0.695, -0.19), s4 = vec3(0.36, 0.735, -0.21), s5 = vec3(0.45, 0.68, -0.22);
  scarf = min(scarf, sdRibbon(p, s0, s1, 0.035, 0.007, 0.0, -0.5));
  scarf = min(scarf, sdRibbon(p, s1, s2, 0.033, 0.007, -0.5, -1.1));
  scarf = min(scarf, sdRibbon(p, s2, s3, 0.03, 0.006, -1.1, -0.3));
  scarf = min(scarf, sdRibbon(p, s3, s4, 0.026, 0.006, -0.3, 0.5));
  scarf = min(scarf, sdRibbon(p, s4, s5, 0.022, 0.005, 0.5, -0.2));
  float r = coat, m = 0.0;
  if (dark < r) { r = dark; m = 1.0; }
  if (scarf < r) { r = scarf; m = 2.0; }
  if (skin < r) { r = skin; m = 3.0; }
  if (brass < r) { r = brass; m = 4.0; }
  return vec2(r * BOY_S, m);
}

// ---------------- sapling growing out of the old machine ----------------
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
  vec3 q = p - vec3(72.0, 124.0, -450.0);
  float d = length(q) - 75.0;
  if (d < 8.0) {
    float c = sdEllipsoid(q - vec3(0.0, -10.0, 0.0), vec3(56.0, 12.0, 26.0));
    c = smin(c, length(q - vec3(-22.0, 2.0, 4.0)) - 20.0, 5.0);
    c = smin(c, length(q - vec3(4.0, 12.0, 0.0)) - 24.0, 5.0);
    c = smin(c, length(q - vec3(28.0, 2.0, 6.0)) - 17.0, 5.0);
    c = smin(c, length(q - vec3(-42.0, -6.0, 6.0)) - 11.0, 4.0);
    c = smin(c, length(q - vec3(10.0, 33.0, -4.0)) - 15.0, 5.0);
    c = smax(c, -(q.y + 18.0), 3.0);
    c += 4.0 * (fbm3(q * 0.05) - 0.5);
    d = c;
  }
  vec3 s = p - vec3(-120.0, 58.0, -560.0);
  float ds = length(s / vec3(3.0, 1.0, 1.5)) - 40.0;
  if (ds < 10.0) {
    float st = sdEllipsoid(s, vec3(95.0, 9.0, 40.0));
    st = smin(st, length(s - vec3(-30.0, 6.0, 0.0)) - 15.0, 6.0);
    st = smin(st, length(s - vec3(-6.0, 9.0, 0.0)) - 18.0, 6.0);
    st = smin(st, length(s - vec3(22.0, 5.0, 0.0)) - 12.0, 6.0);
    st = smax(st, -(s.y + 6.0), 3.0);
    st += 3.0 * (fbm3(s * 0.06) - 0.5);
    ds = st;
  }
  return min(d, ds);
}

// ---------------- distant hills and mountains (analytic curtains) ----------------
const vec4 RIDGE[4] = vec4[4](vec4(95.0, -13.0, 10.0, 1.0 / 40.0), vec4(170.0, -11.0, 16.0, 1.0 / 60.0),
                              vec4(300.0, -8.0, 36.0, 1.0 / 70.0), vec4(520.0, -4.0, 62.0, 1.0 / 120.0));
float ridgeH(int k, float x) {
  vec4 r = RIDGE[k];
  float u = x * r.w + float(k) * 17.3 + 4.0;
  float s = 0.0, a = 0.55, f = 1.0;
  if (k < 2) {
    for (int i = 0; i < 3; i++) { s += a * noise1(u * f); a *= 0.5; f *= 2.1; }
    s /= 0.9;
  } else {
    for (int i = 0; i < 5; i++) { float n = noise1(u * f); n = 1.0 - abs(2.0 * n - 1.0); s += a * n * n; a *= 0.5; f *= 2.13; }
  }
  float h = r.y + r.z * s;
  if (k < 2) {
    // round trees and hedgerows along the hilltops
    float w = k == 0 ? 2.2 : 3.4;
    float cell = floor(x / w);
    for (int j = -1; j <= 1; j++) {
      float cc = cell + float(j);
      if (hash11(cc * 1.7 + float(k) * 9.0) < 0.55) continue;
      float cx = (cc + 0.5 + 0.3 * (hash11(cc + 3.1) - 0.5)) * w;
      float tr = (k == 0 ? 1.5 : 2.2) * (0.6 + 0.6 * hash11(cc * 2.3));
      float dx = (x - cx) / tr;
      if (abs(dx) < 1.0) h = max(h, r.y + r.z * s - 0.3 + tr * 1.3 * sqrt(1.0 - dx * dx));
    }
  }
  return h;
}

vec2 mapScene(vec3 p) {
  vec2 res = vec2((p.y - terrainH(p.xz)) * 0.55, ID_TERRAIN);
  float g = sdGiant(p);
  if (g < res.x) res = vec2(g, ID_GIANT);
  vec2 b = sdBoy(p);
  if (b.x < res.x) res = vec2(b.x, b.y > 3.5 ? ID_BRASS : b.y > 2.5 ? ID_SKIN : b.y > 1.5 ? ID_SCARF : b.y > 0.5 ? ID_DARK : ID_BOY);
  vec2 t = sdTree(p);
  if (t.x < res.x) res = vec2(t.x, t.y > 0.5 ? ID_TREE : ID_TRUNK);
  float c = sdClouds(p);
  if (c < res.x) res = vec2(c, ID_CLOUD);
  return res;
}
float mapShadow(vec3 p) {
  float d = min(sdGiant(p), sdBoy(p).x);
  d = min(d, sdTree(p).x);
  return min(d, (p.y - terrainH(p.xz)) * 0.55);
}
vec3 calcNormal(vec3 p, float t) {
  float e = 0.0009 * t + 0.0015;
  vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * mapScene(p + k.xyy * e).x + k.yyx * mapScene(p + k.yyx * e).x +
                   k.yxy * mapScene(p + k.yxy * e).x + k.xxx * mapScene(p + k.xxx * e).x);
}
float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.06;
  for (int i = 0; i < 44; i++) {
    float h = mapShadow(ro + rd * t);
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.04, 1.4);
    if (res < 0.003 || t > 30.0) break;
  }
  return clamp(res, 0.0, 1.0);
}
float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) { float h = 0.04 + 0.18 * float(i); float d = mapScene(p + n * h).x; occ += (h - d) * sca; sca *= 0.75; }
  return clamp(1.0 - 1.4 * occ, 0.0, 1.0);
}

// ---------------- pen marks ----------------
// short, slightly uneven pen strokes running perpendicular to direction ang
float penLines(vec2 fc, float ang, float S, float frac, float seed) {
  vec2 d = vec2(cos(ang), sin(ang));
  vec2 t = vec2(-d.y, d.x);
  float s = dot(fc, d) / S + 0.45 * (noise2(fc * 0.011 / uScale + seed) - 0.5);
  float li = floor(s + 0.5);
  float L = (22.0 + 16.0 * hash11(li * 1.31 + seed)) * uScale;
  float a = dot(fc, t) / L + hash11(li * 3.17 + seed) * 7.0;
  float si = floor(a), f = fract(a);
  float keep = step(hash12(vec2(li, si) + seed), 0.84);
  float taper = smoothstep(0.0, 0.16, f) * (1.0 - smoothstep(0.72, 1.0, f));
  float w = frac * (0.6 + 0.8 * hash12(vec2(si, li) + seed * 1.3)) * taper * keep;
  return lineAA(s, 1.0 / S, w);
}
// hatching whose direction is quantised to 30 degree steps, blended between neighbours
float penHatch(vec2 fc, float ang, float S, float frac, float seed) {
  if (frac < 0.02) return 0.0;
  float k = mod(ang, 3.14159265) / 0.5235988;
  float k0 = floor(k), w = smoothstep(0.3, 0.7, k - k0);
  float c0 = penLines(fc, k0 * 0.5235988, S, frac, seed + k0 * 1.7);
  float c1 = penLines(fc, (k0 + 1.0) * 0.5235988, S, frac, seed + mod(k0 + 1.0, 6.0) * 1.7);
  return mix(c0, c1, w);
}
// world-space footprint of one pixel at the shaded point (set in main)
vec3 gDx, gDy;
// change per pixel of a function whose world-space gradient is g
float fwG(vec3 g) { return abs(dot(g, gDx)) + abs(dot(g, gDy)); }
// a pen line wpx pixels wide where dist == 0; fw is the change of dist per pixel
float inkLine(float dist, float fw, float wpx) {
  fw = max(fw, 1e-6);
  float hw = 0.5 * wpx * fw;
  return (1.0 - smoothstep(hw - 0.6 * fw, hw + 0.6 * fw, abs(dist))) * min(wpx, 1.0);
}
// a filled dot of radius r; fw is the size of a pixel in the units of q
float inkDot(vec2 q, float r, float fw) {
  fw = max(fw, 1e-6);
  return 1.0 - smoothstep(r - 0.7 * fw, r + 0.7 * fw, length(q));
}
vec3 headToWorld(vec3 v) { return rotY(rotX(v, HEAD_PITCH), HEAD_YAW); }
float stipple(vec2 q, float cell, float pxPerUnit, float density) {
  vec2 c = floor(q / cell);
  float ink = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cc = c + vec2(float(i), float(j));
    if (hash12(cc) > density) continue;
    vec2 pt = (cc + vec2(hash12(cc + 7.1), hash12(cc + 3.7))) * cell;
    float dpx = length(q - pt) * pxPerUnit;
    float r = (0.7 + 0.8 * hash12(cc + 1.3)) * uScale;
    ink = max(ink, 1.0 - smoothstep(r - 0.6 * uScale, r + 0.6 * uScale, dpx));
  }
  return ink;
}

float skyInk(vec3 rd, vec2 uv, vec2 fc) {
  float ink = 0.0;
  float px = uRes.y * 0.5;
  // the morning sun, peeking in at the top-left corner
  vec2 sv = (uv - uSunUV) * px;
  float dpx = length(sv);
  float Rs = 0.11 * px;
  float ang = atan(sv.y, sv.x);
  float ring = 1.0 - smoothstep(0.8 * uScale, 1.9 * uScale, abs(dpx - Rs - 1.5 * uScale * (noise1(ang * 6.0) - 0.5)));
  ring *= step(0.18, noise1(ang * 5.0 + 2.0));
  float ring2 = 1.0 - smoothstep(0.5 * uScale, 1.3 * uScale, abs(dpx - Rs * 1.05 - 2.0 * uScale * (noise1(ang * 4.0 + 9.0) - 0.5)));
  ring2 *= step(0.45, noise1(ang * 3.0 + 5.0));
  ink = max(ink, max(ring, 0.8 * ring2));
  if (dpx > Rs * 1.3) {
    float NR = 34.0;
    float idx = floor(ang / 6.2831853 * NR + 0.5);
    float thc = idx * 6.2831853 / NR + (hash11(idx + 3.0) - 0.5) * 0.05;
    float lenR = Rs * (1.8 + 3.0 * pow(hash11(idx * 1.37 + 0.5), 1.5)) * (mod(idx, 2.0) < 0.5 ? 1.0 : 0.8);
    float dperp = abs(ang - thc) * dpx;
    float wR = mix(1.0, 0.35, smoothstep(Rs * 1.3, lenR, dpx)) * uScale;
    float on = smoothstep(Rs * 1.3, Rs * 1.45, dpx) * (1.0 - smoothstep(lenR * 0.85, lenR, dpx));
    on *= step(0.3, hash11(idx * 5.1));
    ink = max(ink, on * (1.0 - smoothstep(wR - 0.5 * uScale, wR + 0.5 * uScale, dperp)));
  }
  // a few loose horizontal strokes, the way a pen sketch suggests a sky
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float y = mix(0.15, 0.62, hash11(fi * 3.7 + 1.0)) * uRes.y;
    y = uRes.y - y;
    float x0 = mix(0.05, 0.75, hash11(fi * 5.3 + 2.0)) * uRes.x;
    float len = mix(0.12, 0.3, hash11(fi * 7.1 + 3.0)) * uRes.x;
    float yy = y + 3.0 * uScale * sin((fc.x - x0) / (60.0 * uScale) + fi);
    float inx = smoothstep(x0, x0 + 12.0 * uScale, fc.x) * (1.0 - smoothstep(x0 + len - 20.0 * uScale, x0 + len, fc.x));
    ink = max(ink, inx * (1.0 - smoothstep(0.35 * uScale, 1.1 * uScale, abs(fc.y - yy))) * 0.75);
  }
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
  gBoy = vec3(uBoyPos.x, giantSurfaceY(uBoyPos.xz) - 0.03, uBoyPos.z);
  gTree = vec3(uTreePos.x, giantSurfaceY(uTreePos.xz) - 0.1, uTreePos.z);
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = (2.0 * fc - uRes) / uRes.y;
  vec3 rdRaw = uv.x * uCamR + uv.y * uCamU + uFocal * uCamF;
  float rl = length(rdRaw);
  vec3 rd = rdRaw / rl;
  vec3 ro = uCamPos;
  float kpx = 2.0 / uRes.y;
  vec3 drdx = (uCamR - rd * dot(rd, uCamR)) / rl * kpx;
  vec3 drdy = (uCamU - rd * dot(rd, uCamU)) / rl * kpx;

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
  for (int i = 0; i < 240; i++) {
    vec3 p = ro + rd * t;
    vec2 h = mapScene(p);
    if (h.x < 0.0006 * t) { hit = vec2(t, h.y); break; }
    t += h.x * 0.85;
    if (t > tmax) break;
  }

  if (hit.y < 0.0) {
    if (tM < tR) { encodeOut(0.0, ID_MIST, tM, vec3(0.0), 0.0, 0.0); return; }
    if (kR >= 0) {
      vec3 q = ro + rd * tR;
      float k = float(kR);
      float h = ridgeH(kR, q.x);
      float hs = ridgeH(kR, q.x + 1.5) - ridgeH(kR, q.x - 1.5);
      float shade = hs < 0.0 ? 1.0 : 0.25;
      float haze = smoothstep(MIST_Y, MIST_Y + 12.0 + 4.0 * k, q.y);
      float ink = 0.0;
      if (kR < 2) {
        float g = (0.45 - 0.1 * k) * shade * haze * smoothstep(0.0, 3.0, h - q.y);
        ink = penHatch(fc, 2.4, 7.0 * uScale, g * 0.5, 3.0 + k);
      } else {
        float snowY = kR == 2 ? 14.0 : 24.0;
        float snow = smoothstep(snowY - 2.0, snowY + 2.0, q.y + 6.0 * (noise1(q.x * 0.08) - 0.5));
        float g = (0.55 - 0.12 * k) * shade * haze * (1.0 - snow);
        ink = penHatch(fc, 0.35, 6.0 * uScale, g * 0.55, 7.0 + k);
      }
      encodeOut(ink, ID_RIDGE + k, tR, vec3(0.0, 0.0, 1.0), 0.0, 0.0);
      return;
    }
    encodeOut(skyInk(rd, uv, fc), ID_SKY, 4000.0, vec3(0.0), 0.0, 0.0);
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
  gDx = dpdx; gDy = dpdy;
  float pxW = max(length(dpdx), length(dpdy));

  float dif = clamp(dot(N, uLight), 0.0, 1.0);
  float sh = dif > 0.001 ? softShadow(p + N * 0.02, uLight) : 0.0;
  float ao = calcAO(p, N);
  float spec = pow(clamp(dot(reflect(rd, N), uLight), 0.0, 1.0), 18.0);
  float tone = (0.2 + 0.15 * N.y) * mix(0.55, 1.0, ao) + 0.75 * dif * sh;
  vec2 nS = vec2(dot(N, uCamR), dot(N, uCamU));
  float formAng = length(nS) > 0.25 ? atan(nS.y, nS.x) : 2.35;
  float ink = 0.0, grass = 0.0;

  if (id == ID_GIANT) {
    float g = 1.0 - clamp(tone + 0.6 * spec * sh, 0.0, 1.0);
    float c1 = penHatch(fc, formAng, 6.0 * uScale, smoothstep(0.25, 0.85, g) * 0.6, 1.0);
    float c2 = penHatch(fc, 2.3, 6.5 * uScale, smoothstep(0.5, 0.95, g) * 0.55, 2.0);
    float c3 = penHatch(fc, 0.6, 5.5 * uScale, smoothstep(0.72, 1.0, g) * 0.5, 3.0);
    ink = 1.0 - (1.0 - c1) * (1.0 - c2) * (1.0 - c3);
    vec3 c = toHead(p) - vec3(0.0, 1.0, 0.1);
    if (length(c) < 1.75 && p.y > 9.3) {
      vec3 hX = headToWorld(vec3(1.0, 0.0, 0.0)), hY = headToWorld(vec3(0.0, 1.0, 0.0)), hZ = headToWorld(vec3(0.0, 0.0, 1.0));
      float sx = c.x < 0.0 ? -1.0 : 1.0;
      // porthole eyes: clear glass, an iris ring, a pupil and a catch-light
      vec2 e = vec2(abs(c.x) - 0.43, c.y - 0.1);
      float er = max(length(e), 1e-4);
      float fwE = fwG((e.x / er) * sx * hX + (e.y / er) * hY);
      if (c.z > 0.85 && er < 0.215) {
        float glass = 1.0 - smoothstep(0.2 - fwE, 0.2 + fwE, er);
        ink *= 1.0 - glass;
        ink = max(ink, inkLine(er - 0.12, fwE, 1.4 * uScale));
        ink = max(ink, inkDot(e - vec2(-0.02, 0.01), 0.065, pxW));
        ink = min(ink, 1.0 - inkDot(e - vec2(-0.045, 0.04), 0.02, pxW));
        ink = max(ink, glass * penHatch(fc, 0.8, 3.0 * uScale, smoothstep(0.13, 0.2, er) * 0.45, 9.0));
      }
      // mouth grille slots
      vec2 mg = vec2(c.x, c.y + 0.56);
      if (c.z > 0.9 && abs(mg.x) < 0.38 && abs(mg.y) < 0.12)
        ink = max(ink, inkLine(fract(mg.y / 0.06 + 0.5) - 0.5, fwG(hY / 0.06), 1.6 * uScale));
      // rivets along the brow band
      if (c.z > 0.8 && abs(c.y - 0.44) < 0.08)
        ink = max(ink, inkDot(vec2((fract(c.x / 0.18 + 0.5) - 0.5) * 0.18, c.y - 0.44), 0.025, pxW));
      // a riveted seam over the crown
      if (c.y > 0.55 && c.z < 0.98) {
        ink = max(ink, 0.9 * inkLine(c.x, fwG(hX), 1.3 * uScale));
        float arc = atan(c.z + 0.05, c.y - 0.12) * 1.15;
        ink = max(ink, inkDot(vec2(abs(c.x) - 0.08, (fract(arc / 0.17 + 0.5) - 0.5) * 0.17), 0.022, pxW));
      }
      // ear discs: concentric vents
      vec3 ea = vec3(abs(c.x) - 1.16, c.y + 0.02, c.z - 0.05);
      float rr = max(length(ea.yz), 1e-4);
      if (abs(ea.x) < 0.2 && rr < 0.36)
        ink = max(ink, 0.8 * inkLine(fract(rr / 0.08) - 0.5, fwG(((ea.y / rr) * hY + (ea.z / rr) * hZ) / 0.08), 1.3 * uScale));
    } else {
      // the furnace door: grate bars inside a riveted flange
      vec3 fd = p - vec3(0.0, 6.05, 1.8);
      float fr = max(length(fd.xy), 1e-4);
      if (fd.z > -0.2 && fr < 0.7) {
        float inGrate = step(abs(fd.y), sqrt(max(0.42 - fd.x * fd.x, 0.0)));
        ink = max(ink, inGrate * inkLine(fract(fd.x / 0.16 + 0.5) - 0.5, fwG(vec3(1.0 / 0.16, 0.0, 0.0)), 1.5 * uScale));
        ink = max(ink, inkLine(fr - 0.62, fwG(vec3(fd.x / fr, fd.y / fr, 0.0)), 1.3 * uScale));
      }
      if (fd.z > -0.3 && fr > 0.85 && fr < 1.02) {
        float ra = atan(fd.y, fd.x) * 0.95 / 0.25;
        ink = max(ink, inkDot(vec2((fract(ra) - 0.5) * 0.25, fr - 0.94), 0.035, pxW));
      }
      if (p.y > 4.6 && p.y < 9.0 && abs(p.x) < 3.2) {
        for (int i = 0; i < 2; i++) {
          float sy = i == 0 ? 7.45 : 4.95;
          float dy = p.y - sy;
          // rivets on the bands
          if (abs(dy) < 0.12) ink = max(ink, inkDot(vec2((fract((p.x + p.z * 0.5) / 0.3 + 0.5) - 0.5) * 0.3, dy), 0.04, pxW));
          // rust running down from the seams
          float col = floor(p.x / 0.13);
          float len = 0.25 + 1.1 * hash11(col * 5.3 + float(i));
          if (hash11(col * 2.7 + float(i) * 11.0) > 0.72 && dy < -0.13 && dy > -0.13 - len && N.z > 0.2)
            ink = max(ink, 0.9 * inkLine((fract(p.x / 0.13) - 0.5) * 0.13, fwG(vec3(1.0, 0.0, 0.0)), (1.6 - 1.2 * (-dy - 0.13) / len) * uScale));
        }
        // plate seams with rivets
        float ax = abs(p.x) - 1.45;
        if (abs(ax) < 0.15 && p.y > 5.1 && p.y < 7.3 && N.z > 0.3) {
          ink = max(ink, inkLine(ax, fwG(vec3(sign(p.x), 0.0, 0.0)), 1.4 * uScale));
          ink = max(ink, inkDot(vec2(abs(ax) - 0.08, (fract(p.y / 0.28) - 0.5) * 0.28), 0.03, pxW));
        }
      }
      // pauldron rings
      vec3 sp = vec3(abs(p.x) - 3.55, p.y - 8.3, p.z);
      if (length(sp) < 2.0 && p.y > 7.2)
        ink = max(ink, 0.55 * smoothstep(0.2, 0.6, g) * inkLine(fract((p.y - 8.3) / 0.38) - 0.5, fwG(vec3(0.0, 1.0 / 0.38, 0.0)), 1.1 * uScale));
    }
    // age: rust blotches, and moss with grass where rain and seeds settle
    float rust = smoothstep(0.62, 0.72, fbm3(p * 0.9 + 2.0));
    ink = max(ink, stipple(p.xy + p.zz * 0.7, 0.07, pxPerUnit, 0.5 * rust));
    float moss = smoothstep(0.5, 0.8, N.y) * smoothstep(0.42, 0.58, fbm3(p * 0.7));
    ink = max(ink, stipple(p.xz, 0.09, pxPerUnit, 0.35 * moss));
    grass = moss * 0.3;
  } else if (id == ID_BOY) {
    float g = 1.0 - clamp(tone * 1.05, 0.0, 1.0);
    float c1 = penHatch(fc, formAng, 3.4 * uScale, smoothstep(0.25, 0.8, g) * 0.6, 4.0);
    float c2 = penHatch(fc, 2.3, 3.6 * uScale, smoothstep(0.55, 0.95, g) * 0.55, 5.0);
    ink = 1.0 - (1.0 - c1) * (1.0 - c2);
    // buttons down the coat
    vec3 q = (p - gBoy) / BOY_S;
    q.xz = rot(uBoyYaw) * q.xz;
    if (q.z > 0.07 && abs(q.x) < 0.02 && q.y > 0.52 && q.y < 0.7)
      ink = max(ink, inkDot(vec2(q.x, (fract(q.y / 0.045) - 0.5) * 0.045), 0.0075, pxW / BOY_S));
  } else if (id == ID_DARK) {
    float rimL = smoothstep(0.55, 0.85, dif * sh);
    ink = 1.0 - rimL * 0.75;
    ink = min(ink, 1.0 - penHatch(fc, 2.2, 3.0 * uScale, rimL * 0.5, 6.0));
  } else if (id == ID_SKIN) {
    float g = 1.0 - clamp(tone * 1.15, 0.0, 1.0);
    ink = penHatch(fc, 2.3, 3.2 * uScale, smoothstep(0.45, 0.9, g) * 0.45, 7.0);
    // face: eyes looking up and to the left, brows, mouth
    vec3 q = (p - gBoy) / BOY_S;
    q.xz = rot(uBoyYaw) * q.xz;
    vec3 hp = toBoyHead(q) - vec3(0.0, 0.065, 0.0);
    float fwB = pxW / BOY_S;
    if (hp.z > 0.035 && length(hp) < 0.1) {
      vec2 ey = vec2(abs(hp.x) - 0.031, hp.y - 0.008);
      ink = max(ink, inkDot(ey * vec2(1.0, 0.75), 0.0105, fwB));
      vec2 br = vec2(abs(hp.x) - 0.033, hp.y - 0.034 - 0.08 * (abs(hp.x) - 0.033));
      if (abs(br.x) < 0.017) ink = max(ink, inkLine(br.y, fwB, 1.2 * uScale));
      vec2 mo = vec2(hp.x + 0.004, hp.y + 0.036);
      if (abs(mo.x) < 0.014) ink = max(ink, inkLine(mo.y - 6.0 * mo.x * mo.x, fwB, 1.1 * uScale));
    }
  } else if (id == ID_SCARF) {
    float g = 1.0 - clamp(tone * 1.2, 0.0, 1.0);
    ink = penHatch(fc, 1.3, 3.0 * uScale, smoothstep(0.35, 0.9, g) * 0.45, 8.0);
  } else if (id == ID_BRASS) {
    float g = 1.0 - clamp(tone + spec, 0.0, 1.0);
    ink = penHatch(fc, 0.8, 2.6 * uScale, smoothstep(0.3, 0.9, g) * 0.5, 9.0);
  } else if (id == ID_TREE) {
    float g = 1.0 - clamp(tone * 1.1, 0.0, 1.0);
    ink = penHatch(fc, formAng, 4.0 * uScale, smoothstep(0.2, 0.85, g) * 0.6, 10.0);
    ink = max(ink, penHatch(fc, 2.3, 4.2 * uScale, smoothstep(0.55, 1.0, g) * 0.5, 11.0));
  } else if (id == ID_TRUNK) {
    ink = max(penHatch(fc, 0.1, 3.0 * uScale, 0.45, 12.0), 1.0 - smoothstep(0.15, 0.4, tone));
  } else if (id == ID_CLOUD) {
    float g = 1.0 - clamp(0.62 + 0.45 * N.y + 0.5 * dif, 0.0, 1.0);
    ink = penHatch(fc, 1.57, 7.0 * uScale, smoothstep(0.35, 0.8, g) * 0.3, 13.0);
  } else {
    // meadow: loose pen strokes, a few flowers, grass
    float haze = smoothstep(MIST_Y, MIST_Y + 8.0, p.y);
    float g = (1.0 - clamp(tone * 1.15, 0.0, 1.0)) * haze;
    float nearT = 1.0 - smoothstep(30.0, 90.0, t);
    ink = penHatch(fc, 2.6, 8.0 * uScale, (smoothstep(0.35, 0.9, g) * 0.45 + 0.1 * nearT) * smoothstep(0.35, 0.6, noise2(p.xz * 0.15)), 14.0);
    vec2 fq = p.xz / 0.55;
    vec2 fcell = floor(fq);
    if (nearT > 0.0 && hash12(fcell) < 0.07 * nearT) {
      vec2 fs = (fq - fcell - vec2(hash12(fcell + 3.0), hash12(fcell + 5.0)) * 0.6 - 0.2) * vec2(1.0, 1.6);
      float fr = max(length(fs), 1e-4);
      float fwF = fwG(vec3(fs.x / fr, 0.0, 1.6 * fs.y / fr) / 0.55);
      ink = max(ink, inkLine(fr - 0.13, fwF, 1.2 * uScale));
      ink = max(ink, inkDot(fs, 0.04, fwF));
    }
    grass = haze * nearT * 0.16 * smoothstep(0.4, 0.6, noise2(p.xz * 0.2 + 3.0));
  }
  encodeOut(ink, id, t, N, grass, 0.0);
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
bool isBoy(float i) { return i == ID_BOY || i == ID_DARK || i == ID_SCARF || i == ID_SKIN || i == ID_BRASS; }

float edgeStrength(float i1, float d1, vec3 n1, float i2, float d2, vec3 n2, int ring) {
  if (i1 == ID_MIST || i2 == ID_MIST) return 0.0;
  float nearD = min(d1, d2);
  float nearI = d1 < d2 ? i1 : i2;
  if (i1 != i2) {
    bool r1 = i1 >= ID_RIDGE, r2 = i2 >= ID_RIDGE;
    if ((r1 || i1 == ID_SKY) && (r2 || i2 == ID_SKY)) {
      float k = nearI - ID_RIDGE;
      if (ring == 1) return 0.0;
      return mix(0.95, 0.6, k / 3.0);
    }
    if (nearI == ID_CLOUD || (i1 == ID_CLOUD && i2 == ID_SKY) || (i2 == ID_CLOUD && i1 == ID_SKY)) return ring == 1 ? 0.0 : 0.85;
    if (isBoy(i1) && isBoy(i2)) return ring == 1 ? 0.0 : 0.8;
    if (nearI == ID_TERRAIN && (i1 >= ID_RIDGE || i2 >= ID_RIDGE)) return ring == 1 ? 0.0 : 0.9;
    return 1.0;
  }
  if (i1 == ID_SKY || i1 >= ID_RIDGE) return 0.0;
  float rel = abs(d1 - d2) / nearD;
  if (rel > 0.04) return ring == 1 ? (i1 == ID_TERRAIN ? 0.0 : 0.85) : 1.0;
  if (ring == 0) return smoothstep(0.25, 0.55, 1.0 - dot(n1, n2)) * (i1 == ID_GIANT ? 0.95 : 0.7);
  return 0.0;
}

float edgesAt(vec2 fc, vec2 wob, float id, float dep, vec3 n) {
  float e = 0.0;
  for (int ring = 0; ring < 2; ring++) {
    float r = (ring == 0 ? 1.2 : 2.4) * uScale;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.785398 + float(ring) * 0.3927;
      vec2 o = vec2(cos(ang), sin(ang)) * r + wob;
      ivec2 sc = clampC(fc + o);
      vec4 a2 = texelFetch(tA, sc, 0), b2 = texelFetch(tB, sc, 0);
      e = max(e, edgeStrength(id, dep, n, idOf(a2), decodeDepth(a2), b2.xyz * 2.0 - 1.0, ring));
    }
  }
  return e;
}

float blades(vec2 fc, float myDepth) {
  float cw = 4.0 * uScale, ch = 4.5 * uScale, maxH = 40.0 * uScale;
  float any = 0.0;
  for (int i = 0; i < 5; i++) {
    float a1 = texelFetch(tB, clampC(fc - vec2(-6.0 * uScale, float(i) * maxH / 4.0)), 0).a;
    float a2 = texelFetch(tB, clampC(fc - vec2(6.0 * uScale, float(i) * maxH / 4.0)), 0).a;
    any = max(any, max(a1 < 0.495 ? a1 : 0.0, a2 < 0.495 ? a2 : 0.0));
  }
  if (any < 0.005) return 0.0;
  float ink = 0.0;
  float cx0 = floor(fc.x / cw) - 1.0;
  float cy1 = floor(fc.y / ch);
  for (int j = 0; j < 10; j++) {
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
      float wh = rid == ID_GIANT ? 0.12 : 0.5;
      float H = min(maxH, wh * uFpx / rdep) * (0.5 + 0.7 * hash12(cell + 9.1));
      if (H < 2.0 * uScale) continue;
      float sy = (fc.y - root.y) / H;
      if (sy < 0.0 || sy > 1.0) continue;
      float lean = (0.3 + 0.25 * (hash12(cell + 2.9) - 0.5)) * H;
      float xc = root.x + lean * sy * sy;
      float slope = 2.0 * lean * sy / H;
      float dist = abs(fc.x - xc) / sqrt(1.0 + slope * slope);
      float w = (1.0 * (1.0 - sy) + 0.2) * uScale;
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

  // two slightly different passes of the pen give the outlines a sketchy, doubled quality
  vec2 w1 = (vec2(noise2(fc * 0.01 / uScale), noise2(fc * 0.01 / uScale + 17.0)) - 0.5) * 2.0 * uScale;
  vec2 w2 = (vec2(noise2(fc * 0.017 / uScale + 5.0), noise2(fc * 0.017 / uScale + 31.0)) - 0.5) * 3.2 * uScale;
  float e1 = edgesAt(fc, w1, id, dep, n);
  float e2 = edgesAt(fc, w2, id, dep, n);
  float gap = smoothstep(0.18, 0.3, noise2(fc * 0.035 / uScale + 7.0));
  float e = max(e1 * mix(0.55, 1.0, gap), e2 * 0.7 * (1.0 - gap * 0.6));

  float bl = blades(fc, dep);
  float ink = max(max(fill, e), bl);

  vec2 uv = fc / uRes;
  float border = min(min(uv.x, 1.0 - uv.x) * uRes.x, min(uv.y, 1.0 - uv.y) * uRes.y) / uRes.y;
  float fade = smoothstep(0.0, 0.03, border + (noise2(fc * 0.006 / uScale) - 0.5) * 0.03);
  ink *= fade;
  vec3 paper = vec3(1.0);
  vec3 inkC = vec3(0.07, 0.07, 0.08);
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
    cam: [1.2, 6.5, 30.0],
    target: [-0.3, 9.3, 0.0],
    fovY: 28,
    light: [-0.6, 0.5, 0.6],
    sunUV: [-0.86, 0.9],
    boy: [3.15, 9.2, 0.15],
    boyYaw: 0.0,
    tree: [-3.3, 9.0, -0.3]
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
      gl.uniform3fv(u('uLight'), norm(o.light));
      gl.uniform2fv(u('uSunUV'), o.sunUV);
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
