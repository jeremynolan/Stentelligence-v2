/**
 * STENTELLIGENCE v2.7 - WITH AI INTERPRETATION
 */

require('dotenv').config();

const http = require('http');
const gerberParser = require('gerber-parser');
const gerberPlotter = require('gerber-plotter');

// Try to load Anthropic SDK
let Anthropic = null;
let anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk').default;
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-api-key-here') {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('✓ Claude AI enabled');
  } else {
    console.log('⚠ No API key - using local interpretation only');
    console.log('  Set ANTHROPIC_API_KEY in .env file to enable AI');
  }
} catch (e) {
  console.log('⚠ Anthropic SDK not installed - using local interpretation');
}

const STENTECH = {
  thermal: { areaThresholdIn: 0.005, webWidthIn: 0.016, edgeGapIn: 0.006 },
  finePitch: { aspectRatio: 2.0, maxWidthIn: 0.015 }
};

// ============================================================================
// GERBER PARSER
// ============================================================================
function parseGerber(gerberContent) {
  return new Promise((resolve) => {
    const parser = gerberParser();
    const plotter = gerberPlotter();
    const result = { tools: {}, shapes: [], bounds: null, units: 'in' };
    let shapeId = 0;
    
    plotter.on('data', (obj) => {
      try {
        if (obj.type === 'shape') {
          const s = obj.shape?.[0];
          if (s?.type === 'poly' && s.points) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            s.points.forEach(p => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
            result.tools[obj.tool] = { type: 'poly', points: s.points, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
          } else if (s?.type === 'circle') {
            result.tools[obj.tool] = { type: 'circle', width: (s.r || 0.01) * 2, height: (s.r || 0.01) * 2 };
          } else if (s) {
            result.tools[obj.tool] = { type: s.type || 'rect', width: s.width || 0.01, height: s.height || s.width || 0.01 };
          }
        } else if (obj.type === 'pad') {
          const tool = result.tools[obj.tool] || { type: 'rect', width: 0.01, height: 0.01 };
          const shape = { id: 'pad-' + (shapeId++), type: 'pad', tool: obj.tool, x: obj.x || 0, y: obj.y || 0, width: tool.width, height: tool.height };
          if (tool.type === 'poly' && tool.points) { shape.polyPoints = tool.points; shape.polyCx = tool.cx || 0; shape.polyCy = tool.cy || 0; }
          result.shapes.push(shape);
        } else if (obj.type === 'fill' && obj.path) {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          const points = [];
          obj.path.forEach(seg => { if (seg.start) { points.push({ x: seg.start[0], y: seg.start[1] }); minX = Math.min(minX, seg.start[0]); maxX = Math.max(maxX, seg.start[0]); minY = Math.min(minY, seg.start[1]); maxY = Math.max(maxY, seg.start[1]); }});
          if (points.length >= 3 && isFinite(minX)) result.shapes.push({ id: 'fill-' + (shapeId++), type: 'fill', x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY, points });
        } else if (obj.type === 'stroke' && obj.start && obj.end) {
          // Stroke = line draw (common in silk/legend layers)
          const tool = result.tools[obj.tool] || { width: 0.01 };
          result.shapes.push({
            id: 'stroke-' + (shapeId++),
            type: 'stroke',
            tool: obj.tool,
            x1: obj.start[0], y1: obj.start[1],
            x2: obj.end[0], y2: obj.end[1],
            x: (obj.start[0] + obj.end[0]) / 2,
            y: (obj.start[1] + obj.end[1]) / 2,
            width: tool.width || 0.01
          });
        } else if (obj.type === 'size' && obj.box) {
          result.bounds = { minX: obj.box[0], minY: obj.box[1], maxX: obj.box[2], maxY: obj.box[3] };
        }
      } catch (e) {}
    });
    
    plotter.once('end', () => {
      if (!result.bounds && result.shapes.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        result.shapes.forEach(s => { const hw = (s.width || 0.01) / 2; minX = Math.min(minX, s.x - hw); maxX = Math.max(maxX, s.x + hw); minY = Math.min(minY, s.y - hw); maxY = Math.max(maxY, s.y + hw); });
        if (isFinite(minX)) result.bounds = { minX, minY, maxX, maxY };
      }
      if (!result.bounds) result.bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      console.log(`Parsed: ${result.shapes.length} shapes`);
      resolve(result);
    });
    
    parser.pipe(plotter);
    parser.write(gerberContent);
    parser.end();
  });
}

// ============================================================================
// WINDOW PANES
// ============================================================================
function generateWindowPanes(cx, cy, w, h, rows, cols, webW, edgeG) {
  const panes = [];
  const innerW = w - 2 * edgeG, innerH = h - 2 * edgeG;
  const paneW = (innerW - (cols - 1) * webW) / cols;
  const paneH = (innerH - (rows - 1) * webW) / rows;
  if (paneW <= 0.001 || paneH <= 0.001) return [];
  const startX = cx - innerW / 2 + paneW / 2, startY = cy - innerH / 2 + paneH / 2;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) panes.push({ x: startX + c * (paneW + webW), y: startY + r * (paneH + webW), width: paneW, height: paneH });
  return panes;
}

// ============================================================================
// NORMALIZE UNIT
// ============================================================================
function normalizeUnit(unit) {
  if (!unit) return '%';
  const u = unit.toLowerCase().trim();
  if (u === '%' || u === 'percent' || u === 'pct') return '%';
  if (u === 'mil' || u === 'mils' || u === 'thou') return 'mil';
  if (u === 'mm' || u === 'millimeter') return 'mm';
  return '%';
}

// ============================================================================
// MODIFICATION ENGINE
// ============================================================================
function applyModification(data, cmd) {
  const action = cmd.action || 'reduce';
  const target = cmd.target || 'all';
  const selectedOnly = cmd.selectedOnly === true;
  const unit = normalizeUnit(cmd.unit);
  const value = cmd.value || 10;
  const windowPane = cmd.windowPane;
  
  console.log(`MODIFY: action=${action} target=${target} value=${value} unit=${unit} selectedOnly=${selectedOnly}`);
  
  const newShapes = [];
  let modCount = 0;
  
  data.shapes.forEach(shape => {
    if (shape.deleted || shape.type === 'pane') { newShapes.push(shape); return; }
    
    // Selection filter
    if (selectedOnly && !shape.selected) { newShapes.push(shape); return; }
    
    const tool = data.tools[shape.tool];
    const w = shape.modifiedWidth || shape.width || tool?.width || 0.01;
    const h = shape.modifiedHeight || shape.height || tool?.height || w;
    const area = w * h;
    const aspect = Math.max(w, h) / Math.min(w, h);
    const minDim = Math.min(w, h);
    const toolType = tool?.type || 'rect';
    
    // Target filter
    let match = target === 'all' || target === 'selected';
    if (target === 'circles') match = toolType === 'circle';
    if (target === 'rectangles') match = toolType === 'rect' || toolType === 'poly';
    if (target === 'thermal') match = area > STENTECH.thermal.areaThresholdIn;
    if (target === 'finePitch') match = (aspect >= 2.0 && minDim < 0.015) || Math.max(w, h) < 0.025;
    
    if (!match) { newShapes.push(shape); return; }
    
    // Apply action
    if (action === 'reduce' || action === 'enlarge' || action === 'scale') {
      const isReduce = action === 'reduce';
      let newW, newH;
      
      if (unit === '%') {
        const factor = value / 100;
        newW = isReduce ? w * (1 - factor) : w * (1 + factor);
        newH = isReduce ? h * (1 - factor) : h * (1 + factor);
      } else if (unit === 'mil') {
        const delta = (value / 1000) * 2;
        newW = isReduce ? w - delta : w + delta;
        newH = isReduce ? h - delta : h + delta;
      } else if (unit === 'mm') {
        const delta = (value / 25.4) * 2;
        newW = isReduce ? w - delta : w + delta;
        newH = isReduce ? h - delta : h + delta;
      } else {
        newW = isReduce ? w * 0.9 : w * 1.1;
        newH = isReduce ? h * 0.9 : h * 1.1;
      }
      
      newShapes.push({ ...shape, modifiedWidth: Math.max(0.001, newW), modifiedHeight: Math.max(0.001, newH), modified: true, editType: 'reduce' });
      modCount++;
    } else if (action === 'delete') {
      newShapes.push({ ...shape, deleted: true });
      modCount++;
    } else if (action === 'cornerRadius') {
      const radius = unit === 'mm' ? value / 25.4 : unit === 'mil' ? value / 1000 : value / 25.4;
      newShapes.push({ ...shape, cornerRadius: Math.min(radius, Math.min(w, h) / 2), modified: true, editType: 'cornerRadius' });
      modCount++;
    } else if (action === 'windowPane' && windowPane) {
      const rows = windowPane.rows || 2, cols = windowPane.cols || 2;
      const webW = (windowPane.webWidth || 0.4) / 25.4, edgeG = (windowPane.edgeGap || 0.15) / 25.4;
      const panes = generateWindowPanes(shape.x, shape.y, w, h, rows, cols, webW, edgeG);
      if (panes.length > 0) {
        newShapes.push({ ...shape, deleted: true, replacedByPanes: true });
        panes.forEach((p, i) => newShapes.push({ id: shape.id + '-pane-' + i, type: 'pane', x: p.x, y: p.y, width: p.width, height: p.height, parentId: shape.id, parentX: shape.x, parentY: shape.y, parentOriginalWidth: w, parentOriginalHeight: h, editType: 'windowPane' }));
        modCount++;
      } else newShapes.push(shape);
    } else if (action === 'reset') {
      const r = { ...shape }; delete r.modifiedWidth; delete r.modifiedHeight; delete r.modified; delete r.editType; delete r.cornerRadius;
      newShapes.push(r);
      modCount++;
    } else {
      newShapes.push(shape);
    }
  });
  
  data.shapes = newShapes;
  console.log(`Modified: ${modCount}`);
  return modCount;
}

// ============================================================================
// STENTECH INSTANT EDIT - Professional CAM Rules (Unit-Aware)
// Based on analysis of VisualCAM output patterns:
// 1. Fine-pitch leads: -1 mil/side, convert to oblong
// 2. Standard pads: -1 mil/side, add corner radius
// 3. Thermal pads: -2 mil/side, window pane large ones
// 4. Circles (BGAs): Add corner radius (home plates)
// 5. Very small: No change (maintain printability)
// ============================================================================
function applyStentechInstant(data) {
  const log = [];
  let fpCount = 0, stdCount = 0, thermalCount = 0, paneCount = 0, radiusCount = 0;
  
  // Detect units from data - if first shape width is tiny, likely mm; if larger, likely inches
  // Also check explicit units field
  const sampleW = data.shapes?.[0]?.width || 0.01;
  const isInches = data.units === 'in' || (sampleW > 0 && sampleW < 1); // Inches have small decimal values
  
  // All thresholds in INCHES (internal gerber standard)
  // 1 mil = 0.001 inches
  const MIL = 0.001; // 1 mil in inches
  
  const FINE_PITCH_MIN_WIDTH = 9 * MIL;     // 9 mil minimum width for fine-pitch
  const FINE_PITCH_ASPECT = 2.5;             // Aspect ratio threshold
  const FINE_PITCH_MAX_WIDTH = 15 * MIL;     // 15 mil max for fine-pitch classification
  const THERMAL_AREA_THRESHOLD = 10000 * MIL * MIL;  // 10,000 sq mil
  const THERMAL_DIM_THRESHOLD = 100 * MIL;   // 100 mil
  const STANDARD_REDUCTION = 1 * MIL;        // 1 mil per side
  const THERMAL_REDUCTION = 2 * MIL;         // 2 mil per side
  const MIN_PAD_SIZE = 8 * MIL;              // 8 mil - below this, don't reduce
  const CORNER_RADIUS = 2 * MIL;             // 2 mil default corner radius
  
  // Window pane settings
  const PANE_WEB_WIDTH = 16 * MIL;           // 16 mil web width
  const PANE_EDGE_GAP = 6 * MIL;             // 6 mil edge gap
  const PANE_AREA_THRESHOLD = 15000 * MIL * MIL;  // 15,000 sq mil for window panes
  
  // If data is in mm, convert thresholds (multiply by 25.4)
  const scale = isInches ? 1 : 25.4;
  const FP_MIN = FINE_PITCH_MIN_WIDTH * scale;
  const FP_MAX = FINE_PITCH_MAX_WIDTH * scale;
  const TH_AREA = THERMAL_AREA_THRESHOLD * scale * scale;
  const TH_DIM = THERMAL_DIM_THRESHOLD * scale;
  const STD_RED = STANDARD_REDUCTION * scale;
  const TH_RED = THERMAL_REDUCTION * scale;
  const MIN_SIZE = MIN_PAD_SIZE * scale;
  const CR = CORNER_RADIUS * scale;
  const WEB = PANE_WEB_WIDTH * scale;
  const EDGE = PANE_EDGE_GAP * scale;
  const PANE_AREA = PANE_AREA_THRESHOLD * scale * scale;
  
  console.log(`  Units: ${isInches ? 'inches' : 'mm'}, scale=${scale}`);
  console.log(`  Thresholds: MIN_SIZE=${MIN_SIZE.toFixed(4)}, FP_MAX=${FP_MAX.toFixed(4)}, TH_AREA=${TH_AREA.toFixed(4)}`);
  
  data.shapes.forEach(s => {
    if (s.deleted || s.type === 'pane' || s.modified) return;
    
    const tool = data.tools[s.tool];
    const w = s.width || tool?.width || 0.01;
    const h = s.height || tool?.height || w;
    const area = w * h;
    const aspect = Math.max(w, h) / Math.min(w, h);
    const minDim = Math.min(w, h);
    const maxDim = Math.max(w, h);
    const isCircle = tool?.type === 'circle';
    
    // Rule 1: Very small pads - no modification (maintain printability)
    if (minDim < MIN_SIZE) {
      return;
    }
    
    // Rule 2: Fine-pitch leads (high aspect ratio, narrow)
    if (!isCircle && aspect >= FINE_PITCH_ASPECT && minDim < FP_MAX) {
      // Apply -1 mil per side reduction
      let newW, newH;
      if (w < h) {
        newW = Math.max(FP_MIN, w - STD_RED * 2);
        newH = h - STD_RED * 2;
      } else {
        newW = w - STD_RED * 2;
        newH = Math.max(FP_MIN, h - STD_RED * 2);
      }
      
      s.modifiedWidth = Math.max(FP_MIN, newW);
      s.modifiedHeight = Math.max(FP_MIN, newH);
      s.modified = true;
      s.editType = 'finePitch';
      s.convertToOblong = true;
      fpCount++;
      return;
    }
    
    // Rule 3: Large thermal pads - window pane if big enough
    if (area > PANE_AREA) {
      const reducedW = w - TH_RED * 2;
      const reducedH = h - TH_RED * 2;
      
      let rows, cols;
      if (aspect < 1.5) {
        rows = cols = 2;
      } else if (w > h) {
        rows = 2; cols = 3;
      } else {
        rows = 3; cols = 2;
      }
      
      const panes = generateWindowPanes(s.x, s.y, reducedW, reducedH, rows, cols, WEB, EDGE);
      
      if (panes.length > 0) {
        s.deleted = true;
        s.replacedByPanes = true;
        panes.forEach((p, i) => {
          data.shapes.push({
            id: s.id + '-pane-' + i,
            type: 'pane',
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
            modifiedWidth: p.width,
            modifiedHeight: p.height,
            parentId: s.id,
            editType: 'windowPane',
            cornerRadius: CR
          });
        });
        paneCount++;
        return;
      }
    }
    
    // Rule 4: Medium-large thermal pads
    if (area > TH_AREA || maxDim > TH_DIM) {
      const newW = w - TH_RED * 2;
      const newH = h - TH_RED * 2;
      
      s.modifiedWidth = Math.max(MIN_SIZE, newW);
      s.modifiedHeight = Math.max(MIN_SIZE, newH);
      s.cornerRadius = Math.min(CR, Math.min(newW, newH) / 4);
      s.modified = true;
      s.editType = 'thermal';
      thermalCount++;
      radiusCount++;
      return;
    }
    
    // Rule 5: Circles (BGAs)
    if (isCircle) {
      const newSize = w - STD_RED * 2;
      s.modifiedWidth = Math.max(MIN_SIZE, newSize);
      s.modifiedHeight = Math.max(MIN_SIZE, newSize);
      s.cornerRadius = Math.min(CR, newSize / 4);
      s.modified = true;
      s.editType = 'circle';
      stdCount++;
      radiusCount++;
      return;
    }
    
    // Rule 6: Standard rectangular pads
    const newW = w - STD_RED * 2;
    const newH = h - STD_RED * 2;
    
    s.modifiedWidth = Math.max(MIN_SIZE, newW);
    s.modifiedHeight = Math.max(MIN_SIZE, newH);
    s.cornerRadius = Math.min(CR, Math.min(newW, newH) / 4);
    s.modified = true;
    s.editType = 'standard';
    stdCount++;
    radiusCount++;
  });
  
  // Build summary log
  if (fpCount > 0) log.push(`Fine-pitch: ${fpCount} leads → oblong, -1mil/side`);
  if (stdCount > 0) log.push(`Standard: ${stdCount} pads → -1mil/side`);
  if (thermalCount > 0) log.push(`Thermal: ${thermalCount} pads → -2mil/side`);
  if (paneCount > 0) log.push(`Window panes: ${paneCount} large pads → ${paneCount * 4}+ openings`);
  if (radiusCount > 0) log.push(`Corner radius: ${radiusCount} pads → 2mil radius`);
  
  if (log.length === 0) log.push('No modifications applied');
  
  return { 
    log, 
    counts: { 
      finePitch: fpCount, 
      standard: stdCount, 
      thermal: thermalCount,
      windowPanes: paneCount,
      cornerRadius: radiusCount
    } 
  };
}

// ============================================================================
// DFM ANALYSIS - Analyze selected shapes for manufacturability
// ============================================================================
function analyzeDFM(shapes, tools, datasheet = null) {
  const issues = [];
  const MIL = 0.001; // 1 mil in inches
  
  // Detect units from first shape
  const sampleW = shapes?.[0]?.width || 0.01;
  const isInches = sampleW > 0 && sampleW < 1;
  const scale = isInches ? 1 : 1/25.4; // Convert to inches for analysis
  
  // Collect stats
  let minWidth = Infinity, maxWidth = 0, minHeight = Infinity, maxHeight = 0;
  let totalArea = 0;
  const aspectRatios = [];
  const widths = [];
  const heights = [];
  const typeCount = {};
  
  shapes.forEach(s => {
    if (s.deleted) return;
    const tool = tools?.[s.tool];
    const w = (s.width || tool?.width || 0.01) * scale;
    const h = (s.height || tool?.height || w) * scale;
    
    minWidth = Math.min(minWidth, w);
    maxWidth = Math.max(maxWidth, w);
    minHeight = Math.min(minHeight, h);
    maxHeight = Math.max(maxHeight, h);
    totalArea += w * h;
    aspectRatios.push(Math.max(w, h) / Math.min(w, h));
    widths.push(w);
    heights.push(h);
    
    const type = tool?.type || 'rect';
    typeCount[type] = (typeCount[type] || 0) + 1;
  });
  
  const avgAspect = aspectRatios.reduce((a, b) => a + b, 0) / aspectRatios.length || 1;
  const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length || 0;
  
  // Format dimension for display
  const fmtDim = (inches) => {
    const mil = inches / MIL;
    if (mil < 100) return mil.toFixed(1) + ' mil';
    return (inches * 25.4).toFixed(2) + ' mm';
  };
  
  // =========================================================================
  // DFM RULES
  // =========================================================================
  
  // Rule 1: Very narrow pads (< 8 mil) - paste release issues
  const narrowCount = widths.filter(w => Math.min(w, heights[widths.indexOf(w)]) < 8 * MIL).length;
  if (narrowCount > 0) {
    issues.push({
      severity: 'warning',
      title: 'Narrow Pad Warning',
      description: `${narrowCount} pad(s) narrower than 8 mil may have paste release issues. Consider minimum 9 mil width.`,
      action: { action: 'reduce', target: 'selected', value: 0, unit: 'mil', selectedOnly: true }
    });
  }
  
  // Rule 2: High aspect ratio without oblong conversion
  const highAspectCount = aspectRatios.filter(a => a >= 2.5).length;
  if (highAspectCount > 0 && avgWidth < 15 * MIL) {
    issues.push({
      severity: 'info',
      title: 'Fine-Pitch Leads Detected',
      description: `${highAspectCount} pad(s) have aspect ratio ≥2.5. Consider oblong apertures for better paste release.`,
      action: { action: 'finePitch', target: 'selected', selectedOnly: true }
    });
  }
  
  // Rule 3: Large thermal pads without window panes
  const largeCount = shapes.filter(s => {
    const tool = tools?.[s.tool];
    const w = (s.width || tool?.width || 0.01) * scale;
    const h = (s.height || tool?.height || w) * scale;
    return w * h > 15000 * MIL * MIL && s.type !== 'pane';
  }).length;
  if (largeCount > 0) {
    issues.push({
      severity: 'warning',
      title: 'Large Thermal Pads',
      description: `${largeCount} pad(s) exceed 15,000 sq mil. Window panes recommended to prevent mid-chip solder balls.`,
      action: { action: 'windowPane', target: 'selected', rows: 2, cols: 2, selectedOnly: true }
    });
  }
  
  // Rule 4: Standard paste reduction
  const unreducedCount = shapes.filter(s => !s.modified && s.type !== 'pane').length;
  if (unreducedCount > 0) {
    issues.push({
      severity: 'info',
      title: 'Paste Reduction Recommended',
      description: `${unreducedCount} pad(s) at original size. Standard practice: reduce 1-2 mil per side or 10% for better paste volume control.`,
      action: { action: 'reduce', target: 'selected', value: 10, unit: '%', selectedOnly: true }
    });
  }
  
  // Rule 5: Corner radius for standard pads
  const noRadiusCount = shapes.filter(s => !s.cornerRadius && s.type !== 'pane').length;
  if (noRadiusCount > 0 && avgAspect < 2.5) {
    issues.push({
      severity: 'info',
      title: 'Corner Radius Suggestion',
      description: `${noRadiusCount} pad(s) have sharp corners. Rounded corners (2 mil) improve paste release.`,
      action: { action: 'cornerRadius', target: 'selected', value: 2, unit: 'mil', selectedOnly: true }
    });
  }
  
  // Rule 6: Datasheet-based recommendations
  if (datasheet) {
    // Check if datasheet specifies recommended aperture sizes
    if (datasheet.recommendedAperture) {
      const recW = datasheet.recommendedAperture.width * scale;
      const recH = datasheet.recommendedAperture.height * scale;
      const tolerance = 2 * MIL;
      
      const mismatchCount = shapes.filter(s => {
        const tool = tools?.[s.tool];
        const w = (s.modifiedWidth || s.width || tool?.width || 0.01) * scale;
        const h = (s.modifiedHeight || s.height || tool?.height || w) * scale;
        return Math.abs(w - recW) > tolerance || Math.abs(h - recH) > tolerance;
      }).length;
      
      if (mismatchCount > 0) {
        issues.push({
          severity: 'warning',
          title: 'Datasheet Aperture Mismatch',
          description: `${mismatchCount} pad(s) don't match datasheet recommendation (${fmtDim(recW)} x ${fmtDim(recH)}). Consider adjusting.`,
          action: { action: 'resize', target: 'selected', width: datasheet.recommendedAperture.width, height: datasheet.recommendedAperture.height, selectedOnly: true }
        });
      }
    }
    
    // Check pitch compatibility
    if (datasheet.pitch) {
      const pitchInches = datasheet.pitchUnit === 'mm' ? datasheet.pitch / 25.4 : datasheet.pitch * MIL;
      if (pitchInches < 20 * MIL) {
        issues.push({
          severity: 'info',
          title: 'Fine Pitch Component',
          description: `Datasheet indicates ${datasheet.pitch}${datasheet.pitchUnit || 'mil'} pitch. Use oblong apertures and -1mil/side reduction.`,
          action: { action: 'finePitch', target: 'selected', selectedOnly: true }
        });
      }
    }
  }
  
  // Build summary
  const summary = {
    count: shapes.filter(s => !s.deleted).length,
    uniqueTypes: Object.keys(typeCount).join(', ') || 'rect',
    minWidth: fmtDim(minWidth),
    maxWidth: fmtDim(maxWidth),
    avgAspect: avgAspect.toFixed(1),
    totalArea: (totalArea / (MIL * MIL)).toFixed(0) + ' sq mil'
  };
  
  // Component info from datasheet
  const componentInfo = datasheet ? {
    name: datasheet.componentName,
    package: datasheet.package,
    pitch: datasheet.pitch ? `${datasheet.pitch}${datasheet.pitchUnit || 'mil'}` : null
  } : null;
  
  return { issues, summary, componentInfo };
}

// ============================================================================
// PARSE DATASHEET - Extract component info from uploaded datasheet
// ============================================================================
function parseDatasheet(content, filename) {
  const result = {
    filename,
    componentName: null,
    package: null,
    pitch: null,
    pitchUnit: 'mil',
    recommendedAperture: null,
    raw: content.slice(0, 2000) // Keep first 2000 chars for reference
  };
  
  // Try JSON first
  try {
    const json = JSON.parse(content);
    if (json.componentName) result.componentName = json.componentName;
    if (json.package) result.package = json.package;
    if (json.pitch) {
      result.pitch = json.pitch;
      result.pitchUnit = json.pitchUnit || 'mil';
    }
    if (json.aperture || json.recommendedAperture) {
      result.recommendedAperture = json.aperture || json.recommendedAperture;
    }
    return result;
  } catch (e) {
    // Not JSON, parse as text
  }
  
  const lower = content.toLowerCase();
  
  // Extract component name from filename or content
  const nameMatch = filename.match(/^([A-Z0-9\-]+)/i) || content.match(/(?:part|component|device)[:\s]+([A-Z0-9\-]+)/i);
  if (nameMatch) result.componentName = nameMatch[1];
  
  // Extract package type
  const packagePatterns = [
    /(?:package|footprint|case)[:\s]+([A-Z0-9\-]+)/i,
    /\b(QFN|QFP|BGA|SOIC|TSSOP|SOT|DFN|LGA|WLCSP|CSP|PLCC|PQFP|LQFP|TQFP|VQFN|HVQFN)[\-\s]?(\d+)?/i
  ];
  for (const pat of packagePatterns) {
    const match = content.match(pat);
    if (match) {
      result.package = match[1] + (match[2] || '');
      break;
    }
  }
  
  // Extract pitch
  const pitchPatterns = [
    /(?:pitch|lead\s*pitch)[:\s]+(\d+(?:\.\d+)?)\s*(mm|mil)?/i,
    /(\d+(?:\.\d+)?)\s*(mm|mil)\s*pitch/i,
    /\b(\d+(?:\.\d+)?)\s*mil\s+pitch/i
  ];
  for (const pat of pitchPatterns) {
    const match = content.match(pat);
    if (match) {
      result.pitch = parseFloat(match[1]);
      result.pitchUnit = match[2] || 'mil';
      break;
    }
  }
  
  // Extract recommended aperture/stencil info
  const aperturePatterns = [
    /(?:stencil|aperture)[:\s]+(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|mil)?/i,
    /(?:opening|pad)[:\s]+(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|mil)?/i,
    /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|mil)?\s*(?:aperture|opening|stencil)/i
  ];
  for (const pat of aperturePatterns) {
    const match = content.match(pat);
    if (match) {
      const unit = match[3] || 'mil';
      const scale = unit === 'mm' ? 1 : 0.0254; // Convert to mm
      result.recommendedAperture = {
        width: parseFloat(match[1]) * scale,
        height: parseFloat(match[2]) * scale,
        unit
      };
      break;
    }
  }
  
  // Look for reduction recommendations
  const reductionMatch = content.match(/(?:reduce|reduction)[:\s]+(\d+(?:\.\d+)?)\s*(%|percent|mil)?/i);
  if (reductionMatch) {
    result.recommendedReduction = {
      value: parseFloat(reductionMatch[1]),
      unit: reductionMatch[2] === '%' || reductionMatch[2] === 'percent' ? '%' : 'mil'
    };
  }
  
  console.log('Parsed datasheet:', result);
  return result;
}

// ============================================================================
// APPLY PREDEFINED SHAPE - Convert pads to specific shapes
// ============================================================================
function applyPredefinedShape(data, shape, selectedOnly = true) {
  const MIL = 0.001; // inches
  let count = 0;
  
  // Detect units
  const sampleW = data.shapes?.[0]?.width || 0.01;
  const isInches = sampleW > 0 && sampleW < 1;
  const scale = isInches ? MIL : MIL * 25.4; // Convert mil to data units
  
  const w = shape.width * scale;
  const h = shape.height * scale;
  const r = shape.radius * scale;
  const xOff = (shape.xOffset || 0) * scale;
  const rotation = shape.rotation || 0;
  
  data.shapes.forEach(s => {
    if (s.deleted) return;
    if (selectedOnly && !s.selected) return;
    
    // Apply new dimensions
    s.modifiedWidth = w;
    s.modifiedHeight = h;
    s.modified = true;
    s.shapeType = shape.type;
    s.rotation = rotation;
    
    // Shape-specific properties
    switch (shape.type) {
      case 'rectangle':
        s.cornerRadius = 0;
        s.editType = 'rectangle';
        break;
      case 'rounded':
        s.cornerRadius = r;
        s.editType = 'cornerRadius';
        break;
      case 'oblong':
        // Oblong has full radius on short side
        s.cornerRadius = Math.min(w, h) / 2;
        s.convertToOblong = true;
        s.editType = 'oblong';
        break;
      case 'homeplate':
        s.cornerRadius = r;
        s.homeplateOffset = xOff;
        s.editType = 'homeplate';
        break;
      case 'dshape':
        s.cornerRadius = Math.min(w, h) / 2;
        s.dshape = true;
        s.editType = 'dshape';
        break;
    }
    
    count++;
  });
  
  return count;
}

// ============================================================================
// APPLY SIZE MODIFICATION - Scale or adjust pad sizes
// ============================================================================
function applySizeModification(data, size, selectedOnly = true) {
  const MIL = 0.001;
  let count = 0;
  
  // Detect units
  const sampleW = data.shapes?.[0]?.width || 0.01;
  const isInches = sampleW > 0 && sampleW < 1;
  const scale = isInches ? MIL : MIL * 25.4;
  
  data.shapes.forEach(s => {
    if (s.deleted || s.type === 'pane') return;
    if (selectedOnly && !s.selected) return;
    
    const tool = data.tools?.[s.tool];
    const origW = s.modifiedWidth || s.width || tool?.width || 0.01;
    const origH = s.modifiedHeight || s.height || tool?.height || origW;
    
    let newW = origW, newH = origH;
    
    switch (size.mode) {
      case 'percent':
        // Reduce/enlarge by percentage
        const factor = 1 - (size.value / 100);
        if (size.direction === 'all' || size.direction === 'x') {
          newW = origW * factor;
        }
        if (size.direction === 'all' || size.direction === 'y') {
          newH = origH * factor;
        }
        if (size.direction === 'inward') {
          // All four sides move inward
          newW = origW * factor;
          newH = origH * factor;
        }
        break;
        
      case 'area':
        // Reduce by area percentage (square root scaling)
        const areaFactor = Math.sqrt(1 - (size.value / 100));
        newW = origW * areaFactor;
        newH = origH * areaFactor;
        break;
        
      case 'absolute':
        // Absolute reduction in mil
        const reduction = size.value * scale;
        if (size.direction === 'all' || size.direction === 'inward') {
          newW = origW - reduction * 2;
          newH = origH - reduction * 2;
        } else if (size.direction === 'x') {
          newW = origW - reduction * 2;
        } else if (size.direction === 'y') {
          newH = origH - reduction * 2;
        }
        break;
    }
    
    // Ensure minimum size (8 mil)
    const minSize = 8 * scale;
    s.modifiedWidth = Math.max(minSize, newW);
    s.modifiedHeight = Math.max(minSize, newH);
    s.modified = true;
    s.editType = 'reduce';
    count++;
  });
  
  return count;
}

// ============================================================================
// APPLY CHOP UP - Create window panes with custom parameters
// ============================================================================
function applyChopUp(data, chop, selectedOnly = true) {
  const MIL = 0.001;
  let count = 0;
  let paneCount = 0;
  
  // Detect units
  const sampleW = data.shapes?.[0]?.width || 0.01;
  const isInches = sampleW > 0 && sampleW < 1;
  const scale = isInches ? MIL : MIL * 25.4;
  
  const gapX = chop.gapX * scale;
  const gapY = chop.gapY * scale;
  const cols = chop.numX || 2;
  const rows = chop.numY || 2;
  
  const shapesToProcess = data.shapes.filter(s => {
    if (s.deleted || s.type === 'pane') return false;
    if (selectedOnly && !s.selected) return false;
    return true;
  });
  
  shapesToProcess.forEach(s => {
    const tool = data.tools?.[s.tool];
    const w = s.modifiedWidth || s.width || tool?.width || 0.01;
    const h = s.modifiedHeight || s.height || tool?.height || w;
    
    // Calculate pane dimensions
    // Total gap space: (cols-1) * gapX for horizontal, (rows-1) * gapY for vertical
    const totalGapX = (cols - 1) * gapX;
    const totalGapY = (rows - 1) * gapY;
    
    // Edge gap (half of gap on each edge)
    const edgeGapX = gapX / 2;
    const edgeGapY = gapY / 2;
    
    // Available space after edge gaps
    const availW = w - edgeGapX * 2;
    const availH = h - edgeGapY * 2;
    
    // Pane size
    const paneW = (availW - totalGapX) / cols;
    const paneH = (availH - totalGapY) / rows;
    
    // Skip if panes would be too small
    if (paneW < 5 * scale || paneH < 5 * scale) return;
    
    // Mark original as deleted
    s.deleted = true;
    s.replacedByPanes = true;
    
    // Store original info for display
    const parentInfo = {
      parentId: s.id,
      parentX: s.x,
      parentY: s.y,
      parentOriginalWidth: w,
      parentOriginalHeight: h
    };
    
    // Create panes
    const startX = s.x - w/2 + edgeGapX + paneW/2;
    const startY = s.y - h/2 + edgeGapY + paneH/2;
    
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const paneX = startX + col * (paneW + gapX);
        const paneY = startY + row * (paneH + gapY);
        
        data.shapes.push({
          id: s.id + '-pane-' + row + '-' + col,
          type: 'pane',
          x: paneX,
          y: paneY,
          width: paneW,
          height: paneH,
          modifiedWidth: paneW,
          modifiedHeight: paneH,
          editType: 'windowPane',
          ...parentInfo
        });
        paneCount++;
      }
    }
    count++;
  });
  
  return { count, paneCount };
}

// ============================================================================
// INTERPRET COMMAND (Local) - IMPROVED
// ============================================================================
function interpretCommand(prompt, shapeStats = {}) {
  const l = prompt.toLowerCase().trim();
  const hasSelection = (shapeStats.selectedCount || 0) > 0;
  
  // Check for fiducial commands first
  if (l.includes('fid')) {
    // "change fids to 40mil round", "set fids 1mm circle", etc.
    const sizeMatch = l.match(/(\d+(?:\.\d+)?)\s*(mil|mm)/);
    const isRound = l.includes('round') || l.includes('circle');
    const isSquare = l.includes('square') || l.includes('rect');
    
    if (sizeMatch || isRound || isSquare) {
      return {
        action: 'modifyFids',
        fidSize: sizeMatch ? parseFloat(sizeMatch[1]) : 40,
        fidUnit: sizeMatch ? sizeMatch[2] : 'mil',
        fidShape: isSquare ? 'square' : 'circle',
        explanation: `Change fiducials to ${sizeMatch ? sizeMatch[1] + sizeMatch[2] : '40mil'} ${isSquare ? 'square' : 'round'}`
      };
    }
    
    // Just "fids" or "fiducials" = grab fiducials
    if (l === 'fids' || l === 'fid' || l === 'fiducials' || l.includes('grab fid') || l.includes('get fid')) {
      return { action: 'fiducials', explanation: 'Extract fiducials from paste layer' };
    }
  }
  
  const cmd = { value: 10, unit: '%' };
  
  // Check if user explicitly wants ALL (global)
  const wantsAll = l.includes('all ') || l.includes(' all') || l.startsWith('all');
  
  // If user has selection and didn't explicitly say "all", apply to selection
  if (hasSelection && !wantsAll) {
    cmd.selectedOnly = true;
    cmd.target = 'selected';
  } else {
    cmd.target = 'all';
  }
  
  // Override target if specific target mentioned
  if (l.includes('thermal') || l.includes('large pad')) { cmd.target = 'thermal'; cmd.selectedOnly = false; }
  else if (l.includes('fine') || l.includes('pitch') || l.includes('qfp') || l.includes('soic')) { cmd.target = 'finePitch'; cmd.selectedOnly = false; }
  else if (l.includes('circle') || l.includes('bga')) { cmd.target = 'circles'; cmd.selectedOnly = false; }
  else if (l.includes('rect') && !l.includes('correct')) { cmd.target = 'rectangles'; cmd.selectedOnly = false; }
  
  // Detect action
  if (l.includes('delete') || l.includes('remove')) {
    cmd.action = 'delete';
  } else if (l.includes('window') || l.includes('pane') || l.match(/(\d+)\s*x\s*(\d+)/)) {
    cmd.action = 'windowPane';
    const m = l.match(/(\d+)\s*x\s*(\d+)/);
    cmd.windowPane = { 
      rows: m ? parseInt(m[1]) : 2, 
      cols: m ? parseInt(m[2]) : 2, 
      webWidth: 0.4, 
      edgeGap: 0.15 
    };
  } else if (l.includes('radius') || (l.includes('corner') && !l.includes('home'))) {
    cmd.action = 'cornerRadius';
  } else if (l.includes('enlarge') || l.includes('increase') || l.includes('grow') || l.includes('expand') || l.includes('bigger')) {
    cmd.action = 'enlarge';
  } else if (l.includes('reset') || l.includes('undo') || l.includes('restore') || l.includes('revert')) {
    cmd.action = 'reset';
  } else {
    cmd.action = 'reduce';
  }
  
  // Extract value and unit
  const pct = l.match(/(\d+(?:\.\d+)?)\s*(%|percent)/);
  const mil = l.match(/(\d+(?:\.\d+)?)\s*mil/);
  const mm = l.match(/(\d+(?:\.\d+)?)\s*mm/);
  
  if (pct) { cmd.value = parseFloat(pct[1]); cmd.unit = '%'; }
  else if (mil) { cmd.value = parseFloat(mil[1]); cmd.unit = 'mil'; }
  else if (mm) { cmd.value = parseFloat(mm[1]); cmd.unit = 'mm'; }
  else { 
    const n = l.match(/(\d+(?:\.\d+)?)/); 
    if (n && cmd.action !== 'windowPane') cmd.value = parseFloat(n[1]); 
  }
  
  // Build explanation
  const targetDesc = cmd.selectedOnly ? 'selection' : cmd.target;
  if (cmd.action === 'windowPane') {
    cmd.explanation = `${cmd.windowPane.rows}x${cmd.windowPane.cols} window pane on ${targetDesc}`;
  } else if (cmd.action === 'reset') {
    cmd.explanation = `Reset ${targetDesc} to original`;
  } else if (cmd.action === 'delete') {
    cmd.explanation = `Delete ${targetDesc}`;
  } else {
    cmd.explanation = `${cmd.action} ${targetDesc} by ${cmd.value}${cmd.unit}`;
  }
  
  return cmd;
}

// ============================================================================
// EXPORT GERBER - Professional CAM-style output
// Based on analysis of VisualCAM output patterns
// ============================================================================
function exportGerber(data) {
  const lines = [
    'G04 Stentelligence v2.11 - Professional Stencil Export*',
    '%FSLAX36Y36*%',
    '%MOIN*%',
    '%LPD*%'
  ];
  
  const aptMap = new Map();
  const thermalMacros = [];
  const windowPaneRegions = [];
  let aptNum = 10;
  let macroNum = 100;
  
  // Constants for export - ALL IN INCHES since we export %MOIN*%
  const MIL = 0.001; // 1 mil in inches
  const FINE_PITCH_MIN_WIDTH = 9 * MIL;      // 9 mil minimum width for fine-pitch
  const FINE_PITCH_MAX_DIM = 15 * MIL;       // 15 mil threshold for fine-pitch detection
  const THERMAL_AREA_THRESHOLD = 10000 * MIL * MIL; // 10,000 sq mil in sq inches
  const THERMAL_DIM_THRESHOLD = 100 * MIL;   // 100 mil in inches
  
  // Detect if data is in mm or inches
  const sampleW = data.shapes?.[0]?.width || data.shapes?.[0]?.modifiedWidth || 0.01;
  const dataInMM = data.units === 'mm' || (sampleW > 0.5); // If width > 0.5, probably mm
  const toInches = dataInMM ? (v => v / 25.4) : (v => v);
  
  const validShapes = data.shapes.filter(s => !s.deleted);
  
  validShapes.forEach(s => {
    if (s.replacedByPanes) return; // Skip shapes replaced by window panes
    
    const tool = data.tools?.[s.tool];
    const origType = tool?.type || 'rect';
    
    // Get dimensions and convert to inches if needed
    const rawW = s.modifiedWidth || s.width || tool?.width || 0.01;
    const rawH = s.modifiedHeight || s.height || tool?.height || rawW;
    const w = toInches(rawW);
    const h = toInches(rawH);
    
    const area = w * h;
    const aspect = Math.max(w, h) / Math.min(w, h);
    const minDim = Math.min(w, h);
    const maxDim = Math.max(w, h);
    
    // Determine aperture type based on learned rules
    let aptType = 'R'; // Default rectangle
    let finalW = w;
    let finalH = h;
    
    if (s.type === 'pane') {
      // Window pane - will be output as region
      // Convert coordinates to inches
      const paneX = toInches(s.x);
      const paneY = toInches(s.y);
      const paneW = toInches(s.modifiedWidth || s.width || 0.01);
      const paneH = toInches(s.modifiedHeight || s.height || paneW);
      windowPaneRegions.push({
        x: paneX,
        y: paneY,
        w: paneW,
        h: paneH,
        parentId: s.parentId
      });
      return;
    }
    
    // For stencils: ONLY fiducials should be circles
    // Everything else: rectangles (or oblongs for fine pitch)
    // Circles have poor paste release - convert to squares
    if (s.isFiducial) {
      // Fiducials are always circles
      aptType = 'C';
      finalW = finalH = Math.max(w, h);
    } else if (s.convertToOblong || (aspect >= 2.0 && minDim < FINE_PITCH_MAX_DIM)) {
      // Fine-pitch: convert to oblong with minimum 9 mil width
      aptType = 'O';
      if (w < h) {
        finalW = Math.max(FINE_PITCH_MIN_WIDTH, w);
        finalH = h;
      } else {
        finalW = w;
        finalH = Math.max(FINE_PITCH_MIN_WIDTH, h);
      }
    } else if (area > THERMAL_AREA_THRESHOLD || maxDim > THERMAL_DIM_THRESHOLD) {
      // Large thermal pad - could use thermal macro or remain rectangle
      // For now, keep as rectangle but mark for potential thermal treatment
      aptType = 'R';
    }
    
    // Build aperture key
    const key = `${aptType}-${finalW.toFixed(6)}-${finalH.toFixed(6)}`;
    
    if (!aptMap.has(key)) {
      aptMap.set(key, { 
        code: 'D' + aptNum++, 
        type: aptType, 
        w: finalW, 
        h: finalH 
      });
    }
    
    s._apt = aptMap.get(key).code;
    s._finalW = finalW;
    s._finalH = finalH;
  });
  
  // Output aperture definitions
  aptMap.forEach((v, key) => {
    const dNum = v.code.slice(1);
    if (v.type === 'C') {
      lines.push(`%ADD${dNum}C,${v.w.toFixed(6)}*%`);
    } else if (v.type === 'O') {
      lines.push(`%ADD${dNum}O,${v.w.toFixed(6)}X${v.h.toFixed(6)}*%`);
    } else {
      lines.push(`%ADD${dNum}R,${v.w.toFixed(6)}X${v.h.toFixed(6)}*%`);
    }
  });
  
  // Output flash commands for regular pads
  let lastApt = null;
  validShapes.filter(s => s._apt && !s.replacedByPanes && s.type !== 'pane').forEach(s => {
    if (s._apt !== lastApt) {
      lines.push(s._apt + '*');
      lastApt = s._apt;
    }
    // Convert coordinates to inches then to integer format (6 decimal places)
    const xInches = toInches(s.x);
    const yInches = toInches(s.y);
    const x = Math.round(xInches * 1000000);
    const y = Math.round(yInches * 1000000);
    lines.push(`X${x}Y${y}D03*`);
  });
  
  // Output window pane regions (G36/G37)
  if (windowPaneRegions.length > 0) {
    // Group panes by parent
    const panesByParent = {};
    windowPaneRegions.forEach(p => {
      if (!panesByParent[p.parentId]) panesByParent[p.parentId] = [];
      panesByParent[p.parentId].push(p);
    });
    
    // Output each pane as a region
    windowPaneRegions.forEach(pane => {
      const hw = pane.w / 2;
      const hh = pane.h / 2;
      const x1 = Math.round((pane.x - hw) * 1000000);
      const y1 = Math.round((pane.y - hh) * 1000000);
      const x2 = Math.round((pane.x + hw) * 1000000);
      const y2 = Math.round((pane.y + hh) * 1000000);
      
      lines.push('G36*');
      lines.push(`X${x1}Y${y1}D02*`);
      lines.push('G01*');
      lines.push(`X${x2}Y${y1}D01*`);
      lines.push(`X${x2}Y${y2}D01*`);
      lines.push(`X${x1}Y${y2}D01*`);
      lines.push(`X${x1}Y${y1}D01*`);
      lines.push('G37*');
    });
  }
  
  lines.push('M02*');
  return lines.join('\n');
}

// ============================================================================
// MACHINE FORMAT EXPORT (.1 cut, .5 engrave)
// Format: Modified Gerber for Stentech laser machine
// ============================================================================
function exportMachineFormat(data, jobName, type) {
  const lines = [];
  const ext = type === 'engrave' ? '.5' : '.1';
  
  // Header
  lines.push('*');
  lines.push('%LPD*%');
  lines.push(`%LN${jobName}${ext}*%`);
  lines.push('%FSLAX33Y33*%');  // 3.3 format (mm with 3 decimal places)
  lines.push('%MOMM*%');         // Millimeters
  lines.push('%AD*%');           // Empty aperture placeholders
  lines.push('%AD*%');
  
  // Detect if data is in inches and needs conversion to mm
  const sampleW = data.shapes?.[0]?.width || data.shapes?.[0]?.modifiedWidth || 0.01;
  const dataInInches = data.units === 'in' || (sampleW > 0 && sampleW < 1);
  const toMM = dataInInches ? (v => v * 25.4) : (v => v);
  
  // Build aperture map
  const aptMap = new Map();
  let aptNum = 10;
  
  const validShapes = data.shapes.filter(s => !s.deleted && !s.replacedByPanes);
  
  validShapes.forEach(s => {
    if (s.type === 'pane') return; // Window panes handled separately
    
    const tool = data.tools?.[s.tool];
    const rawW = s.modifiedWidth || s.width || tool?.width || 0.01;
    const rawH = s.modifiedHeight || s.height || tool?.height || rawW;
    const w = toMM(rawW);
    const h = toMM(rawH);
    
    // Determine aperture type
    let aptType, finalW, finalH;
    
    if (s.isFiducial || (type === 'engrave' && tool?.type === 'circle')) {
      // Fiducials/engrave marks are circles
      aptType = 'C';
      finalW = finalH = Math.max(w, h);
    } else {
      // Everything else is rectangle
      aptType = 'R';
      finalW = w;
      finalH = h;
    }
    
    // Build aperture key (round to 5 decimal places for matching)
    const key = `${aptType}-${finalW.toFixed(5)}-${finalH.toFixed(5)}`;
    
    if (!aptMap.has(key)) {
      aptMap.set(key, { 
        code: 'D' + aptNum++, 
        type: aptType, 
        w: finalW, 
        h: finalH 
      });
    }
    
    s._machineApt = aptMap.get(key).code;
    s._machineX = toMM(s.x);
    s._machineY = toMM(s.y);
  });
  
  // Handle window panes - each becomes a rectangle
  const panes = data.shapes.filter(s => s.type === 'pane' && !s.deleted);
  panes.forEach(s => {
    const rawW = s.modifiedWidth || s.width || 0.01;
    const rawH = s.modifiedHeight || s.height || rawW;
    const w = toMM(rawW);
    const h = toMM(rawH);
    
    const key = `R-${w.toFixed(5)}-${h.toFixed(5)}`;
    
    if (!aptMap.has(key)) {
      aptMap.set(key, { 
        code: 'D' + aptNum++, 
        type: 'R', 
        w: w, 
        h: h 
      });
    }
    
    s._machineApt = aptMap.get(key).code;
    s._machineX = toMM(s.x);
    s._machineY = toMM(s.y);
  });
  
  // Output aperture definitions
  aptMap.forEach((v, key) => {
    const dNum = v.code.slice(1);
    if (v.type === 'C') {
      lines.push(`%ADD${dNum}C,${v.w.toFixed(5)}*%`);
    } else {
      lines.push(`%ADD${dNum}R,${v.w.toFixed(5)}X${v.h.toFixed(5)}*%`);
    }
  });
  
  // Step & Repeat (1x1 for single panel)
  lines.push('%SRX1Y1I0.0J0.0*%');
  
  // Output flash commands - group by aperture for efficiency
  const allShapes = [...validShapes.filter(s => s._machineApt), ...panes.filter(s => s._machineApt)];
  
  // Sort by aperture code for grouping
  allShapes.sort((a, b) => {
    const aNum = parseInt(a._machineApt.slice(1));
    const bNum = parseInt(b._machineApt.slice(1));
    return aNum - bNum;
  });
  
  let lastApt = null;
  allShapes.forEach(s => {
    if (s._machineApt !== lastApt) {
      lines.push(`G54${s._machineApt}*`);
      lastApt = s._machineApt;
    }
    // Format: 3.3 means multiply by 1000 for integer representation
    const x = Math.round(s._machineX * 1000);
    const y = Math.round(s._machineY * 1000);
    lines.push(`G1X${x}Y${y}D3*`);
  });
  
  lines.push('M2*');
  return lines.join('\n');
}

// ============================================================================
// HTTP SERVER
// ============================================================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const url = req.url.split('?')[0];
      
      if (url === '/parse' && req.method === 'POST') {
        const { gerber } = JSON.parse(body);
        const data = await parseGerber(gerber);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else if (url === '/modify' && req.method === 'POST') {
        const { data, command } = JSON.parse(body);
        const count = applyModification(data, command);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, modifiedCount: count }));
      } else if (url === '/instant-edit' && req.method === 'POST') {
        const { data } = JSON.parse(body);
        console.log('INSTANT-EDIT received:');
        console.log('  shapes:', data.shapes?.length);
        console.log('  tools:', Object.keys(data.tools || {}).length);
        
        // Analyze shapes before processing
        let withWidth = 0, withoutWidth = 0, alreadyModified = 0, deleted = 0, panes = 0;
        data.shapes?.forEach(s => {
          if (s.deleted) deleted++;
          else if (s.type === 'pane') panes++;
          else if (s.modified) alreadyModified++;
          else if (s.width > 0) withWidth++;
          else withoutWidth++;
        });
        console.log('  pre-analysis: withWidth=', withWidth, 'withoutWidth=', withoutWidth, 'modified=', alreadyModified, 'deleted=', deleted, 'panes=', panes);
        
        if (data.shapes?.length > 0) {
          const s = data.shapes[0];
          console.log('  first shape:', s.id, 'w=', s.width, 'h=', s.height, 'tool=', s.tool, 'modified=', s.modified);
          console.log('  first tool:', data.tools?.[s.tool]);
        }
        const { log, counts } = applyStentechInstant(data);
        console.log('  result counts:', counts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, log }));
      } else if (url === '/fiducials' && req.method === 'POST') {
        const { data } = JSON.parse(body);
        const fiducials = data.shapes.filter(s => !s.deleted && data.tools[s.tool]?.type === 'circle' && s.width * 25.4 >= 0.8 && s.width * 25.4 <= 3.0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, fiducials, count: fiducials.length }));
      } else if (url === '/export' && req.method === 'POST') {
        const { data } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(exportGerber(data));
      } else if (url === '/export-machine' && req.method === 'POST') {
        // Machine-specific export (.1 cut, .5 engrave)
        const { data, jobName, type } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(exportMachineFormat(data, jobName, type));
      } else if (url === '/dfm-analyze' && req.method === 'POST') {
        // DFM Analysis endpoint
        const { shapes, tools, datasheet } = JSON.parse(body);
        const analysis = analyzeDFM(shapes, tools, datasheet);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(analysis));
      } else if (url === '/parse-datasheet' && req.method === 'POST') {
        // Parse component datasheet
        const { content, filename } = JSON.parse(body);
        const parsed = parseDatasheet(content, filename);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed));
      } else if (url === '/apply-shape' && req.method === 'POST') {
        // Apply predefined shape to selected pads
        const { data, shape, selectedOnly } = JSON.parse(body);
        const count = applyPredefinedShape(data, shape, selectedOnly);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, count }));
      } else if (url === '/apply-size' && req.method === 'POST') {
        // Apply size modification
        const { data, size, selectedOnly } = JSON.parse(body);
        const count = applySizeModification(data, size, selectedOnly);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, count }));
      } else if (url === '/apply-chop' && req.method === 'POST') {
        // Apply chop up (window panes) with custom parameters
        const { data, chop, selectedOnly } = JSON.parse(body);
        const result = applyChopUp(data, chop, selectedOnly);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, ...result }));
      } else if (url === '/defaults' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(STENTECH));
      } else if (url === '/interpret' && req.method === 'POST') {
        const { prompt, shapeStats } = JSON.parse(body);
        
        // Try AI first if available
        if (anthropic) {
          try {
            const aiCommand = await interpretWithAI(prompt, shapeStats || {});
            if (aiCommand) {
              console.log('🤖 AI:', prompt, '->', aiCommand.explanation);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, command: aiCommand, source: 'ai' }));
              return;
            }
          } catch (e) {
            console.log('AI failed, falling back to local:', e.message);
          }
        }
        
        // Fallback to local interpretation
        const command = interpretCommand(prompt, shapeStats || {});
        console.log('📝 Local:', prompt, '->', command.explanation);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, command, source: 'local' }));
      } else {
        res.writeHead(404); res.end('Not found');
      }
    } catch (err) {
      console.error('Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

// ============================================================================
// AI INTERPRETATION (Claude) - SIMPLE & EFFECTIVE
// ============================================================================
async function interpretWithAI(prompt, shapeStats) {
  if (!anthropic) return null;
  
  const systemPrompt = `You are a stencil editing assistant for SMT (Surface Mount Technology) manufacturing. 
You interpret natural language commands and convert them to structured JSON commands.

Available actions:
- reduce: Reduce pad size by percentage or absolute amount
- enlarge: Increase pad size by percentage or absolute  
- windowPane: Split large pads into grid of smaller openings
- cornerRadius: Add rounded corners to pads
- delete: Remove pads
- modifyFids: Change fiducial size/shape
- reset: Restore original size

Available targets:
- all: All pads
- selected: Only selected pads (use when selectedOnly is true)
- thermal: Large thermal pads (area > threshold)
- finePitch: Fine pitch leads (high aspect ratio, narrow)
- circles: Round pads only
- rectangles: Rectangular pads only

Units: %, mm, mil (thousandths of inch)

IMPORTANT: 
- If selectedCount > 0 and user doesn't say "all", set selectedOnly: true
- selectedCount in current state: ${shapeStats.selectedCount || 0}

Respond ONLY with valid JSON matching this schema:
{
  "action": "reduce|enlarge|windowPane|cornerRadius|delete|modifyFids|reset",
  "target": "all|selected|thermal|finePitch|circles|rectangles",
  "value": <number>,
  "unit": "%|mm|mil",
  "selectedOnly": <boolean>,
  "windowPane": { "rows": <int>, "cols": <int>, "webWidth": 0.4, "edgeGap": 0.15 },
  "fidSize": <number for modifyFids>,
  "fidUnit": "mil|mm",
  "fidShape": "circle|square",
  "explanation": "<brief explanation>"
}

Examples:
"reduce all pads by 10%" -> {"action":"reduce","target":"all","value":10,"unit":"%","selectedOnly":false,"explanation":"Reduce all pads by 10%"}
"3x3 window pane" with selection -> {"action":"windowPane","target":"selected","windowPane":{"rows":3,"cols":3,"webWidth":0.4,"edgeGap":0.15},"selectedOnly":true,"explanation":"Add 3x3 window panes to selected pads"}
"shrink fine pitch leads by 2mil" -> {"action":"reduce","target":"finePitch","value":2,"unit":"mil","selectedOnly":false,"explanation":"Reduce fine pitch pads by 2mil"}
"change fids to 40mil round" -> {"action":"modifyFids","fidSize":40,"fidUnit":"mil","fidShape":"circle","explanation":"Change fiducials to 40mil circles"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
      system: systemPrompt
    });
    
    const text = response.content[0]?.text?.trim();
    if (!text) return null;
    
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('No JSON found in AI response:', text);
      return null;
    }
    
    const cmd = JSON.parse(jsonMatch[0]);
    
    // Ensure explanation exists
    if (!cmd.explanation) {
      cmd.explanation = `${cmd.action} on ${cmd.selectedOnly ? 'selection' : cmd.target}`;
    }
    
    return cmd;
  } catch (err) {
    console.error('AI interpretation error:', err.message);
    return null;
  }
}

server.listen(process.env.PORT || 3001, () => console.log(`
╔═══════════════════════════════════════════════════════════╗
║     STENTELLIGENCE v2.12 - Professional CAM Rules         ║
╚═══════════════════════════════════════════════════════════╝
Server: http://localhost:${process.env.PORT || 3001}
AI: ${anthropic ? 'ENABLED ✓' : 'DISABLED (set ANTHROPIC_API_KEY in .env)'}

Stentech Instant Edit applies:
  • Fine-pitch → oblong, -1mil/side, 9mil min
  • Standard pads → -1mil/side + corner radius
  • Thermal pads → -2mil/side + corner radius
  • Large thermal → window panes (2x2 or 2x3)
  • Very small (<8mil) → no change
`));
