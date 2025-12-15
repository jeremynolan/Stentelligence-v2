/**
 * STENTELLIGENCE PARSING SERVICE v2.3
 * With AI interpretation via Claude API
 */

require('dotenv').config();

const http = require('http');
const gerberParser = require('gerber-parser');
const gerberPlotter = require('gerber-plotter');

// Thresholds in INCHES (gerber standard)
const STENTECH = {
  thermal: { 
    areaThresholdIn: 0.01,  // ~6.5 mm² - pads larger than this get windowed
    webWidthIn: 0.016,      // ~0.4mm
    edgeGapIn: 0.006        // ~0.15mm
  },
  finePitch: { 
    aspectRatio: 2.5, 
    maxWidthIn: 0.020       // ~0.5mm
  },
  bga: { cornerRadiusIn: 0.002 }  // ~0.05mm
};

// ============================================================================
// GERBER PARSER
// ============================================================================
function parseGerber(gerberContent) {
  return new Promise((resolve, reject) => {
    try {
      const parser = gerberParser();
      const plotter = gerberPlotter();
      
      const result = { tools: {}, shapes: [], bounds: null, units: 'in' };
      let shapeId = 0;
      
      plotter.on('data', (obj) => {
        try {
          if (obj.type === 'shape') {
            const toolId = obj.tool;
            const shapeData = obj.shape && obj.shape[0];
            if (shapeData) {
              result.tools[toolId] = {
                type: shapeData.type || 'rect',
                width: shapeData.type === 'circle' ? (shapeData.r || 0.01) * 2 : (shapeData.width || 0.01),
                height: shapeData.type === 'circle' ? (shapeData.r || 0.01) * 2 : (shapeData.height || shapeData.width || 0.01)
              };
            }
          } else if (obj.type === 'pad') {
            const tool = result.tools[obj.tool] || { type: 'rect', width: 0.01, height: 0.01 };
            result.shapes.push({
              id: 'pad-' + (shapeId++),
              type: 'pad',
              tool: obj.tool,
              x: obj.x || 0,
              y: obj.y || 0,
              width: tool.width,
              height: tool.height
            });
          } else if (obj.type === 'fill' && obj.path) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            const allPoints = [];
            
            // Extract all points from path segments in order
            obj.path.forEach(seg => {
              if (seg.start) { 
                allPoints.push({ x: seg.start[0], y: seg.start[1] });
                minX = Math.min(minX, seg.start[0]); maxX = Math.max(maxX, seg.start[0]); 
                minY = Math.min(minY, seg.start[1]); maxY = Math.max(maxY, seg.start[1]); 
              }
            });
            
            // For complex shapes with many points, simplify to just the ordered path
            // Remove consecutive duplicates
            const points = [];
            for (let i = 0; i < allPoints.length; i++) {
              const p = allPoints[i];
              const prev = points[points.length - 1];
              if (!prev || Math.abs(p.x - prev.x) > 0.0001 || Math.abs(p.y - prev.y) > 0.0001) {
                points.push(p);
              }
            }
            
            if (points.length >= 3 && isFinite(minX)) {
              const w = maxX - minX;
              const h = maxY - minY;
              result.shapes.push({
                id: 'fill-' + (shapeId++),
                type: 'fill',
                x: (minX + maxX) / 2,
                y: (minY + maxY) / 2,
                width: w,
                height: h,
                points
              });
            }
          } else if (obj.type === 'stroke' && obj.start && obj.end) {
            result.shapes.push({
              id: 'stroke-' + (shapeId++),
              type: 'stroke',
              tool: obj.tool,
              x1: obj.start[0], y1: obj.start[1],
              x2: obj.end[0], y2: obj.end[1],
              x: (obj.start[0] + obj.end[0]) / 2,
              y: (obj.start[1] + obj.end[1]) / 2
            });
          } else if (obj.type === 'size' && obj.box) {
            result.bounds = { minX: obj.box[0], minY: obj.box[1], maxX: obj.box[2], maxY: obj.box[3] };
          }
        } catch (e) {
          console.error('Error processing object:', e.message);
        }
      });
      
      plotter.on('warning', () => {});
      plotter.on('error', (err) => console.error('Plotter error:', err.message));
      parser.on('error', (err) => console.error('Parser error:', err.message));
      
      plotter.once('end', () => {
        if (!result.bounds && result.shapes.length > 0) {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          result.shapes.forEach(s => {
            if (s.x !== undefined) {
              const hw = (s.width || 0.01) / 2;
              const hh = (s.height || 0.01) / 2;
              minX = Math.min(minX, s.x - hw);
              maxX = Math.max(maxX, s.x + hw);
              minY = Math.min(minY, s.y - hh);
              maxY = Math.max(maxY, s.y + hh);
            }
          });
          if (isFinite(minX)) result.bounds = { minX, minY, maxX, maxY };
        }
        if (!result.bounds) result.bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
        console.log('Parsed:', result.shapes.length, 'shapes,', Object.keys(result.tools).length, 'tools');
        resolve(result);
      });
      
      parser.pipe(plotter);
      parser.write(gerberContent);
      parser.end();
    } catch (err) {
      console.error('Parse setup error:', err.message);
      reject(err);
    }
  });
}

// ============================================================================
// WINDOW PANE GENERATOR - works in any units
// ============================================================================
function generateWindowPanes(cx, cy, width, height, rows, cols, webWidth, edgeGap) {
  console.log('generateWindowPanes:', { cx, cy, width, height, rows, cols, webWidth, edgeGap });
  
  const panes = [];
  const innerW = width - 2 * edgeGap;
  const innerH = height - 2 * edgeGap;
  const paneW = (innerW - (cols - 1) * webWidth) / cols;
  const paneH = (innerH - (rows - 1) * webWidth) / rows;
  
  console.log('Pane dimensions:', { innerW, innerH, paneW, paneH });
  
  // Minimum pane size is 1% of original size
  const minSize = Math.min(width, height) * 0.01;
  if (paneW <= minSize || paneH <= minSize) {
    console.log('Panes too small, skipping');
    return [];
  }
  
  const startX = cx - innerW / 2 + paneW / 2;
  const startY = cy - innerH / 2 + paneH / 2;
  
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      panes.push({
        x: startX + c * (paneW + webWidth),
        y: startY + r * (paneH + webWidth),
        width: paneW,
        height: paneH
      });
    }
  }
  console.log('Generated', panes.length, 'panes');
  return panes;
}

// ============================================================================
// MODIFICATION ENGINE
// ============================================================================
function applyModification(data, cmd) {
  const { action, target, value, unit, selectedOnly, windowPane } = cmd;
  const newShapes = [];
  let modCount = 0;
  
  console.log('applyModification:', { action, target, value, unit, selectedOnly, windowPane });
  
  data.shapes.forEach(shape => {
    if (shape.deleted) { newShapes.push(shape); return; }
    if (selectedOnly && !shape.selected) { newShapes.push(shape); return; }
    if (shape.type === 'pane') { newShapes.push(shape); return; }
    
    const tool = data.tools[shape.tool];
    const w = shape.modifiedWidth || shape.width || tool?.width || 0.01;
    const h = shape.modifiedHeight || shape.height || tool?.height || w;
    const area = w * h;
    const aspect = Math.max(w, h) / Math.min(w, h);
    const toolType = tool?.type || 'rect';
    
    // Target matching
    let match = target === 'all';
    if (target === 'circles') match = toolType === 'circle';
    if (target === 'rectangles') match = toolType === 'rect';
    if (target === 'thermal') match = area > STENTECH.thermal.areaThresholdIn;
    if (target === 'finePitch') match = aspect > STENTECH.finePitch.aspectRatio && Math.min(w, h) < STENTECH.finePitch.maxWidthIn;
    
    if (!match) { newShapes.push(shape); return; }
    
    const ns = { ...shape };
    if (!ns.originalWidth) { ns.originalWidth = w; ns.originalHeight = h; }
    
    switch (action) {
      case 'reduce':
      case 'scale': {
        let factor = action === 'reduce' ? (1 - value / 100) : (1 + value / 100);
        if (unit === 'mm') {
          const off = (value / 25.4) * (action === 'reduce' ? 1 : -1);
          ns.modifiedWidth = Math.max(0.001, w - off * 2);
          ns.modifiedHeight = Math.max(0.001, h - off * 2);
        } else if (unit === 'mil') {
          const off = (value / 1000) * (action === 'reduce' ? 1 : -1);
          ns.modifiedWidth = Math.max(0.001, w - off * 2);
          ns.modifiedHeight = Math.max(0.001, h - off * 2);
        } else {
          ns.modifiedWidth = w * factor;
          ns.modifiedHeight = h * factor;
        }
        ns.width = ns.modifiedWidth;
        ns.height = ns.modifiedHeight;
        ns.modified = true;
        ns.editType = 'reduce';
        modCount++;
        newShapes.push(ns);
        break;
      }
      
      case 'cornerRadius': {
        ns.cornerRadius = unit === 'mil' ? value / 1000 : (unit === 'mm' ? value / 25.4 : value);
        ns.modified = true;
        ns.editType = 'cornerRadius';
        modCount++;
        newShapes.push(ns);
        break;
      }
      
      case 'windowPane': {
        const wp = windowPane || { rows: 2, cols: 2, webWidth: 0.016, edgeGap: 0.006, reduction: 0 };
        let effW = w, effH = h;
        if (wp.reduction > 0) {
          const f = 1 - wp.reduction / 100;
          effW = w * f;
          effH = h * f;
        }
        
        // Scale web/edge proportionally to pad size
        const minDim = Math.min(effW, effH);
        let webW = minDim * 0.08;  // 8% of smallest dimension
        let edgeG = minDim * 0.03; // 3% of smallest dimension
        
        const panes = generateWindowPanes(shape.x, shape.y, effW, effH, wp.rows, wp.cols, webW, edgeG);
        
        if (panes.length === 0) { 
          console.log('No panes generated for shape', shape.id);
          newShapes.push(ns); 
          break; 
        }
        
        ns.deleted = true;
        ns.modified = true;
        ns.editType = 'windowPane';
        newShapes.push(ns);
        
        panes.forEach((p, i) => {
          newShapes.push({
            id: shape.id + '-pane-' + i,
            type: 'pane',
            x: p.x, y: p.y,
            width: p.width, height: p.height,
            parentId: shape.id,
            parentX: shape.x, parentY: shape.y,
            parentOriginalWidth: ns.originalWidth,
            parentOriginalHeight: ns.originalHeight,
            modified: true,
            editType: 'windowPane'
          });
        });
        modCount++;
        break;
      }
      
      case 'delete': {
        ns.deleted = true;
        modCount++;
        newShapes.push(ns);
        break;
      }
      
      default:
        newShapes.push(shape);
    }
  });
  
  data.shapes = newShapes;
  console.log('Modified', modCount, 'shapes, total now:', newShapes.length);
  return modCount;
}

// ============================================================================
// STENTECH INSTANT EDIT - Demo all edit types
// ============================================================================
function applyStentechInstant(data) {
  const log = [];
  console.log('\n=== STENTECH INSTANT EDIT ===');
  console.log('Input shapes:', data.shapes.length);
  
  // Analyze shapes first
  let minArea = Infinity, maxArea = 0, minDim = Infinity, maxDim = 0;
  data.shapes.forEach(s => {
    const tool = data.tools[s.tool];
    const w = s.width || tool?.width || 0.01;
    const h = s.height || tool?.height || w;
    const area = w * h;
    minArea = Math.min(minArea, area);
    maxArea = Math.max(maxArea, area);
    minDim = Math.min(minDim, w, h);
    maxDim = Math.max(maxDim, w, h);
  });
  console.log('Shape analysis:', { minArea, maxArea, minDim, maxDim });
  
  // Adaptive thresholds based on actual data
  const thermalThreshold = Math.max(maxArea * 0.3, STENTECH.thermal.areaThresholdIn);
  const finePitchMaxWidth = Math.max(minDim * 2, STENTECH.finePitch.maxWidthIn);
  console.log('Using thresholds:', { thermalThreshold, finePitchMaxWidth });
  
  // Clone shapes and store originals
  data.shapes = data.shapes.map(s => {
    const ns = { ...s };
    if (!ns.originalWidth) {
      const tool = data.tools[s.tool];
      ns.originalWidth = s.width || tool?.width || 0.01;
      ns.originalHeight = s.height || tool?.height || ns.originalWidth;
    }
    return ns;
  });
  
  // Categorize shapes
  const thermalPads = [];
  const finePitchPads = [];
  const squarePads = [];
  const standardPads = [];
  
  data.shapes.forEach(s => {
    if (s.deleted || s.type === 'pane' || s.type !== 'pad') return;
    const w = s.originalWidth, h = s.originalHeight;
    const area = w * h;
    const aspect = Math.max(w, h) / Math.min(w, h);
    
    if (area > thermalThreshold) {
      thermalPads.push(s);
    } else if (aspect > STENTECH.finePitch.aspectRatio && Math.min(w, h) < finePitchMaxWidth) {
      finePitchPads.push(s);
    } else if (aspect < 1.3) {
      squarePads.push(s);
    } else {
      standardPads.push(s);
    }
  });
  
  console.log('Categorized:', { thermal: thermalPads.length, finePitch: finePitchPads.length, square: squarePads.length, standard: standardPads.length });
  
  // 1. Standard 10% reduction
  standardPads.forEach(s => {
    s.modifiedWidth = s.originalWidth * 0.90;
    s.modifiedHeight = s.originalHeight * 0.90;
    s.width = s.modifiedWidth;
    s.height = s.modifiedHeight;
    s.modified = true;
    s.editType = 'reduce';
  });
  log.push('Standard 10% reduction: ' + standardPads.length + ' pads');
  
  // 2. Square pads - 10% reduction + corner radius
  squarePads.forEach(s => {
    s.modifiedWidth = s.originalWidth * 0.90;
    s.modifiedHeight = s.originalHeight * 0.90;
    s.width = s.modifiedWidth;
    s.height = s.modifiedHeight;
    s.cornerRadius = Math.min(s.originalWidth, s.originalHeight) * 0.12;
    s.modified = true;
    s.editType = 'cornerRadius';
  });
  log.push('Corner radius + reduction: ' + squarePads.length + ' square pads');
  
  // 3. Fine pitch leads - 10% overall + 15% width reduction
  finePitchPads.forEach(s => {
    let newW = s.originalWidth * 0.90;
    let newH = s.originalHeight * 0.90;
    if (s.originalWidth < s.originalHeight) {
      newW = newW * 0.85;
    } else {
      newH = newH * 0.85;
    }
    s.modifiedWidth = newW;
    s.modifiedHeight = newH;
    s.width = newW;
    s.height = newH;
    s.modified = true;
    s.editType = 'finePitch';
  });
  log.push('Fine pitch reduction: ' + finePitchPads.length + ' leads');
  
  // 4. Window panes on thermal pads
  thermalPads.forEach(pad => {
    const area = pad.originalWidth * pad.originalHeight;
    let rows = 2, cols = 2;
    if (area > thermalThreshold * 3) { rows = 3; cols = 3; }
    if (area > thermalThreshold * 6) { rows = 4; cols = 4; }
    
    // Calculate web width proportional to pad size
    const minDim = Math.min(pad.originalWidth, pad.originalHeight);
    const webWidth = minDim * 0.08;  // 8% of smallest dimension
    const edgeGap = minDim * 0.03;   // 3% of smallest dimension
    
    const panes = generateWindowPanes(
      pad.x, pad.y,
      pad.originalWidth * 0.92,  // 8% reduction
      pad.originalHeight * 0.92,
      rows, cols,
      webWidth,
      edgeGap
    );
    
    console.log('Thermal pad', pad.id, ':', rows + 'x' + cols, 'panes:', panes.length);
    
    if (panes.length > 0) {
      pad.deleted = true;
      pad.modified = true;
      pad.editType = 'windowPane';
      
      panes.forEach((p, i) => {
        data.shapes.push({
          id: pad.id + '-pane-' + i,
          type: 'pane',
          x: p.x, y: p.y,
          width: p.width, height: p.height,
          parentId: pad.id,
          parentX: pad.x, parentY: pad.y,
          parentOriginalWidth: pad.originalWidth,
          parentOriginalHeight: pad.originalHeight,
          modified: true,
          editType: 'windowPane'
        });
      });
    }
  });
  log.push('Window panes: ' + thermalPads.length + ' thermal pads');
  
  console.log('Final shape count:', data.shapes.length);
  console.log('=== INSTANT EDIT COMPLETE ===\n');
  
  return { log };
}

// ============================================================================
// FIDUCIAL EXTRACTION
// ============================================================================
function extractFiducials(data) {
  const fids = [];
  data.shapes = data.shapes.map(s => {
    if (s.selected && !s.deleted) {
      fids.push({ ...s, selected: false, isFiducial: true });
      return { ...s, deleted: true };
    }
    return s;
  });
  return { fiducials: fids, count: fids.length };
}

// ============================================================================
// AI COMMAND INTERPRETER - Calls Claude API
// ============================================================================
async function interpretCommand(prompt, shapeStats) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  
  if (!ANTHROPIC_API_KEY) {
    console.log('No API key, using local parser');
    return localParseCommand(prompt);
  }
  
  const systemPrompt = `You are a stencil editing assistant for SMT (Surface Mount Technology) manufacturing. 
You interpret natural language commands and convert them to structured JSON commands.

Available actions:
- reduce: Reduce pad size by percentage or absolute amount
- scale: Increase pad size by percentage  
- windowPane: Split large pads into grid of smaller openings
- cornerRadius: Add rounded corners to pads
- delete: Remove pads
- modifyFids: Change fiducial size and/or shape (use this for any command about fiducials/fids)

Available targets:
- all: All pads
- selected: Only selected pads
- thermal: Large thermal pads (area > threshold)
- finePitch: Fine pitch leads (high aspect ratio, narrow)
- circles: Round pads only
- rectangles: Rectangular pads only

Units: %, mm, mil (thousandths of inch)

Current board statistics:
${JSON.stringify(shapeStats, null, 2)}

Respond ONLY with valid JSON matching this schema:
{
  "action": "reduce|scale|windowPane|cornerRadius|delete|modifyFids",
  "target": "all|selected|thermal|finePitch|circles|rectangles",
  "value": <number>,
  "unit": "%|mm|mil",
  "selectedOnly": <boolean>,
  "windowPane": { "rows": <int>, "cols": <int>, "reduction": <number> },
  "fidSize": <number>,
  "fidUnit": "mil|mm|in",
  "fidShape": "circle|rect",
  "explanation": "<brief explanation of what this will do>"
}

Examples:
"reduce all pads by 10%" -> {"action":"reduce","target":"all","value":10,"unit":"%","explanation":"Reducing all pads by 10%"}
"add 2x2 window panes to thermal pads" -> {"action":"windowPane","target":"thermal","windowPane":{"rows":2,"cols":2,"reduction":0},"explanation":"Adding 2x2 window panes to thermal pads"}
"shrink fine pitch leads by 0.05mm" -> {"action":"reduce","target":"finePitch","value":0.05,"unit":"mm","explanation":"Reducing fine pitch leads by 0.05mm"}
"change fids to 40mil rounds" -> {"action":"modifyFids","fidSize":40,"fidUnit":"mil","fidShape":"circle","explanation":"Changing fiducials to 40mil round"}
"make fiducials 1mm squares" -> {"action":"modifyFids","fidSize":1,"fidUnit":"mm","fidShape":"rect","explanation":"Changing fiducials to 1mm square"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
        system: systemPrompt
      })
    });
    
    if (!response.ok) {
      const err = await response.text();
      console.error('API error:', err);
      return localParseCommand(prompt);
    }
    
    const result = await response.json();
    const text = result.content[0]?.text || '';
    console.log('AI response:', text);
    
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { success: true, command: parsed, source: 'ai' };
    }
    
    return localParseCommand(prompt);
  } catch (err) {
    console.error('AI interpretation error:', err.message);
    return localParseCommand(prompt);
  }
}

// Local fallback parser when no API key
function localParseCommand(prompt) {
  const l = prompt.toLowerCase().trim();
  const result = { success: true, source: 'local', command: {} };
  const cmd = result.command;
  
  // Check for fiducial modification first (before general fid check)
  if (l.includes('fid') && (l.includes('mil') || l.includes('mm') || l.includes('change') || l.includes('make') || l.includes('set'))) {
    cmd.action = 'modifyFids';
    
    // Extract size
    const milMatch = l.match(/(\d+(?:\.\d+)?)\s*mil/);
    const mmMatch = l.match(/(\d+(?:\.\d+)?)\s*mm/);
    
    if (milMatch) {
      cmd.fidSize = parseFloat(milMatch[1]);
      cmd.fidUnit = 'mil';
    } else if (mmMatch) {
      cmd.fidSize = parseFloat(mmMatch[1]);
      cmd.fidUnit = 'mm';
    } else {
      cmd.fidSize = 40;
      cmd.fidUnit = 'mil';
    }
    
    // Extract shape
    if (l.includes('round') || l.includes('circle')) {
      cmd.fidShape = 'circle';
    } else if (l.includes('square') || l.includes('rect')) {
      cmd.fidShape = 'rect';
    } else {
      cmd.fidShape = 'circle'; // Default to round
    }
    
    cmd.explanation = 'Changing fiducials to ' + cmd.fidSize + cmd.fidUnit + ' ' + (cmd.fidShape === 'circle' ? 'rounds' : 'squares');
    return result;
  }
  
  // Detect action
  if (l.includes('delete') || l.includes('remove')) {
    cmd.action = 'delete';
  } else if (l.includes('window') || l.includes('pane') || l.match(/\d+\s*x\s*\d+/)) {
    cmd.action = 'windowPane';
  } else if (l.includes('radius') || l.includes('corner')) {
    cmd.action = 'cornerRadius';
  } else if (l.includes('increase') || l.includes('grow') || l.includes('expand') || l.includes('scale up')) {
    cmd.action = 'scale';
  } else {
    cmd.action = 'reduce'; // Default
  }
  
  // Detect target
  if (l.includes('selected') || l.includes('selection')) {
    cmd.target = 'selected';
    cmd.selectedOnly = true;
  } else if (l.includes('thermal') || l.includes('large') || l.includes('big')) {
    cmd.target = 'thermal';
  } else if (l.includes('fine') || l.includes('pitch') || l.includes('lead') || l.includes('qfp') || l.includes('soic')) {
    cmd.target = 'finePitch';
  } else if (l.includes('circle') || l.includes('round pad')) {
    cmd.target = 'circles';
  } else if (l.includes('rect') || l.includes('square')) {
    cmd.target = 'rectangles';
  } else {
    cmd.target = 'all';
  }
  
  // Extract value
  const percentMatch = l.match(/(\d+(?:\.\d+)?)\s*%/);
  const mmMatch = l.match(/(\d+(?:\.\d+)?)\s*mm/);
  const milMatch = l.match(/(\d+(?:\.\d+)?)\s*mil/);
  
  if (percentMatch) {
    cmd.value = parseFloat(percentMatch[1]);
    cmd.unit = '%';
  } else if (mmMatch) {
    cmd.value = parseFloat(mmMatch[1]);
    cmd.unit = 'mm';
  } else if (milMatch) {
    cmd.value = parseFloat(milMatch[1]);
    cmd.unit = 'mil';
  } else {
    cmd.value = 10; // Default 10%
    cmd.unit = '%';
  }
  
  // Window pane specifics
  if (cmd.action === 'windowPane') {
    const gridMatch = l.match(/(\d+)\s*x\s*(\d+)/);
    cmd.windowPane = {
      rows: gridMatch ? parseInt(gridMatch[1]) : 2,
      cols: gridMatch ? parseInt(gridMatch[2]) : 2,
      reduction: cmd.value || 0
    };
  }
  
  // Corner radius specifics
  if (cmd.action === 'cornerRadius' && !mmMatch && !milMatch) {
    cmd.value = 0.1; // Default 0.1mm
    cmd.unit = 'mm';
  }
  
  cmd.explanation = `${cmd.action} on ${cmd.target} pads` + (cmd.value ? ` by ${cmd.value}${cmd.unit}` : '');
  
  return result;
}

// ============================================================================
// GERBER EXPORT
// ============================================================================
function exportGerber(data) {
  const lines = ['G04 Stentelligence Modified*', '%FSLAX36Y36*%', '%MOIN*%', '%LPD*%'];
  const aptMap = new Map();
  let aptNum = 10;
  
  const getApt = (type, w, h, cr) => {
    const key = type + '-' + w.toFixed(6) + '-' + h.toFixed(6) + '-' + (cr||0).toFixed(6);
    if (!aptMap.has(key)) {
      aptMap.set(key, { code: 'D' + aptNum++, type, w, h, cr });
    }
    return aptMap.get(key).code;
  };
  
  const shapeApts = [];
  data.shapes.filter(s => !s.deleted && (s.type === 'pad' || s.type === 'pane' || s.isFiducial)).forEach(s => {
    const tool = data.tools?.[s.tool];
    // Use shapeType for fiducials, otherwise fall back to tool type
    const type = s.shapeType || (s.type === 'pane' ? 'rect' : (tool?.type || 'rect'));
    const w = s.modifiedWidth || s.width || tool?.width || 0.01;
    const h = s.modifiedHeight || s.height || tool?.height || w;
    const cr = s.cornerRadius || 0;
    shapeApts.push({ shape: s, apt: getApt(type, w, h, cr) });
  });
  
  aptMap.forEach((v) => {
    if (v.type === 'circle') {
      lines.push('%ADD' + v.code.slice(1) + 'C,' + v.w.toFixed(6) + '*%');
    } else if (v.cr > 0) {
      lines.push('%ADD' + v.code.slice(1) + 'O,' + v.w.toFixed(6) + 'X' + v.h.toFixed(6) + '*%');
    } else {
      lines.push('%ADD' + v.code.slice(1) + 'R,' + v.w.toFixed(6) + 'X' + v.h.toFixed(6) + '*%');
    }
  });
  
  let lastApt = null;
  shapeApts.forEach(({ shape, apt }) => {
    if (apt !== lastApt) { lines.push(apt + '*'); lastApt = apt; }
    const x = Math.round(shape.x * 1000000);
    const y = Math.round(shape.y * 1000000);
    lines.push('X' + x + 'Y' + y + 'D03*');
  });
  
  lines.push('M02*');
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
      if (req.url === '/parse' && req.method === 'POST') {
        const { gerber } = JSON.parse(body);
        if (!gerber) throw new Error('No gerber content');
        console.log('\nParsing gerber, length:', gerber.length);
        const data = await parseGerber(gerber);
        console.log('Parse complete:', data.shapes.length, 'shapes');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }
      else if (req.url === '/modify' && req.method === 'POST') {
        const { data, command } = JSON.parse(body);
        console.log('\nModify request:', command);
        const count = applyModification(data, command);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, modifiedCount: count }));
      }
      else if (req.url === '/instant-edit' && req.method === 'POST') {
        const { data } = JSON.parse(body);
        const { log } = applyStentechInstant(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, log }));
      }
      else if (req.url === '/fiducials' && req.method === 'POST') {
        const { data } = JSON.parse(body);
        const result = extractFiducials(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, fiducials: result.fiducials, count: result.count }));
      }
      else if (req.url === '/export' && req.method === 'POST') {
        const { data } = JSON.parse(body);
        const gerber = exportGerber(data);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(gerber);
      }
      else if (req.url === '/defaults' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(STENTECH));
      }
      else if (req.url === '/interpret' && req.method === 'POST') {
        const { prompt, shapeStats } = JSON.parse(body);
        console.log('\nInterpreting:', prompt);
        const result = await interpretCommand(prompt, shapeStats || {});
        console.log('Interpreted as:', result);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
      else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (err) {
      console.error('Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(3001, () => console.log('Stentelligence server v2.2 running on http://localhost:3001'));
