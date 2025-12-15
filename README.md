# Stentelligence v2.11


## What's New in v2.11

### Learned from Real Production Files
Analyzed before/after pairs from your CAM software to extract exact modification rules.

### Fine-Pitch: Rectangle → Oblong Conversion
- High aspect ratio pads (≥2.5) with narrow dimension <15mil
- Converted to **Oblong (O)** apertures in export
- Narrow dimension standardized to **9 mil minimum** (industry standard)
- Ensures proper paste release with rounded end caps

### Window Pane Generation
- Large thermal pads (>15,000 sq mil) split into grid patterns
- Uses **G36/G37 region commands** 
- 16 mil web width, 6 mil edge gap 

### Export Format
```gerber
%ADD10O,0.009000X0.025000*%   ← Oblong for fine-pitch
%ADD11R,0.040000X0.030000*%   ← Rectangle for standard
G36*                           ← Region start (window pane)
X100000Y100000D02*
...
G37*                           ← Region end
```

## Stentech Instant Edit Rules

| Pad Type | Detection | Modification |
|----------|-----------|--------------|
| **Fine-pitch** | Aspect ≥2.5, width <15mil | → 9mil oblong, -1mil/side |
| **Standard** | 8-100 mil | -1 mil per side |
| **Thermal** | Area >10k sq mil or dim >100mil | -2 mil per side |
| **Large Thermal** | Area >15k sq mil | → Window pane grid |
| **Very Small** | <8 mil | No change |

## Quick Start

1. Extract zip, delete old `node_modules` folder
2. Create `server/.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
   ```
3. Run `start.bat`
4. Open http://localhost:3001

## Learned Constants (from your CAM)

```javascript
FINE_PITCH_MIN_WIDTH = 9 mil     // Minimum printable width
FINE_PITCH_ASPECT = 2.5          // Aspect ratio threshold
STANDARD_REDUCTION = 1 mil/side  // Normal pads
THERMAL_REDUCTION = 2 mil/side   // Large pads
PANE_WEB_WIDTH = 16 mil          // Window pane web
PANE_EDGE_GAP = 6 mil            // Window pane edge
```

## Export Comparison

| Feature | Before | After (v2.11) |
|---------|--------|---------------|
| Fine-pitch | Rectangle (R) | Oblong (O) |
| Window panes | Flash apertures | Regions (G36/G37) |
| Width minimum | None | 9 mil enforced |
| Thermal pads | -10% | -2 mil/side |

## Requirements

- Node.js 18+
- Modern browser
