# Components

Every component follows one law from Braun hardware: **the control's form displays its state at rest**. If you must interact to learn the state, the component is wrong.

## Buttons

- Shape: rectangle, `--radius`, or a perfect circle (1:1) for icon-only controls — the round Braun key.
- Height `40px` (visual) with ≥44px hit area. Horizontal padding `16px`.
- Label: lowercase, `13–15px`, weight 500.
- Variants:
  - **primary** (max ONE per view): fill `var(--accent)`, text `#FFFFFF` or `--charcoal` per contrast.
  - **standard**: fill `--charcoal`, text `--chassis-white` (light mode) — the black key.
  - **quiet**: transparent, `1px` hairline border, text `--charcoal`.
- Pressed state: darken fill 8%, translate `1px` down. No glow, no ripple.
- Never: pills, gradient fills, icons purely for decoration beside the label.

## Toggle / switch

- Physical metaphor: track `36×20px`, radius `4px` (NOT a pill), thumb `16×16px` square-with-radius that displaces left/right.
- State is shown by **displacement + a text label** ("on"/"off" or the actual value) — never by color alone. Accent may reinforce the on-state only if this toggle is the view's primary operation.

## Slider

- Track: `2px` hairline, `--line-grey`. Filled portion: `--charcoal` (accent only if primary).
- Thumb: `16px` circle or `8×20px` rectangular tab (the Braun fader).
- Tick marks at meaningful stops (`1px × 6px` hairlines) with tiny `11px` labels at extremes. A slider without a visible scale is decoration, not an instrument.
- Current value always rendered as text near the control, tabular numerals.

## Inputs & forms

- Field: `--chassis-warm` fill, `1px` hairline border, `--radius`, height `40px`, padding `0 12px`.
- Label above the field, `13px`, lowercase, `--text-secondary`. Never placeholder-as-label.
- Focus: border becomes `--charcoal`, plus `2px` offset outline `--charcoal`. No colored glow.
- Validation: message in text (`--signal-red` allowed here as semantic red) + `1px` red border. No shaking, no icons raining down.

## Cards / panels

- Fill `--chassis-white` on `--chassis-warm` page (or inverse), `1px` hairline, `--radius`, padding `16–24px`, **no shadow at rest**.
- A card = one functional zone. If a card contains two unrelated functions, split it.

## Navigation

- Flat horizontal or left-rail list, lowercase, `13–15px`.
- Active item: `2px` charcoal underline or left bar (accent only if navigation is genuinely the view's primary operation — it almost never is).
- No hamburger hiding when space exists; visible structure beats hidden structure.

## Tables / data

- Hairline row separators only (no zebra stripes, no vertical lines).
- Header row: `13px`, lowercase, `--text-secondary`, weight 500.
- Numerals right-aligned, tabular. Row height `44px`.

## Icons

- Geometric, single stroke weight (`1.5px`), squared terminals, monochrome `--charcoal`.
- An icon exists only when it replaces a label or marks a function. No decorative icon next to every heading. No emoji in UI, ever.

## Empty states / feedback

- Text, small, honest: "no recordings yet". No illustrations, no mascots.
- Progress: a determinate hairline bar when knowable; a plain "working…" text when not. Never a fake percentage.
