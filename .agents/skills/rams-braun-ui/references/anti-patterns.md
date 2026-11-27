# Anti-patterns (the forbidden list)

If any of these appear, the output is not Rams, regardless of how "clean" it looks. This list carries the principles that don't fit into tokens — honesty, longevity, unobtrusiveness — as enforceable negatives.

## Color
- More than one accent hue on a view
- Chroma on anything that is not an operation (colored headings, colored icons, colored borders, tinted backgrounds)
- Pure black `#000` or pure white `#FFF` as chassis (Braun neutrals are warm)
- Color as the only carrier of state

## Surface & shape
- Gradients (beyond the ≤2% matte allowance), glassmorphism, neumorphism, frosted blur
- Shadow stacks, colored glows, "elevation systems" with 5 levels
- Pill buttons, mixed corner radii, oversized radii (>8px)
- Fake materials: wood, brushed metal, leather, speaker-grille textures, dials that don't turn

## Typography
- UPPERCASE anywhere (including acronym-styled headings)
- Weights ≥600, italics, decorative or serif display faces
- More than 3 font sizes on a screen; hero text >32px
- Centered paragraphs

## Motion & behavior
- Bounce, spring, parallax, pulse, shimmer skeletons, hover scale >1.02
- Hover-only affordances; hidden gestures; controls that don't show current state
- Auto-playing carousels

## Honesty (Rams principle 4 & 6, enforced)
- Fake progress bars, fake countdown timers, fake scarcity ("3 left!")
- Dark patterns: confirm-shaming, pre-checked boxes, buried unsubscribe
- Decorative "AI sparkle" icons implying magic where there is a function

## Longevity (principle 7, enforced)
- Any effect identifiable with a design season (glass 2021, gradient mesh 2023, etc.)
- Trend-driven asymmetry, brutalist noise, sticker-style illustration

## Excess (principle 10, enforced)
- Icon + label where one suffices
- Divider lines where spacing already separates
- A second CTA "just in case"
- Onboarding tooltips explaining what a visible label already says
