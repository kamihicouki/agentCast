# Tokens

All hex values are derived from photographic reference of Braun products (SK4, TP1, ET66, T3, TG60, regie 510, MPZ 2) and Vitsoe 606. They are internally consistent approximations — treat them as canon within this skill.

## Color

### Neutrals (the chassis)

| Token | Hex | Source / use |
|---|---|---|
| `--chassis-white` | `#F2EFE9` | SK4 / KM3 cream white. Page & card background (light mode) |
| `--chassis-warm` | `#E9E5DC` | Secondary surface, inset areas |
| `--panel-grey` | `#D6D3CC` | Tertiary surface, disabled fills |
| `--line-grey` | `#BDBAB2` | 1px hairlines, borders |
| `--text-secondary` | `#6E6C66` | Secondary labels, captions |
| `--charcoal` | `#221F1A` | Primary text; dark chassis (TG60 matte black — note: warm, never `#000`) |

### Dark mode (the black-unit line: TG60, regie 510)

| Token | Hex |
|---|---|
| `--chassis-dark` | `#232220` |
| `--panel-dark` | `#2C2B28` |
| `--line-dark` | `#413F3B` |
| `--text-on-dark` | `#E9E5DC` |
| `--text-secondary-dark` | `#8F8C85` |

### Accents (functional color — pick ONE per view)

| Token | Hex | Braun precedent | Semantic |
|---|---|---|---|
| `--braun-orange` | `#E8501E` | TP1 / phono indicators | default primary action |
| `--function-green` | `#46704F` | power keys on audio units | start / on / confirm |
| `--signal-yellow` | `#F2A900` | ET66 operation key | compute / execute |
| `--signal-red` | `#C13A27` | record keys | destructive / record |

Rules:
- Exactly one accent hue per view. Pick by semantics above; when unsure, orange.
- Accent may appear on: the primary action's fill, an active-state indicator dot/line, a slider thumb. Never on: headings, icons-as-decoration, backgrounds, borders of non-primary elements, links in body copy (links: charcoal + underline).
- Chroma budget: accent-colored pixels ≤5% of the view.

## Typography

- Stack: `"Neue Haas Grotesk", "Helvetica Now Text", Helvetica, Inter, Arial, sans-serif` (Akzidenz-Grotesk if licensed — the true Braun face).
- **All UI text is lowercase**: labels, buttons, nav, headings for zones. `text-transform: lowercase`. Body prose (paragraph content) uses normal sentence case. Never uppercase, anywhere.
- Scale (px): `11, 13, 15, 18, 24` — hard ceiling `32` for a single page title. Braun labeling is small; resist inflating.
- Max 2 sizes per zone, 3 per screen.
- Weights: `400` and `500` only. Hierarchy comes from size + position, not weight. No `600+`, no italics.
- Letter-spacing: `0.01em` at ≥15px; `0.03em` at ≤13px labels.
- Line-height: `1.5` body, `1.2` labels/headings.
- Numerals: `font-variant-numeric: tabular-nums` wherever numbers appear (Braun dials are instruments; figures align).

## Spacing & layout

- Base unit `8px`, half-step `4px`. Every gap is a multiple.
- Functional grouping ratio (the core Braun structural rule):
  - within a zone: `8px` (tight controls) or `12px` (labeled controls)
  - between zones: `24–32px` = **2–3× the inner gap**
- Outer page margins: ≥`32px` desktop, ≥`20px` mobile.
- Alignment: strict orthogonal grid. Left-align text. No centered paragraphs; centering only for a lone element on an axis of symmetry (Braun centers dials, not copy).
- Max content width for text: `68ch`.
- Element budget: ≤7 interactive elements per zone; if exceeded, split the zone.

## Shape & surface

- Radius: `4px` global — inputs, buttons, cards, images, everything. Exception: perfect circles for 1:1 circular controls (round buttons, knobs). **No pills.**
- Borders: `1px solid var(--line-grey)` hairlines; prefer spacing over lines — add a border only when spacing alone fails to separate.
- Shadows: none at rest. Overlays/popovers only: `0 1px 3px rgba(0,0,0,0.12)`. Never stacked shadows, never colored glows.
- Surfaces are matte and flat: no gradients. (Permitted at most: a ≤2% luminance vertical gradient to suggest matte material — use sparingly or not at all.)

## Motion

- Duration `120–180ms`, `ease-out`. Properties: opacity and position only.
- No spring, no bounce, no parallax, no hover scale above `1.02`, no attention-seeking pulses.
- Mechanical honesty: a panel slides open the way a drawer does — one direction, once.

## Paste-ready CSS

```css
:root {
  --chassis-white:#F2EFE9; --chassis-warm:#E9E5DC; --panel-grey:#D6D3CC;
  --line-grey:#BDBAB2; --text-secondary:#6E6C66; --charcoal:#221F1A;
  --accent:#E8501E; /* swap per view semantics: #46704F / #F2A900 / #C13A27 */
  --radius:4px; --gap-in:8px; --gap-in-lg:12px; --gap-zone:28px;
  --shadow-overlay:0 1px 3px rgba(0,0,0,.12);
  --ease:cubic-bezier(0,0,.2,1); --t:150ms;
}
body {
  background:var(--chassis-white); color:var(--charcoal);
  font-family:"Neue Haas Grotesk","Helvetica Now Text",Helvetica,Inter,Arial,sans-serif;
  font-size:15px; line-height:1.5; letter-spacing:.01em;
  font-variant-numeric:tabular-nums;
}
button, label, nav, h1, h2, h3, .ui { text-transform:lowercase; }
```
