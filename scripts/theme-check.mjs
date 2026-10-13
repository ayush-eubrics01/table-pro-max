// Theme rules from docs/superpowers/specs/2026-10-14-design-revamp-design.md: contrast targets,
// environment colours told apart, both dark blocks identical. Used by theme-check.test.mjs.

function vars(body) {
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Light is the plain `:root` block; dark is light overridden by the dark block. */
export function parseThemes(css) {
  const block = (re, what) => {
    const m = re.exec(css);
    if (!m) throw new Error(`tokens.css: ${what} block not found`);
    return vars(m[1]);
  };
  const light = block(/(?:^|\n):root\s*\{([^}]*)\}/, ":root");
  const darkMedia = block(
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/,
    "system dark",
  );
  const darkAttr = block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/, "chosen dark");
  return { light, dark: { ...light, ...darkAttr }, darkMedia, darkAttr };
}

function rgb(hex) {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = rgb(hex).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function oklab(hex) {
  const [r, g, b] = rgb(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function deltaE(a, b) {
  const [x, y] = [oklab(a), oklab(b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export const SURFACES = ["--bg", "--bg-sunken", "--surface", "--surface-panel"];
export const ENVS = ["local", "development", "testing", "staging", "production"];
const ROW_TINTS = ["--selection", "--selection-strong", "--edited-bg", "--inserted-bg", "--deleted-bg", "--surface-hover", "--surface-active"];
const CODE_BG = ["--bg", "--surface"];

/** [foreground, backgrounds, minimum contrast] */
export const PAIRS = [
  ["--text", SURFACES, 4.5],
  ["--text-muted", SURFACES, 4.5],
  ["--text-faint", SURFACES, 3],
  ["--accent", SURFACES, 4.5],
  ["--danger", SURFACES, 4.5],
  ["--warning", SURFACES, 4.5],
  ["--focus", SURFACES, 3],
  ["--accent-text", ["--accent", "--accent-strong"], 4.5],
  ["--danger-text", ["--danger"], 4.5],
  ["--text", ROW_TINTS, 4.5],
  ["--syn-keyword", CODE_BG, 4.5],
  ["--syn-string", CODE_BG, 4.5],
  ["--syn-number", CODE_BG, 4.5],
  ["--syn-type", CODE_BG, 4.5],
  ["--syn-ident", CODE_BG, 4.5],
  ["--syn-comment", CODE_BG, 3],
  ...ENVS.map((e) => [`--env-${e}`, ["--bg", "--bg-sunken", "--surface"], 3]),
  ...ENVS.map((e) => [`--env-${e}-text`, [`--env-${e}-bg`], 4.5]),
];

export function failures(theme) {
  const out = [];
  for (const [fg, bgs, min] of PAIRS) {
    for (const bg of bgs) {
      if (!(fg in theme)) out.push(`missing ${fg}`);
      else if (!(bg in theme)) out.push(`missing ${bg}`);
      else {
        const c = contrast(theme[fg], theme[bg]);
        if (c < min) out.push(`${fg} on ${bg}: ${c.toFixed(2)} < ${min}`);
      }
    }
  }
  return [...new Set(out)];
}
