

# Triage Robot Dashboard — Implementation Plan

## Overview

Build a two-screen app: a **lock screen** with the animated robot face (adapted to the Triage color palette), and a **Camera/Ask AI dashboard** that appears when the face is tapped.

## Color Palette Adaptation

The original robot face uses green tones. We will remap everything to the Triage palette:

| Element | Original | New |
|---------|----------|-----|
| Eyes | Green (#2a9d5c) | Primary blue (#0284C7) |
| Eye glow/shadow | Green glow | Light blue glow (#38BDF8) |
| Mouth | Green (#7dd44a) | Light blue (#38BDF8) |
| Particles | Green | Light blue (#38BDF8, #0284C7) |
| Ambient glow | Green radial | Blue radial (#0284C7) |
| Backdrop frost | Green tint | Ice blue (#E0F9FF) |
| Tap hint text | Green | Muted blue |
| Background | Remove/transparent | Dark gray (#1F2937) |
| Hat | Keep wheat/straw colors (neutral, works with any palette) | Same |

## File Structure

```text
src/
├── components/
│   ├── RobotFace.tsx        (converted from JSX, remove i18n dep)
│   ├── RobotFace.css        (recolored CSS)
│   └── CameraAskAI.tsx      (dashboard view)
├── pages/
│   └── Index.tsx             (lock screen → dashboard flow)
├── index.css                 (updated CSS vars for palette)
```

## Implementation Steps

### 1. Set up design system colors
Update `src/index.css` CSS variables to use the Triage palette (`#0284C7`, `#38BDF8`, `#1F2937`, `#E0F9FF`) for primary, secondary, background, and accent.

### 2. Create RobotFace component
- Copy uploaded JSX to `src/components/RobotFace.tsx`, converting to TypeScript
- Remove `i18n` dependency — hardcode English strings ("Tap to begin", etc.)
- Props: `onUnlock`, `mini`, `visible`

### 3. Create recolored RobotFace.css
- Copy uploaded CSS to `src/components/RobotFace.css`
- Replace all green hues with blues from the palette:
  - Eyes: `#0284C7` gradients with `#38BDF8` highlights
  - Mouth: `#38BDF8` base with `#0284C7` shadows
  - Particles/glows: blue tones
  - Frost backdrop: `#E0F9FF` tint
- Keep hat colors (wheat/straw) unchanged — they provide nice contrast
- Keep all animations identical (breathe, blink, expressions, unlock)

### 4. Build Camera/Ask AI dashboard
- Clean, modern layout on `#1F2937` background
- Mini robot face in the top header bar
- Central camera viewfinder area (placeholder/mock — no actual camera API yet)
- "Ask AI" button that simulates taking a photo and asking a question
- Text input for typing questions
- Response display area styled with ice blue (`#E0F9FF`) cards

### 5. Wire up Index page
- Default state: full-screen lock screen with robot face on `#1F2937` background
- On tap/click: unlock animation plays → transitions to Camera/Ask AI dashboard
- Smooth fade/slide transition between screens

## Technical Notes
- The `i18n` import (`createTranslator`) will be removed; all text hardcoded in English
- CSS custom property `--i` on particles needs TypeScript handling (cast to `CSSProperties`)
- The hat `:has()` selectors are used for expression-based hat animations — these work in modern browsers
- Mini mode is used in the dashboard header for brand presence

