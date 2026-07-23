// vessel_taper.jsx
// Illustrator ExtendScript: builds tapered, smoothly-branching vessel shapes
// from plain centerline paths, using Murray's Law to compute diameters at
// branch points, continuous arc-length taper along each segment, and a
// proper corner-fillet pass (like Illustrator's own Round Corners) to
// smooth the sharp notches where vessels meet.
//
// -----------------------------------------------------------------------
// HOW TO USE
// -----------------------------------------------------------------------
// 1. Draw centerline paths (simple open paths). A trunk can be ONE
//    continuous path - branches just need to touch it anywhere along its
//    length; the script finds mid-curve attachments and splits automatically.
//
// 2. Naming convention (double-click the path's row in the Layers panel):
//      - Leaf/terminal branch -> plain number, e.g. "6"  (diameter at its
//        free/dangling end)
//      - Root/trunk           -> starts with "root", e.g. "root40"
//      - Everything else -> leave unnamed, computed automatically.
//
//    Every dangling (truly free) endpoint in the selection must be tagged.
//    Exactly one root must be tagged.
//
// 3. Select ALL centerline paths belonging to one connected tree, then run
//    this script (File > Scripts > Other Script...).
//
// 4. The script tapers each vessel, unions them into one shape, then rounds
//    the sharp corners at branch junctions using a tangent-arc fillet (same
//    idea as Illustrator's Round Corners widget - drag-to-fillet on a single
//    corner). Original centerlines are hidden (not deleted).
//
// -----------------------------------------------------------------------
// LIMITATIONS
// -----------------------------------------------------------------------
// - Selection must form a single tree (no loops).
// - Corner rounding only fires where the direction change at a vertex
//   exceeds CORNER_ANGLE_THRESHOLD_DEG - this is meant to isolate the real
//   branch-crossing notches from the many small, nearly-straight vertices
//   that make up the sampled taper curve itself.
// - If FILLET_RADIUS is too large relative to a thin vessel or a tight
//   cluster of nearby corners, a given corner may be safely skipped (left
//   sharp) rather than risk broken geometry. Lower FILLET_RADIUS if you see
//   this happening a lot.
// - Murray's Law: r_parent^3 = sum(r_daughter^3) (Murray CD, PNAS 1926).
// -----------------------------------------------------------------------

(function () {

    // ---------------- CONFIG ----------------
    var SNAP_TOL = 1.5;                    // pt, tolerance for merging coincident endpoints
    var CURVE_TOL = 1.5;                    // pt, tolerance for "lands on the curve" detection
    var SAMPLES_PER_BEZIER = 14;            // sample density per anchor-to-anchor segment for tapering
    var ATTEMPT_PATHFINDER_UNITE = true;
    var MERGE_TOL = 0.75;                   // pt, collapses near-duplicate points left by Pathfinder's boolean op
    var DO_ROUND_CORNERS = true;
    var FILLET_RADIUS = 8;                  // pt, tangent-arc fillet radius at sharp junction corners
    var CORNER_ANGLE_THRESHOLD_DEG = 25;    // only round corners sharper (more deviation from straight) than this
    var DEFAULT_FILL = null;                // null => inherit source path's strokeColor if set; else RGBColor

    var DO_ADD_HIGHLIGHTS = true;
    var LIGHT_ANGLE_DEG = -45;              // direction light comes FROM; highlight favors this side, sliding smoothly as vessels curve
    var HIGHLIGHT_WIDTH_FACTOR = 0.30;      // highlight half-width, as a fraction of local vessel radius
    var HIGHLIGHT_OFFSET_FACTOR = 0.35;     // how far the highlight's centerline shifts toward the lit side (fraction of local radius)
    var HIGHLIGHT_LIGHTEN_AMOUNT = 0.6;     // 0 = same as base fill color, 1 = white
    var HIGHLIGHT_BLUR_RADIUS = 4;          // pt, Gaussian blur radius; 0 disables blur

    // ---------------- generic helpers ----------------

    function dist2D(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1];
        return Math.sqrt(dx * dx + dy * dy);
    }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpPt(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]; }
    function normalize2(v) {
        var len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
        if (len < 1e-9) return [0, 0];
        return [v[0] / len, v[1] / len];
    }
    function rot90(v, sign) { return sign > 0 ? [-v[1], v[0]] : [v[1], -v[0]]; }

    function keyFor(x, y) {
        var rx = Math.round(x / SNAP_TOL) * SNAP_TOL;
        var ry = Math.round(y / SNAP_TOL) * SNAP_TOL;
        return rx.toFixed(2) + "_" + ry.toFixed(2);
    }

    function parseTag(name) {
        if (!name) return null;
        var s = name.replace(/\s+/g, "").toLowerCase();
        if (s.indexOf("root") === 0) {
            var num = parseFloat(s.substring(4));
            if (!isNaN(num) && num > 0) return { isRoot: true, value: num };
            return null;
        }
        var n2 = parseFloat(s);
        if (!isNaN(n2) && n2 > 0) return { isRoot: false, value: n2 };
        return null;
    }

    function bezierPoint(p0, p1, p2, p3, t) {
        var mt = 1 - t;
        var x = mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0];
        var y = mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1];
        return [x, y];
    }
    function bezierTangent(p0, p1, p2, p3, t) {
        var mt = 1 - t;
        var x = 3 * mt * mt * (p1[0] - p0[0]) + 6 * mt * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
        var y = 3 * mt * mt * (p1[1] - p0[1]) + 6 * mt * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
        return [x, y];
    }

    function closestTOnBezierRange(p0, p1, p2, p3, target, loT, hiT, samples) {
        var bestT = loT, bestD = Infinity;
        for (var s = 0; s <= samples; s++) {
            var t = loT + (hiT - loT) * (s / samples);
            var pt = bezierPoint(p0, p1, p2, p3, t);
            var d = dist2D(pt, target);
            if (d < bestD) { bestD = d; bestT = t; }
        }
        return { t: bestT, d: bestD };
    }
    function closestOnBezier(p0, p1, p2, p3, target) {
        var coarse = closestTOnBezierRange(p0, p1, p2, p3, target, 0, 1, 60);
        var lo = Math.max(0, coarse.t - 1 / 60);
        var hi = Math.min(1, coarse.t + 1 / 60);
        return closestTOnBezierRange(p0, p1, p2, p3, target, lo, hi, 40);
    }

    function subdivideBezier(p0, p1, p2, p3, t) {
        var l1 = lerpPt(p0, p1, t);
        var m = lerpPt(p1, p2, t);
        var l2 = lerpPt(l1, m, t);
        var r1 = lerpPt(p2, p3, t);
        var r2 = lerpPt(m, r1, t);
        var s = lerpPt(l2, r2, t);
        return { left: { p0: p0, p1: l1, p2: l2, p3: s }, right: { p0: s, p1: r2, p2: r1, p3: p3 } };
    }

    function insertSplitPoint(arr, segIdx, t) {
        var A = arr[segIdx];
        var B = arr[segIdx + 1];
        var p0 = A.anchor, p1 = A.right, p2 = B.left, p3 = B.anchor;
        var sub = subdivideBezier(p0, p1, p2, p3, t);
        A.right = sub.left.p1;
        var mid = { anchor: sub.left.p3, left: sub.left.p2, right: sub.right.p1, pointType: PointType.SMOOTH };
        B.left = sub.right.p2;
        arr.splice(segIdx + 1, 0, mid);
        return mid.anchor;
    }

    function pointStructsFromPath(path) {
        var pts = path.pathPoints;
        var arr = [];
        for (var i = 0; i < pts.length; i++) {
            arr.push({ anchor: pts[i].anchor, left: pts[i].leftDirection, right: pts[i].rightDirection, pointType: pts[i].pointType });
        }
        return arr;
    }

    function fillColorFor(path) {
        if (DEFAULT_FILL) return DEFAULT_FILL;
        try {
            if (path.stroked && path.strokeColor && path.strokeColor.typename === "RGBColor") return path.strokeColor;
        } catch (err) {}
        var c = new RGBColor();
        c.red = 150; c.green = 20; c.blue = 20;
        return c;
    }

    function getHandleLengthBase(theta) {
        return 4 / 3 * (1 - Math.cos(theta / 2)) / Math.sin(theta / 2);
    }

    function lightenColor(rgb, amount) {
        var c = new RGBColor();
        c.red = rgb.red + (255 - rgb.red) * amount;
        c.green = rgb.green + (255 - rgb.green) * amount;
        c.blue = rgb.blue + (255 - rgb.blue) * amount;
        return c;
    }

    // ---------------- corner-fillet detection (read-only) ----------------
    // Finds sharp corners in a closed polygon (array of [x,y]) and returns
    // the fillet geometry for each one that qualifies - does NOT modify the
    // polygon itself. Same tangent-arc math as Illustrator's Round Corners.
    function findCornerFillets(points, radius, angleThresholdRad) {
        var n = points.length;
        if (n < 5 || radius <= 0) return [];

        function cornerGeom(arr, i) {
            var len = arr.length;
            var prev = arr[(i - 1 + len) % len];
            var cur = arr[i];
            var next = arr[(i + 1) % len];
            var v1 = normalize2([prev[0] - cur[0], prev[1] - cur[1]]);
            var v2 = normalize2([next[0] - cur[0], next[1] - cur[1]]);
            var dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1]));
            var theta = Math.acos(dot);
            return { theta: theta, turn: Math.PI - theta };
        }

        var sharp = [];
        for (var i0 = 0; i0 < n; i0++) sharp.push(cornerGeom(points, i0).turn > angleThresholdRad);

        var startI = -1;
        for (var s = 0; s < n; s++) {
            if (!sharp[s] && !sharp[(s + 1) % n]) { startI = s; break; }
        }
        if (startI < 0) return [];

        var rp = [];
        for (var k = 0; k < n; k++) rp.push(points[(startI + k) % n]);

        function walkLinear(fromIdx, dir, L) {
            var acc = 0, cur = fromIdx;
            while (true) {
                var nxt = cur + dir;
                if (nxt < 0 || nxt >= rp.length) return null;
                var segLen = dist2D(rp[cur], rp[nxt]);
                if (acc + segLen >= L) {
                    var remain = L - acc;
                    var t = segLen === 0 ? 0 : remain / segLen;
                    return { point: lerpPt(rp[cur], rp[nxt], t), keepIdx: cur };
                }
                acc += segLen;
                cur = nxt;
            }
        }

        var candidates = [];
        for (var i1 = 0; i1 < n; i1++) {
            var geom = cornerGeom(rp, i1);
            if (geom.turn <= angleThresholdRad) continue;

            var theta = geom.theta;
            var L = radius / Math.tan(theta / 2);
            var back = walkLinear(i1, -1, L);
            var fwd = walkLinear(i1, 1, L);
            if (!back || !fwd) continue;

            var corner = rp[i1];
            var p1 = back.point, p2 = fwd.point;
            var d1 = dist2D(corner, p1), d2 = dist2D(corner, p2);
            if (d1 < 1e-6 || d2 < 1e-6) continue;

            var u1 = [(p1[0] - corner[0]) / d1, (p1[1] - corner[1]) / d1];
            var u2 = [(p2[0] - corner[0]) / d2, (p2[1] - corner[1]) / d2];
            var bis = normalize2([u1[0] + u2[0], u1[1] + u2[1]]);
            var D = radius / Math.sin(theta / 2);
            var arcCenter = [corner[0] + bis[0] * D, corner[1] + bis[1] * D];

            var rad1 = [p1[0] - arcCenter[0], p1[1] - arcCenter[1]];
            var rad2 = [p2[0] - arcCenter[0], p2[1] - arcCenter[1]];
            var cross = rad1[0] * rad2[1] - rad1[1] * rad2[0];
            var sign = cross >= 0 ? 1 : -1;

            var dotR = (rad1[0] * rad2[0] + rad1[1] * rad2[1]) / (radius * radius);
            var phi = Math.acos(Math.max(-1, Math.min(1, dotR)));
            var h = getHandleLengthBase(phi) * radius;

            var tan1 = normalize2(rot90(rad1, sign));
            var tan2 = normalize2(rot90(rad2, sign));

            var right1 = [p1[0] + tan1[0] * h, p1[1] + tan1[1] * h];
            var left2 = [p2[0] - tan2[0] * h, p2[1] - tan2[1] * h];

            candidates.push({
                cornerIdx: i1, backKeepIdx: back.keepIdx, fwdKeepIdx: fwd.keepIdx,
                corner: corner, p1: p1, right1: right1, p2: p2, left2: left2
            });
        }

        if (candidates.length === 0) return [];

        candidates.sort(function (a, b) { return a.cornerIdx - b.cornerIdx; });
        var accepted = [];
        var lastFwdKeep = -1;
        for (var c = 0; c < candidates.length; c++) {
            var cand = candidates[c];
            if (cand.backKeepIdx > lastFwdKeep) { accepted.push(cand); lastFwdKeep = cand.fwdKeepIdx; }
        }
        return accepted;
    }

    // Builds one small standalone filled "patch" shape per detected corner
    // (corner -> tangent point 1 -> arc -> tangent point 2 -> back to corner).
    // The base path itself is left completely untouched - patches sit on top,
    // so you can delete any that look wrong or merge them in yourself later.
    function buildCornerPatches(doc, path, radius, angleDeg) {
        var pts = path.pathPoints;
        var raw = [];
        for (var i = 0; i < pts.length; i++) raw.push(pts[i].anchor);

        var accepted = findCornerFillets(raw, radius, angleDeg * Math.PI / 180);
        var fc = path.fillColor;
        var count = 0;
        for (var a = 0; a < accepted.length; a++) {
            var A = accepted[a];
            var patch = doc.pathItems.add();
            var pt0 = patch.pathPoints.add();
            pt0.anchor = A.corner; pt0.leftDirection = A.corner; pt0.rightDirection = A.corner; pt0.pointType = PointType.CORNER;
            var pt1 = patch.pathPoints.add();
            pt1.anchor = A.p1; pt1.leftDirection = A.p1; pt1.rightDirection = A.right1; pt1.pointType = PointType.SMOOTH;
            var pt2 = patch.pathPoints.add();
            pt2.anchor = A.p2; pt2.leftDirection = A.left2; pt2.rightDirection = A.p2; pt2.pointType = PointType.SMOOTH;
            patch.closed = true;
            patch.filled = true;
            patch.stroked = false;
            patch.fillColor = fc;
            patch.name = "vessel_fillet_patch";
            count++;
        }
        return count;
    }

    // Collapses near-duplicate consecutive anchor points (a common artifact
    // of Pathfinder boolean ops - see the Metaball(Arc) script's own notes on
    // needing a "Merge Overlapped Anchors" cleanup pass after Unite).
    function cleanupNearDuplicates(doc, path, tol) {
        var pts = path.pathPoints;
        var raw = [];
        for (var i = 0; i < pts.length; i++) raw.push(pts[i].anchor);
        var n = raw.length;
        if (n < 4) return null;

        var cleaned = [];
        for (var i2 = 0; i2 < n; i2++) {
            if (cleaned.length === 0 || dist2D(cleaned[cleaned.length - 1], raw[i2]) > tol) cleaned.push(raw[i2]);
        }
        while (cleaned.length > 3 && dist2D(cleaned[0], cleaned[cleaned.length - 1]) <= tol) cleaned.pop();
        if (cleaned.length === n || cleaned.length < 4) return null;

        var fc = path.fillColor;
        var newPath = doc.pathItems.add();
        for (var j = 0; j < cleaned.length; j++) {
            var np = newPath.pathPoints.add();
            np.anchor = cleaned[j];
            np.leftDirection = cleaned[j];
            np.rightDirection = cleaned[j];
            np.pointType = PointType.CORNER;
        }
        newPath.closed = true;
        newPath.filled = true;
        newPath.stroked = false;
        newPath.fillColor = fc;
        path.remove();
        return newPath;
    }

    function unionShapes(doc, shapes, warnLabel) {
        if (shapes.length === 0) return [];
        if (shapes.length === 1) return shapes;

        doc.selection = null;
        for (var i = 0; i < shapes.length; i++) shapes[i].selected = true;

        var grp = doc.groupItems.add();
        for (var gi = shapes.length - 1; gi >= 0; gi--) shapes[gi].moveToBeginning(grp);
        doc.selection = null;
        grp.selected = true;

        var result = shapes;
        try {
            app.executeMenuCommand("Live Pathfinder Add");
            app.executeMenuCommand("expandStyle");

            var flat = [];
            function flatten(item) {
                if (item.typename === "PathItem") flat.push(item);
                else if (item.typename === "CompoundPathItem") {
                    for (var k = 0; k < item.pathItems.length; k++) flatten(item.pathItems[k]);
                } else if (item.typename === "GroupItem") {
                    for (var k2 = 0; k2 < item.pageItems.length; k2++) flatten(item.pageItems[k2]);
                }
            }
            for (var msi = 0; msi < doc.selection.length; msi++) flatten(doc.selection[msi]);
            result = flat;

            if (flat.length >= shapes.length) {
                alert("Warning: the " + warnLabel + " union may not have actually merged (still " + flat.length + " separate shape(s) from " + shapes.length + "). Check Pathfinder > Unite manually before trusting the result.");
            }
        } catch (err) {
            alert("Automatic Pathfinder Unite didn't run for " + warnLabel + " (menu command name may differ by version/locale). Shapes were left grouped - run Pathfinder > Unite manually.");
        }
        return result;
    }

    // ============================================================
    // gather selection
    // ============================================================

    var doc = app.activeDocument;
    var sel = doc.selection;
    if (!sel || sel.length === 0) {
        alert("Select the centerline paths first, then run the script.");
        return;
    }

    var srcPaths = [];
    for (var i = 0; i < sel.length; i++) {
        if (sel[i].typename === "PathItem" && !sel[i].closed) srcPaths.push(sel[i]);
    }
    if (srcPaths.length === 0) {
        alert("No open PathItems found in selection.");
        return;
    }

    // ============================================================
    // PHASE A: build working point-arrays + record original endpoints
    // ============================================================

    var working = [];
    for (var wp = 0; wp < srcPaths.length; wp++) {
        var arr = pointStructsFromPath(srcPaths[wp]);
        working.push({
            origPath: srcPaths[wp], name: srcPaths[wp].name, arr: arr,
            origFirst: arr[0].anchor, origLast: arr[arr.length - 1].anchor, splitCoords: []
        });
    }

    // ============================================================
    // PHASE B: detect mid-curve touches and insert real anchor points
    // ============================================================

    for (var p = 0; p < working.length; p++) {
        var P = working[p];
        for (var q = 0; q < working.length; q++) {
            if (q === p) continue;
            var Q = working[q];
            var candidates2 = [Q.origFirst, Q.origLast];

            for (var c = 0; c < 2; c++) {
                var target = candidates2[c];
                if (dist2D(target, P.origFirst) < SNAP_TOL) continue;
                if (dist2D(target, P.origLast) < SNAP_TOL) continue;

                var foundIdx = -1;
                for (var ai = 0; ai < P.arr.length; ai++) {
                    if (dist2D(P.arr[ai].anchor, target) < SNAP_TOL) { foundIdx = ai; break; }
                }
                if (foundIdx >= 0) { P.splitCoords.push(P.arr[foundIdx].anchor); continue; }

                var bestSeg = -1, bestT = 0, bestD = Infinity;
                for (var seg = 0; seg < P.arr.length - 1; seg++) {
                    var p0 = P.arr[seg].anchor, p1 = P.arr[seg].right;
                    var p2 = P.arr[seg + 1].left, p3 = P.arr[seg + 1].anchor;
                    var res = closestOnBezier(p0, p1, p2, p3, target);
                    if (res.d < bestD) { bestD = res.d; bestSeg = seg; bestT = res.t; }
                }
                if (bestD < CURVE_TOL && bestSeg >= 0) {
                    var splitCoord = insertSplitPoint(P.arr, bestSeg, bestT);
                    P.splitCoords.push(splitCoord);
                }
            }
        }
    }

    // ============================================================
    // PHASE C: which original ends are free
    // ============================================================

    function isOriginalFree(idx, whichFirst) {
        var target = whichFirst ? working[idx].origFirst : working[idx].origLast;
        for (var q2 = 0; q2 < working.length; q2++) {
            if (q2 === idx) continue;
            if (dist2D(target, working[q2].origFirst) < SNAP_TOL) return false;
            if (dist2D(target, working[q2].origLast) < SNAP_TOL) return false;
        }
        return true;
    }

    // ============================================================
    // PHASE D: slice into sub-segments, materialize as real PathItems
    // ============================================================

    var finalPaths = [];

    for (var pi = 0; pi < working.length; pi++) {
        var W = working[pi];
        var idxSet = {};
        for (var sc = 0; sc < W.splitCoords.length; sc++) {
            var coord = W.splitCoords[sc];
            for (var ai2 = 1; ai2 < W.arr.length - 1; ai2++) {
                if (dist2D(W.arr[ai2].anchor, coord) < SNAP_TOL) { idxSet[ai2] = true; break; }
            }
        }
        var splitIndices = [];
        for (var kk in idxSet) if (idxSet.hasOwnProperty(kk)) splitIndices.push(parseInt(kk, 10));
        splitIndices.sort(function (a, b) { return a - b; });

        var boundaries = [0].concat(splitIndices).concat([W.arr.length - 1]);
        var cleanBoundaries = [];
        for (var b = 0; b < boundaries.length; b++) {
            if (cleanBoundaries.length === 0 || cleanBoundaries[cleanBoundaries.length - 1] !== boundaries[b]) cleanBoundaries.push(boundaries[b]);
        }

        var nSegments = cleanBoundaries.length - 1;
        var tag = parseTag(W.name);
        var freeFirst = tag ? isOriginalFree(pi, true) : false;
        var freeLast = tag ? isOriginalFree(pi, false) : false;

        for (var seg2 = 0; seg2 < nSegments; seg2++) {
            var startIdx = cleanBoundaries[seg2];
            var endIdx = cleanBoundaries[seg2 + 1];
            var subPts = W.arr.slice(startIdx, endIdx + 1);

            var segName = "";
            if (nSegments === 1) segName = W.name;
            else if (tag) {
                if (freeFirst && startIdx === 0) segName = W.name;
                else if (freeLast && endIdx === W.arr.length - 1) segName = W.name;
            }

            var newPath = doc.pathItems.add();
            for (var ppi = 0; ppi < subPts.length; ppi++) {
                var newPt = newPath.pathPoints.add();
                newPt.anchor = subPts[ppi].anchor;
                newPt.leftDirection = subPts[ppi].left;
                newPt.rightDirection = subPts[ppi].right;
                newPt.pointType = subPts[ppi].pointType;
            }
            newPath.name = segName;
            newPath.filled = false;
            try {
                newPath.stroked = W.origPath.stroked;
                if (W.origPath.stroked) newPath.strokeColor = W.origPath.strokeColor;
            } catch (err) {}

            finalPaths.push(newPath);
        }
        try { W.origPath.hidden = true; } catch (err) {}
    }

    // ============================================================
    // PHASE E: build node graph
    // ============================================================

    var nodes = {};
    var nodeList = [];
    var edges = [];

    function getOrCreateNode(x, y) {
        var kf = keyFor(x, y);
        if (nodes[kf] !== undefined) return nodes[kf];
        var node = { key: kf, x: x, y: y, id: nodeList.length, edgeIds: [], radius: null, dist: null, tagged: false };
        nodes[kf] = node;
        nodeList.push(node);
        return node;
    }

    for (var fp = 0; fp < finalPaths.length; fp++) {
        var fpath = finalPaths[fp];
        var fpts = fpath.pathPoints;
        var fa0 = fpts[0].anchor, fa1 = fpts[fpts.length - 1].anchor;
        var nA = getOrCreateNode(fa0[0], fa0[1]);
        var nB = getOrCreateNode(fa1[0], fa1[1]);
        var ftag = parseTag(fpath.name);
        edges.push({ path: fpath, aIdx: nA.id, bIdx: nB.id, tag: ftag });
        nA.edgeIds.push(edges.length - 1);
        nB.edgeIds.push(edges.length - 1);
    }

    var rootNode = null;
    for (var e = 0; e < edges.length; e++) {
        var tg = edges[e].tag;
        if (!tg) continue;
        var an = nodeList[edges[e].aIdx], bn = nodeList[edges[e].bIdx];
        var freeNode = null;
        if (an.edgeIds.length === 1) freeNode = an; else if (bn.edgeIds.length === 1) freeNode = bn;
        if (!freeNode) { alert("A tagged path ('" + edges[e].path.name + "') has neither end free after splitting. Skipping that tag."); continue; }
        freeNode.radius = tg.value / 2;
        freeNode.tagged = true;
        if (tg.isRoot) { if (rootNode) alert("More than one root tag found - using the first."); else rootNode = freeNode; }
    }
    if (!rootNode) { alert("No root found. Name your trunk's free end starting with 'root', e.g. 'root40'."); return; }

    var missing = [];
    for (var n = 0; n < nodeList.length; n++) {
        var nd = nodeList[n];
        if (nd.edgeIds.length === 1 && !nd.tagged) {
            var offendingPath = edges[nd.edgeIds[0]].path;
            var pname = offendingPath.name ? "'" + offendingPath.name + "'" : "(unnamed)";
            missing.push("(" + nd.x.toFixed(1) + ", " + nd.y.toFixed(1) + ") - on path " + pname);
        }
    }
    if (missing.length > 0) { alert("These endpoints are dangling but untagged - name their path with a diameter:\n" + missing.join("\n") + "\n\nIf that path IS named, its OTHER end is probably not actually touching anything (missed the trunk within tolerance, or fully isolated) - check SNAP_TOL/CURVE_TOL or the drawing near that point."); return; }

    rootNode.dist = 0;
    var queue = [rootNode.id];
    var qi = 0;
    while (qi < queue.length) {
        var curId = queue[qi++];
        var cur = nodeList[curId];
        for (var ei = 0; ei < cur.edgeIds.length; ei++) {
            var edgeObj = edges[cur.edgeIds[ei]];
            var otherId = (edgeObj.aIdx === curId) ? edgeObj.bIdx : edgeObj.aIdx;
            var other = nodeList[otherId];
            if (other.dist === null) { other.dist = cur.dist + 1; queue.push(otherId); }
        }
    }
    var unreached = [];
    for (var n3 = 0; n3 < nodeList.length; n3++) if (nodeList[n3].dist === null) unreached.push(n3);
    if (unreached.length > 0) { alert("Warning: " + unreached.length + " node(s) not connected to the root."); return; }

    var order = nodeList.slice();
    order.sort(function (a, b) { return b.dist - a.dist; });
    for (var oi = 0; oi < order.length; oi++) {
        var node = order[oi];
        if (node.radius !== null) continue;
        var sumCubes = 0, countDownstream = 0;
        for (var ej = 0; ej < node.edgeIds.length; ej++) {
            var edgeObj2 = edges[node.edgeIds[ej]];
            var otherId2 = (edgeObj2.aIdx === node.id) ? edgeObj2.bIdx : edgeObj2.aIdx;
            var other2 = nodeList[otherId2];
            if (other2.dist === node.dist + 1) { sumCubes += Math.pow(other2.radius, 3); countDownstream++; }
        }
        if (countDownstream === 0) { alert("Could not compute radius for an internal node near (" + node.x.toFixed(1) + ", " + node.y.toFixed(1) + ")."); return; }
        node.radius = Math.pow(sumCubes, 1 / 3);
    }

    // ============================================================
    // PHASE F: build tapered vessel ribbons
    // ============================================================

    var newShapes = [];
    var highlightShapes = [];
    var highlightLayer = null;
    if (DO_ADD_HIGHLIGHTS) {
        var originalActiveLayer = doc.activeLayer;
        highlightLayer = doc.layers.add();
        highlightLayer.name = "Vessel Highlights";
        try { highlightLayer.move(doc, ElementPlacement.PLACEATBEGINNING); } catch (err) {}
        // layers.add() makes the new layer active - switch back so the vessel
        // ribbons built below don't end up on the highlight layer too, which
        // would defeat the whole point of keeping them separate.
        doc.activeLayer = originalActiveLayer;
    }
    var lightRad = LIGHT_ANGLE_DEG * Math.PI / 180;
    var lightVec = [Math.cos(lightRad), Math.sin(lightRad)];

    for (var pe = 0; pe < edges.length; pe++) {
        var edge = edges[pe];
        var srcPath = edge.path;
        var pts2 = srcPath.pathPoints;
        var rA = nodeList[edge.aIdx].radius;
        var rB = nodeList[edge.bIdx].radius;

        var samplePts = [], sampleTan = [];
        for (var seg = 0; seg < pts2.length - 1; seg++) {
            var p0 = pts2[seg].anchor, p1 = pts2[seg].rightDirection;
            var p2 = pts2[seg + 1].leftDirection, p3 = pts2[seg + 1].anchor;
            var steps = SAMPLES_PER_BEZIER;
            for (var s = (seg === 0 ? 0 : 1); s <= steps; s++) {
                var t = s / steps;
                samplePts.push(bezierPoint(p0, p1, p2, p3, t));
                sampleTan.push(bezierTangent(p0, p1, p2, p3, t));
            }
        }

        var cum = [0];
        for (var si = 1; si < samplePts.length; si++) cum.push(cum[si - 1] + dist2D(samplePts[si - 1], samplePts[si]));
        var totalLen = cum[cum.length - 1];
        if (totalLen === 0) continue;

        // fall back to a secant direction wherever the analytic tangent is
        // (near) zero - this happens at plain corner-type endpoints where a
        // handle has zero length, and otherwise collapses the ribbon to a
        // point there, producing a spike.
        for (var ti = 0; ti < sampleTan.length; ti++) {
            var tlenCheck = Math.sqrt(sampleTan[ti][0] * sampleTan[ti][0] + sampleTan[ti][1] * sampleTan[ti][1]);
            if (tlenCheck < 1e-6) {
                if (ti === 0 && samplePts.length > 1) {
                    sampleTan[ti] = [samplePts[1][0] - samplePts[0][0], samplePts[1][1] - samplePts[0][1]];
                } else if (ti === sampleTan.length - 1 && samplePts.length > 1) {
                    sampleTan[ti] = [samplePts[ti][0] - samplePts[ti - 1][0], samplePts[ti][1] - samplePts[ti - 1][1]];
                } else if (ti > 0 && ti < sampleTan.length - 1) {
                    sampleTan[ti] = [samplePts[ti + 1][0] - samplePts[ti - 1][0], samplePts[ti + 1][1] - samplePts[ti - 1][1]];
                }
            }
        }

        var leftRail = [], rightRail = [];
        for (var sj = 0; sj < samplePts.length; sj++) {
            var frac = cum[sj] / totalLen;
            var r = lerp(rA, rB, frac);
            var tan = sampleTan[sj];
            var tlen = Math.sqrt(tan[0] * tan[0] + tan[1] * tan[1]);
            var nx = tlen < 1e-6 ? 0 : -tan[1] / tlen;
            var ny = tlen < 1e-6 ? 0 : tan[0] / tlen;
            var px = samplePts[sj][0], py = samplePts[sj][1];
            leftRail.push([px - nx * r, py - ny * r]);
            rightRail.push([px + nx * r, py + ny * r]);
        }

        var outline = leftRail.concat(rightRail.slice().reverse());
        var newPath = doc.pathItems.add();
        newPath.setEntirePath(outline);
        newPath.closed = true;
        newPath.filled = true;
        newPath.stroked = false;
        newPath.fillColor = fillColorFor(srcPath);
        newShapes.push(newPath);

        if (DO_ADD_HIGHLIGHTS) {
            var hlLeft = [], hlRight = [];
            for (var sj2 = 0; sj2 < samplePts.length; sj2++) {
                var frac2 = cum[sj2] / totalLen;
                var r2v = lerp(rA, rB, frac2);
                var tan2 = sampleTan[sj2];
                var tlen2 = Math.sqrt(tan2[0] * tan2[0] + tan2[1] * tan2[1]);
                var nx2 = tlen2 < 1e-6 ? 0 : -tan2[1] / tlen2;
                var ny2 = tlen2 < 1e-6 ? 0 : tan2[0] / tlen2;
                var lit = nx2 * lightVec[0] + ny2 * lightVec[1]; // -1..1, which side currently faces the light
                var offset = lit * HIGHLIGHT_OFFSET_FACTOR * r2v;
                var halfW = HIGHLIGHT_WIDTH_FACTOR * r2v;
                var cx = samplePts[sj2][0] + nx2 * offset;
                var cy = samplePts[sj2][1] + ny2 * offset;
                hlLeft.push([cx - nx2 * halfW, cy - ny2 * halfW]);
                hlRight.push([cx + nx2 * halfW, cy + ny2 * halfW]);
            }
            var hlOutline = hlLeft.concat(hlRight.slice().reverse());
            var hlPath = doc.pathItems.add();
            hlPath.setEntirePath(hlOutline);
            hlPath.closed = true;
            hlPath.filled = true;
            hlPath.stroked = false;
            hlPath.fillColor = lightenColor(fillColorFor(srcPath), HIGHLIGHT_LIGHTEN_AMOUNT);
            highlightShapes.push(hlPath);
        }
    }

    // the split-segment centerlines (finalPaths) were only scaffolding for
    // tapering - hide them now too, not just the pre-split originals, or
    // any tree with real mid-curve branch splits leaves visible leftovers.
    for (var hfp = 0; hfp < finalPaths.length; hfp++) {
        try { finalPaths[hfp].hidden = true; } catch (err) {}
    }

    // ============================================================
    // PHASE G: union, then round the sharp junction corners
    // ============================================================

    var mergedItems = ATTEMPT_PATHFINDER_UNITE ? unionShapes(doc, newShapes, "vessel") : newShapes;

    // clean up tiny boolean-op sliver artifacts before corner detection
    for (var cu = 0; cu < mergedItems.length; cu++) {
        if (mergedItems[cu].typename !== "PathItem") continue;
        var cleaned = cleanupNearDuplicates(doc, mergedItems[cu], MERGE_TOL);
        if (cleaned) mergedItems[cu] = cleaned;
    }

    var flatPaths = [];
    for (var mi = 0; mi < mergedItems.length; mi++) {
        var item = mergedItems[mi];
        if (item.typename === "PathItem") flatPaths.push(item);
        else if (item.typename === "CompoundPathItem") {
            for (var cpi = 0; cpi < item.pathItems.length; cpi++) flatPaths.push(item.pathItems[cpi]);
        }
    }

    var patchCount = 0;
    if (DO_ROUND_CORNERS) {
        for (var fpi = 0; fpi < flatPaths.length; fpi++) {
            try {
                patchCount += buildCornerPatches(doc, flatPaths[fpi], FILLET_RADIUS, CORNER_ANGLE_THRESHOLD_DEG);
            } catch (err) {
                alert("Corner-patch detection failed on one shape: " + err.message);
            }
        }
    }

    // merge all per-segment highlight ribbons into ONE continuous shape first -
    // blurring them individually is what caused the visible "start and stop"
    // cuts at every segment boundary - then blur once and clip to the vessel's
    // own final outline so it can't bleed past the edge.
    if (DO_ADD_HIGHLIGHTS && highlightShapes.length > 0) {
        var mergedHighlights = ATTEMPT_PATHFINDER_UNITE ? unionShapes(doc, highlightShapes, "highlight") : highlightShapes;

        var clipSource = null;
        if (flatPaths.length === 1) {
            clipSource = flatPaths[0].duplicate();
        } else if (flatPaths.length > 1) {
            var dups = [];
            for (var dpi = 0; dpi < flatPaths.length; dpi++) dups.push(flatPaths[dpi].duplicate());
            var unionedClip = unionShapes(doc, dups, "highlight-clip-source");
            clipSource = unionedClip.length > 0 ? unionedClip[0] : null;
        }

        if (clipSource) {
            clipSource.filled = false;
            clipSource.stroked = false;

            var builtHighlightGroups = [];
            for (var hmi = 0; hmi < mergedHighlights.length; hmi++) {
                var hShape = mergedHighlights[hmi];
                var clipDup = (hmi === mergedHighlights.length - 1) ? clipSource : clipSource.duplicate();
                clipDup.filled = false;
                clipDup.stroked = false;
                clipDup.clipping = true;

                var hGroup = doc.groupItems.add();
                hShape.move(hGroup, ElementPlacement.PLACEATBEGINNING);
                clipDup.move(hGroup, ElementPlacement.PLACEATBEGINNING);
                hGroup.clipped = true;
                hGroup.name = "vessel_highlight";
                hGroup.move(highlightLayer, ElementPlacement.PLACEATBEGINNING);
                builtHighlightGroups.push(hGroup);
            }

            // scripted Gaussian Blur via applyEffect proved unreliable (silent
            // no-op, no thrown error) - leave the highlights pre-selected so
            // blurring manually is a single Effect > Blur > Gaussian Blur away.
            if (HIGHLIGHT_BLUR_RADIUS > 0) {
                doc.selection = null;
                for (var bg = 0; bg < builtHighlightGroups.length; bg++) builtHighlightGroups[bg].selected = true;
            }
        }
    }

    alert("Done. Built " + edges.length + " vessel segment(s) from " + finalPaths.length + " path piece(s). Created " + patchCount + " separate fillet patch(es) you can review, delete, or merge in yourself." + (DO_ADD_HIGHLIGHTS ? " Highlights are merged into one continuous shape per tree and clipped to the vessel outline, on their own 'Vessel Highlights' layer, and are left selected - apply Effect > Blur > Gaussian Blur now (try " + HIGHLIGHT_BLUR_RADIUS + "pt) to finish them." : "") + " Original centerlines were hidden, not deleted.");

})();
