import React, { useState, useRef, useEffect, useMemo, useCallback, useLayoutEffect } from "react";
import { Gear, Share, ArrowUUpLeft, Tag, Calculator as CalculatorIcon, Sun, Moon, Copy, ClipboardText, FileXls, Files, Plus, X, FolderOpen, Trash, CaretLeft, Lock, Globe, MagnifyingGlass, Check, Eye, EyeSlash, PencilSimple, XSquare, Backspace } from "@phosphor-icons/react";

/**
 * CALCU — canvas calculator.
 *
 * Model:
 *   - Canvas is a list of "lines".
 *   - Each line has tokens: { kind: "num" | "op" | "ref" | "paren" }.
 *   - ref-tokens point to another line's id → live link.
 *   - Each line computes a result (the orange chip).
 *
 * Interactions:
 *   - Tap a line to make it active (new input goes there).
 *   - Long-press any chip/number → menu with Copiar / Pegar / Etiqueta / Borrar.
 *   - Drag a chip from one line onto another → creates linked token (purple).
 *   - Double-tap any number → inline edit.
 *   - Purple chip = linked reference; curved line connects it to source.
 *   - Change a source and everything downstream recomputes automatically.
 */

// ----------------------- evaluator -----------------------
const OPS = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "^": (a, b) => Math.pow(a, b),
  "%": (a, b) => a - Math.floor(a / b) * b,
};
const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 4 };
const RIGHT = { "^": true };

function evalTokens(tokens, resolveRef, resolveGlobal, resolveTokenRef) {
  if (!tokens.length) return { value: null };
  const out = [];
  const ops = [];
  try {
    for (const t of tokens) {
      if (t.kind === "num") {
        out.push(t.value);
      } else if (t.kind === "ref") {
        const v = resolveRef(t.sourceId);
        if (v === null || v === undefined || Number.isNaN(v))
          return { value: null, error: "vínculo roto" };
        out.push(v);
      } else if (t.kind === "tokenref") {
        const v = resolveTokenRef ? resolveTokenRef(t.lineId, t.tokenId) : null;
        if (v === null || v === undefined || Number.isNaN(v))
          return { value: null, error: "vínculo roto" };
        out.push(v);
      } else if (t.kind === "globalref") {
        const v = resolveGlobal ? resolveGlobal(t.globalId) : null;
        if (v === null || v === undefined || Number.isNaN(v))
          return { value: null, error: "global perdida" };
        out.push(v);
      } else if (t.kind === "paren" && t.value === "(") {
        ops.push(t);
      } else if (t.kind === "paren" && t.value === ")") {
        while (ops.length && ops[ops.length - 1].kind !== "paren") {
          applyOp(out, ops.pop());
        }
        if (!ops.length) return { value: null, error: "paréntesis" };
        ops.pop();
      } else if (t.kind === "op") {
        while (
          ops.length &&
          ops[ops.length - 1].kind === "op" &&
          (PREC[ops[ops.length - 1].value] > PREC[t.value] ||
            (PREC[ops[ops.length - 1].value] === PREC[t.value] && !RIGHT[t.value]))
        ) {
          applyOp(out, ops.pop());
        }
        ops.push(t);
      }
    }
    while (ops.length) {
      const o = ops.pop();
      if (o.kind === "paren") return { value: null, error: "paréntesis" };
      applyOp(out, o);
    }
    if (out.length !== 1) return { value: null, error: "incompleta" };
    const v = out[0];
    if (typeof v !== "number" || !isFinite(v)) return { value: null, error: "∞" };
    return { value: v };
  } catch (e) {
    return { value: null, error: "error" };
  }
}

function applyOp(out, op) {
  if (out.length < 2) throw new Error("op");
  const b = out.pop();
  const a = out.pop();
  out.push(OPS[op.value](a, b));
}

// Module-level current settings — App updates this whenever settings change so
// formatting functions (which can't easily access React context) stay in sync.
let _currentSettings = null;

function fmt(n) {
  return fmtN(n, _currentSettings || DEFAULT_SETTINGS);
}

// Parse a number entered by a user — accepts both '.' and ',' as decimal separator,
// and ignores thousands separators. Returns NaN if invalid.
function parseUserNumber(input) {
  if (typeof input !== "string") return parseFloat(input);
  const s = input.trim();
  if (!s) return NaN;
  // Strategy: if both '.' and ',' appear, the LAST one is the decimal separator.
  // If only one appears, treat it as decimal.
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalIdx = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalIdx = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0) {
    decimalIdx = lastDot;
  } else if (lastComma >= 0) {
    decimalIdx = lastComma;
  }
  let normalized;
  if (decimalIdx === -1) {
    normalized = s;
  } else {
    const intPart = s.slice(0, decimalIdx).replace(/[.,\s]/g, "");
    const decPart = s.slice(decimalIdx + 1).replace(/[.,\s]/g, "");
    normalized = decPart ? `${intPart}.${decPart}` : intPart;
  }
  return parseFloat(normalized);
}

// Format a number for display in a decimal-input field. Uses comma decimal
// separator since the on-screen numeric keyboard in es-* locales typically
// only offers ',' (no '.'). parseUserNumber accepts both back, so we lose nothing.
function formatForInput(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  if (!isFinite(n)) return "";
  // Round to avoid floating-point trailing noise.
  const rounded = Math.round(n * 1e8) / 1e8;
  let s = String(rounded);
  // If scientific notation, give up and return as-is.
  if (s.includes("e") || s.includes("E")) return s;
  return s.replace(".", ",");
}

const uid = () => Math.random().toString(36).slice(2, 10);
const makeLine = (tokens) => ({ id: uid(), tokens, labels: {} });
const makeDoc = (name = "Sin título", folderId = DEFAULT_FOLDER_ID) => ({
  id: uid(),
  name,
  folderId,
  lines: [makeLine([])],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// ---------- Persistence (uses window.storage if available, else localStorage) ----------
const _hasWindowStorage = () =>
  typeof window !== "undefined" && window.storage && typeof window.storage.set === "function";

async function _storageSet(key, value) {
  if (_hasWindowStorage()) {
    try { await window.storage.set(key, value); return true; } catch (e) {}
  }
  try { localStorage.setItem(key, value); return true; } catch (e) {}
  return false;
}
async function _storageGet(key) {
  if (_hasWindowStorage()) {
    try { const r = await window.storage.get(key); return r ? r.value : null; } catch (e) {}
  }
  try { return localStorage.getItem(key); } catch (e) {}
  return null;
}
async function _storageDelete(key) {
  if (_hasWindowStorage()) {
    try { await window.storage.delete(key); return; } catch (e) {}
  }
  try { localStorage.removeItem(key); } catch (e) {}
}
async function _storageList(prefix) {
  if (_hasWindowStorage()) {
    try {
      const r = await window.storage.list(prefix);
      return r && r.keys ? r.keys : [];
    } catch (e) {}
  }
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    return keys;
  } catch (e) {}
  return [];
}

async function listDocs() {
  const keys = await _storageList("doc:");
  const docs = [];
  for (const key of keys) {
    try {
      const v = await _storageGet(key);
      if (v) docs.push(JSON.parse(v));
    } catch (e) {}
  }
  return docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function saveDoc(doc) {
  await _storageSet(`doc:${doc.id}`, JSON.stringify(doc));
}

async function deleteDoc(docId) {
  await _storageDelete(`doc:${docId}`);
}

// Global variables — persistent across all documents.
// Each global has a `kind`:
//   "number"  → a value with a name (the original behavior).
//   "line"    → a saved sequence of tokens (formerly "fórmulas fx").
// Legacy globals saved without `kind` are treated as "number".
async function listGlobals() {
  const keys = await _storageList("global:");
  const globals = [];
  for (const key of keys) {
    try {
      const v = await _storageGet(key);
      if (v) {
        const g = JSON.parse(v);
        if (!g.kind) g.kind = "number";
        globals.push(g);
      }
    } catch (e) {}
  }
  return globals.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

async function saveGlobal(g) {
  await _storageSet(`global:${g.id}`, JSON.stringify(g));
}

async function deleteGlobal(id) {
  await _storageDelete(`global:${id}`);
}

const makeGlobal = (name = "", value = 0) => ({
  id: uid(),
  name,
  kind: "number",
  value,
  updatedAt: Date.now(),
});

// Create a "line" global from a snapshot of tokens (refs resolved to literals,
// globalrefs preserved as live links). Used when promoting an internal line
// variable to global, or when migrating legacy fx formulas.
const makeGlobalLine = (name = "", tokens = [], labels = {}) => ({
  id: uid(),
  name,
  kind: "line",
  tokens,
  labels,
  updatedAt: Date.now(),
});

// Folders — group documents into "general", "comidas", "casas" etc.
// Shape: { id, name, createdAt }. The "general" folder is always present.
const DEFAULT_FOLDER_ID = "folder-general";
const DEFAULT_FOLDER = { id: DEFAULT_FOLDER_ID, name: "general", createdAt: 0 };

async function listFolders() {
  const keys = await _storageList("folder:");
  const folders = [];
  let hasDefault = false;
  for (const key of keys) {
    try {
      const v = await _storageGet(key);
      if (v) {
        const f = JSON.parse(v);
        if (f.id === DEFAULT_FOLDER_ID) hasDefault = true;
        folders.push(f);
      }
    } catch (e) {}
  }
  if (!hasDefault) folders.unshift({ ...DEFAULT_FOLDER });
  // Sort: general always first, then by createdAt ascending.
  return folders.sort((a, b) => {
    if (a.id === DEFAULT_FOLDER_ID) return -1;
    if (b.id === DEFAULT_FOLDER_ID) return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

async function saveFolder(f) {
  await _storageSet(`folder:${f.id}`, JSON.stringify(f));
}

async function deleteFolderStorage(id) {
  await _storageDelete(`folder:${id}`);
}

const makeFolder = (name = "carpeta") => ({
  id: uid(),
  name,
  createdAt: Date.now(),
});

// Saved formulas — reusable calculation patterns. Each formula stores a snapshot
// of tokens, with internal refs already resolved to literal numbers.
// Shape: { id, name, tokens: [...], labels: {tokenId: string}, updatedAt }
async function listFormulas() {
  const keys = await _storageList("formula:");
  const formulas = [];
  for (const key of keys) {
    try {
      const v = await _storageGet(key);
      if (v) formulas.push(JSON.parse(v));
    } catch (e) {}
  }
  return formulas.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

async function saveFormula(f) {
  await _storageSet(`formula:${f.id}`, JSON.stringify(f));
}

async function deleteFormula(id) {
  await _storageDelete(`formula:${id}`);
}

// Convert a line into a reusable formula. Replace internal refs with the literal
// numeric value they currently resolve to (snapshot semantics). Globals are
// preserved as-is. Result: a token list that can be pasted into any document.
function lineToFormula(line, results, name) {
  const newTokens = [];
  const newLabels = {};
  for (const tok of line.tokens) {
    const newId = uid();
    if (tok.kind === "ref") {
      const r = results[tok.sourceId];
      const val = r && r.value !== null && r.value !== undefined ? r.value : 0;
      newTokens.push({ id: newId, kind: "num", value: val, raw: String(val) });
    } else if (tok.kind === "tokenref") {
      // Resolve token ref to literal — the target line context isn't preserved.
      const srcLine = line.id === tok.lineId ? line : null;
      // Note: only same-line refs would resolve here; cross-line tokenref needs
      // access to all lines. Caller passes a `lines` array for this scenario.
      const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
      const val = srcTok && srcTok.kind === "num" ? srcTok.value : 0;
      newTokens.push({ id: newId, kind: "num", value: val, raw: String(val) });
    } else if (tok.kind === "globalref") {
      newTokens.push({ id: newId, kind: "globalref", globalId: tok.globalId });
    } else {
      // num, op, paren — copy as-is with new id
      newTokens.push({ ...tok, id: newId });
    }
    // Carry over per-token labels
    if (line.labels && line.labels[tok.id]) {
      newLabels[newId] = line.labels[tok.id];
    }
  }
  return {
    id: uid(),
    name: name || "Sin nombre",
    tokens: newTokens,
    labels: newLabels,
    updatedAt: Date.now(),
  };
}


// User preferences. Persisted in storage. Shape:
//   darkMode, angleMode (deg|rad), maxDecimals (0..10), thousandsSep,
//   sciAbove (10^n where n > 0), textScale (0..6, where 3 = default),
//   textWeight ("regular"|"bold"), leftHanded
const DEFAULT_SETTINGS = {
  darkMode: false,
  angleMode: "deg",
  maxDecimals: 4,
  thousandsSep: true,
  sciAbove: 13, // power of ten
  textScale: 3,
  textWeight: "regular",
  leftHanded: false,
};

async function loadSettings() {
  try {
    const v = await _storageGet("settings");
    if (!v) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(v);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    return DEFAULT_SETTINGS;
  }
}
async function saveSettings(s) {
  try { await _storageSet("settings", JSON.stringify(s)); } catch (e) {}
}

// Format a number using user settings.
function fmtN(n, settings = DEFAULT_SETTINGS) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  if (!isFinite(n)) return "∞";
  const abs = Math.abs(n);
  const sciAbove = Math.pow(10, settings.sciAbove ?? 13);
  if (abs !== 0 && (abs < 1e-9 || abs >= sciAbove)) {
    return n.toExponential(Math.min(4, settings.maxDecimals ?? 4));
  }
  const maxFD = Math.max(0, Math.min(10, settings.maxDecimals ?? 4));
  const factor = Math.pow(10, maxFD);
  const rounded = Math.round(n * factor) / factor;
  // Use de-DE locale (.thousands ,decimals) as base, then strip thousands if disabled.
  let s = rounded.toLocaleString("de-DE", { maximumFractionDigits: maxFD });
  if (!settings.thousandsSep) {
    // Remove '.' that act as thousands separators (everything before the comma).
    const idx = s.indexOf(",");
    if (idx === -1) {
      s = s.replace(/\./g, "");
    } else {
      s = s.slice(0, idx).replace(/\./g, "") + s.slice(idx);
    }
  }
  return s;
}

// Distinct colors for each line's result chip. Cycles if exhausted.
// Two palettes: one for light mode (deeper), one for dark mode (brighter).
const LINE_COLORS_LIGHT = [
  "#ADD010", // green
  "#7c3aed", // purple
  "#16a34a", // green
  "#db2777", // magenta
  "#0ea5e9", // sky blue
  "#d97706", // amber
  "#dc2626", // red
  "#059669", // emerald
  "#7c2d12", // brown
  "#4338ca", // indigo
];
const LINE_COLORS_DARK = [
  "#ff9a3c", // brighter orange
  "#a78bfa", // lavender
  "#4ade80", // bright green
  "#f472b6", // bright pink
  "#38bdf8", // bright sky
  "#fbbf24", // gold
  "#f87171", // soft red
  "#34d399", // bright emerald
  "#e8956b", // tan
  "#818cf8", // soft indigo
];

function getLineColor(lines, lineId, darkMode = false) {
  const idx = lines.findIndex((l) => l.id === lineId);
  const palette = darkMode ? LINE_COLORS_DARK : LINE_COLORS_LIGHT;
  if (idx < 0) return palette[0];
  return palette[idx % palette.length];
}

// Reusable gesture hook for chips.
//
// Interaction model:
//   - Quick tap (< 250ms, no movement) → onTap (select for editing)
//   - Hold 250ms → chip is "picked up" (onPickUp); chip visually lifts
//     * Then MOVE → drag (onDragMove continuously)
//       * Release over a line → onDragEnd with coords
//     * Then RELEASE without moving → open menu (onLongPress)
//
// Touch listeners are non-passive so preventDefault works on iOS.
function useChipGesture({ onTap, onLongPress, onPickUp, onDragMove, onDragEnd }) {
  const elRef = useRef(null);
  const handlersRef = useRef({});
  useEffect(() => {
    handlersRef.current = { onTap, onLongPress, onPickUp, onDragMove, onDragEnd };
  }, [onTap, onLongPress, onPickUp, onDragMove, onDragEnd]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let startPos = null;   // { x, y, t }
    let pickedUp = false;
    let hasMoved = false;
    let pickupTimer = null;

    const clearTimers = () => {
      clearTimeout(pickupTimer);
      pickupTimer = null;
    };

    const begin = (x, y) => {
      startPos = { x, y, t: Date.now() };
      pickedUp = false;
      hasMoved = false;
      clearTimers();
      // 250ms hold → pick up the chip
      pickupTimer = setTimeout(() => {
        if (!startPos) return;
        pickedUp = true;
        const h = handlersRef.current;
        h.onPickUp && h.onPickUp(startPos.x, startPos.y);
      }, 250);
    };

    const move = (x, y, e) => {
      if (!startPos) return;
      const dx = x - startPos.x;
      const dy = y - startPos.y;
      const dist = Math.hypot(dx, dy);

      if (pickedUp) {
        // Already picked up → every move is a drag move.
        if (e && e.cancelable) e.preventDefault();
        if (dist > 4) hasMoved = true;
        const h = handlersRef.current;
        h.onDragMove && h.onDragMove(x, y);
      } else if (dist > 10) {
        // Moved before pick-up → abandon gesture (treat as scroll).
        clearTimers();
        startPos = null;
      }
    };

    const end = (x, y, e) => {
      const wasPickedUp = pickedUp;
      const didMove = hasMoved;
      const start = startPos;
      clearTimers();
      startPos = null;
      pickedUp = false;
      hasMoved = false;

      const h = handlersRef.current;
      if (wasPickedUp) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (didMove) {
          // Drop at release position.
          h.onDragEnd && h.onDragEnd(x, y);
        } else {
          // Picked up but didn't move → open context menu.
          h.onLongPress && h.onLongPress(el.getBoundingClientRect());
        }
        return;
      }
      // Quick release, no pick-up → tap to select.
      if (start && Date.now() - start.t < 250) {
        if (e && e.stopPropagation) e.stopPropagation();
        h.onTap && h.onTap();
      }
    };

    const onMouseDown = (e) => { e.stopPropagation(); begin(e.clientX, e.clientY); };
    const onMouseMove = (e) => move(e.clientX, e.clientY, e);
    const onMouseUp = (e) => end(e.clientX, e.clientY, e);
    const onTouchStart = (e) => {
      e.stopPropagation();
      const t = e.touches[0];
      begin(t.clientX, t.clientY);
    };
    const onTouchMove = (e) => {
      const t = e.touches[0];
      if (!t) return;
      move(t.clientX, t.clientY, e);
    };
    const onTouchEnd = (e) => {
      const t = e.changedTouches[0];
      end(t ? t.clientX : 0, t ? t.clientY : 0, e);
    };
    const onTouchCancel = () => {
      clearTimers();
      startPos = null;
      pickedUp = false;
      hasMoved = false;
    };

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchCancel, { passive: false });
    // Global mouse listeners so drag keeps tracking when cursor leaves the chip.
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      clearTimers();
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return elRef;
}

// ----------------------- App root: routes between docs list and calculator -----------------------
export default function App() {
  const [view, setView] = useState("loading"); // "loading" | "list" | "calc" | "globals"
  const [docs, setDocs] = useState([]);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [globals, setGlobals] = useState([]);
  const [formulas, setFormulas] = useState([]);
  const [folders, setFolders] = useState([{ ...DEFAULT_FOLDER }]);
  const [activeFolderId, setActiveFolderId] = useState(DEFAULT_FOLDER_ID);

  const darkMode = settings.darkMode;
  const setDarkMode = (val) => {
    const next = typeof val === "function" ? val(darkMode) : val;
    updateSetting("darkMode", next);
  };

  const updateSetting = (key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      _currentSettings = next;
      saveSettings(next).catch(() => {});
      return next;
    });
  };

  // Sync _currentSettings whenever settings state changes (covers initial load).
  useEffect(() => {
    _currentSettings = settings;
  }, [settings]);

  // Inject Roboto Mono font once at app start.
  useEffect(() => {
    const id = "calcu-roboto-mono-font";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@300;400;500;600;700&display=swap";
    document.head.appendChild(link);
  }, []);

  // Inject custom CSS — utility classes only.
  useEffect(() => {
    const id = "calcu-utility-styles";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.innerHTML = `
      .hide-scrollbar::-webkit-scrollbar { display: none; height: 0; width: 0; }
      .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      /* iOS Safari auto-zooms any input whose computed font-size is < 16px,
         and sometimes leaves the page locked at zoom > 1 after blur. Force
         16px on all text inputs to disable the auto-zoom entirely. */
      input[type="text"], input[type="search"], input[type="number"],
      input[type="tel"], input[type="email"], input:not([type]),
      textarea, select {
        font-size: 16px !important;
        -webkit-text-size-adjust: 100%;
        text-size-adjust: 100%;
      }
    `;
    document.head.appendChild(style);
  }, []);

  // Prevent iOS Safari from auto-zooming when any input gets focus.
  // Strategy: lock viewport with maximum-scale=1. This blocks both auto-zoom
  // on focus AND manual pinch-zoom (the latter is desired for a calc app).
  useEffect(() => {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    meta.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
  }, []);

  // Load documents, globals, formulas, folders and settings on mount.
  // One-time migration: any legacy fx formulas (storage key "formula:") get
  // converted into globals of kind "line" and the old formula entry is deleted.
  // Dedup by name to avoid duplicating on subsequent loads.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, gs, fs, fl, st] = await Promise.all([listDocs(), listGlobals(), listFormulas(), listFolders(), loadSettings()]);
      if (cancelled) return;
      // Backfill folderId for legacy docs (those saved before folders existed).
      const fixedDocs = list.map((d) => d.folderId ? d : { ...d, folderId: DEFAULT_FOLDER_ID });

      // Migrate legacy formulas into globals of kind "line" (one-time).
      let mergedGlobals = gs.slice();
      const migratedAsLines = [];
      if (fs && fs.length) {
        const existingLineNames = new Set(
          mergedGlobals.filter((g) => g.kind === "line").map((g) => (g.name || "").toLowerCase())
        );
        for (const f of fs) {
          const lname = (f.name || "").toLowerCase();
          if (existingLineNames.has(lname)) {
            // Already migrated previously — just clean up the old entry.
            deleteFormula(f.id).catch(() => {});
            continue;
          }
          const asLine = {
            id: f.id || uid(),
            name: f.name || "fórmula",
            kind: "line",
            tokens: f.tokens || [],
            labels: f.labels || {},
            updatedAt: f.updatedAt || Date.now(),
          };
          mergedGlobals.push(asLine);
          migratedAsLines.push(asLine);
          saveGlobal(asLine).catch(() => {});
          deleteFormula(f.id).catch(() => {});
        }
        mergedGlobals.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      }

      setDocs(fixedDocs);
      setGlobals(mergedGlobals);
      // Keep `formulas` state in sync as the legacy code paths still read it;
      // it's just a derived view of globals of kind "line".
      setFormulas(mergedGlobals.filter((g) => g.kind === "line"));
      setFolders(fl);
      setSettings(st);
      setView("list");
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshGlobals = async () => {
    const gs = await listGlobals();
    setGlobals(gs);
  };

  const upsertGlobal = async (g) => {
    const updated = { ...g, kind: g.kind || "number", updatedAt: Date.now() };
    // Optimistic: update state immediately so the UI reflects it without waiting for storage.
    setGlobals((prev) => {
      const idx = prev.findIndex((x) => x.id === updated.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = updated;
        return next.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      }
      return [...prev, updated].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    });
    // If this is a line global, also keep the formulas state in sync so that
    // the legacy fx tab continues to display it.
    if (updated.kind === "line") {
      setFormulas((prev) => {
        const idx = prev.findIndex((x) => x.id === updated.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updated;
          return next.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        }
        return [...prev, updated].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      });
    }
    // Persist in background.
    saveGlobal(updated).catch(() => {});
  };
  const removeGlobal = async (id) => {
    setGlobals((prev) => prev.filter((x) => x.id !== id));
    setFormulas((prev) => prev.filter((x) => x.id !== id));
    deleteGlobal(id).catch(() => {});
  };

  // Formulas are kept as globals with kind "line". upsertFormula/removeFormula
  // are kept for back-compat with the existing FormulasManager and Calculator
  // code paths that still call them. Both states (formulas and globals) are
  // updated together so the legacy fx tab keeps working.
  const upsertFormula = async (f) => {
    const updated = { ...f, kind: "line", updatedAt: Date.now() };
    setFormulas((prev) => {
      const idx = prev.findIndex((x) => x.id === updated.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = updated;
        return next.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      }
      return [...prev, updated].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    });
    setGlobals((prev) => {
      const idx = prev.findIndex((x) => x.id === updated.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = updated;
        return next.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      }
      return [...prev, updated].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    });
    // Persist as a global (the canonical location going forward).
    saveGlobal(updated).catch(() => {});
  };
  const removeFormula = async (id) => {
    setFormulas((prev) => prev.filter((x) => x.id !== id));
    setGlobals((prev) => prev.filter((x) => x.id !== id));
    deleteGlobal(id).catch(() => {});
  };

  const openDoc = (doc) => {
    setCurrentDoc(doc);
    setView("calc");
  };
  const newDoc = () => {
    const d = makeDoc("Sin título", activeFolderId);
    setCurrentDoc(d);
    setView("calc");
  };
  const backToList = async () => {
    // Refresh list (current doc was being saved in calc)
    const list = await listDocs();
    const fixed = list.map((d) => d.folderId ? d : { ...d, folderId: DEFAULT_FOLDER_ID });
    setDocs(fixed);
    setCurrentDoc(null);
    setView("list");
  };
  const removeDoc = async (id) => {
    await deleteDoc(id);
    const list = await listDocs();
    const fixed = list.map((d) => d.folderId ? d : { ...d, folderId: DEFAULT_FOLDER_ID });
    setDocs(fixed);
  };

  // Duplicate a doc: clone all lines/tokens with fresh ids, keep ref relations
  // valid by remapping ids together. Resulting copy lives in the same folder.
  const duplicateDoc = async (id) => {
    const original = docs.find((d) => d.id === id);
    if (!original) return;
    // Build id map for line ids so refs to other lines stay valid in the copy.
    const lineIdMap = {};
    (original.lines || []).forEach((l) => { lineIdMap[l.id] = uid(); });
    const tokenIdMap = {};
    (original.lines || []).forEach((l) => {
      (l.tokens || []).forEach((t) => { tokenIdMap[t.id] = uid(); });
    });
    const newLines = (original.lines || []).map((l) => {
      const newLineId = lineIdMap[l.id];
      const newTokens = (l.tokens || []).map((t) => {
        const newId = tokenIdMap[t.id];
        if (t.kind === "ref") {
          // Remap source line id; if pointing outside this doc, keep as-is.
          return { ...t, id: newId, sourceId: lineIdMap[t.sourceId] || t.sourceId };
        }
        if (t.kind === "tokenref") {
          return {
            ...t,
            id: newId,
            lineId: lineIdMap[t.lineId] || t.lineId,
            tokenId: tokenIdMap[t.tokenId] || t.tokenId,
          };
        }
        return { ...t, id: newId };
      });
      // Remap label keys (token ids) since tokens have new ids now.
      const newLabels = {};
      Object.entries(l.labels || {}).forEach(([key, val]) => {
        if (key === "result") newLabels.result = val;
        else if (tokenIdMap[key]) newLabels[tokenIdMap[key]] = val;
      });
      return { ...l, id: newLineId, tokens: newTokens, labels: newLabels };
    });
    const copy = {
      id: uid(),
      name: `${original.name || "Sin título"} (copia)`,
      folderId: original.folderId || DEFAULT_FOLDER_ID,
      lines: newLines,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveDoc(copy);
    const list = await listDocs();
    const fixed = list.map((d) => d.folderId ? d : { ...d, folderId: DEFAULT_FOLDER_ID });
    setDocs(fixed);
  };

  // Folder CRUD
  const createFolder = async (name) => {
    const f = makeFolder(name);
    setFolders((prev) => {
      // keep "general" first
      const next = [...prev, f];
      return next.sort((a, b) => {
        if (a.id === DEFAULT_FOLDER_ID) return -1;
        if (b.id === DEFAULT_FOLDER_ID) return 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
    });
    saveFolder(f).catch(() => {});
    setActiveFolderId(f.id);
  };
  const renameFolder = async (id, newName) => {
    if (id === DEFAULT_FOLDER_ID) return; // can't rename default
    let target = null;
    setFolders((prev) => {
      const next = prev.map((f) => {
        if (f.id !== id) return f;
        target = { ...f, name: newName };
        return target;
      });
      return next;
    });
    if (target) saveFolder(target).catch(() => {});
  };
  const removeFolder = async (id) => {
    if (id === DEFAULT_FOLDER_ID) return; // can't delete default
    // Move docs in this folder back to "general"
    const docsToMove = docs.filter((d) => d.folderId === id);
    for (const d of docsToMove) {
      const updated = { ...d, folderId: DEFAULT_FOLDER_ID, updatedAt: Date.now() };
      saveDoc(updated).catch(() => {});
    }
    setDocs((prev) => prev.map((d) => d.folderId === id ? { ...d, folderId: DEFAULT_FOLDER_ID } : d));
    setFolders((prev) => prev.filter((f) => f.id !== id));
    deleteFolderStorage(id).catch(() => {});
    if (activeFolderId === id) setActiveFolderId(DEFAULT_FOLDER_ID);
  };
  const moveDocToFolder = async (docId, targetFolderId) => {
    const doc = docs.find((d) => d.id === docId);
    if (!doc) return;
    const updated = { ...doc, folderId: targetFolderId, updatedAt: Date.now() };
    setDocs((prev) => prev.map((d) => d.id === docId ? updated : d));
    saveDoc(updated).catch(() => {});
  };

  if (view === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: darkMode ? "#0f1115" : "#ffffff",
          color: darkMode ? "#7a8090" : "#888",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontStyle: "italic",
        }}
      >
        cargando…
      </div>
    );
  }
  if (view === "list") {
    return (
      <DocsList
        docs={docs}
        onOpen={openDoc}
        onNew={newDoc}
        onDelete={removeDoc}
        onDuplicate={duplicateDoc}
        onOpenGlobals={() => setView("globals")}
        onOpenFormulas={() => setView("formulas")}
        globalsCount={globals.length}
        formulasCount={formulas.length}
        folders={folders}
        activeFolderId={activeFolderId}
        onSelectFolder={setActiveFolderId}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={removeFolder}
        onMoveDoc={moveDocToFolder}
        darkMode={darkMode}
        setDarkMode={setDarkMode}
      />
    );
  }
  if (view === "globals") {
    return (
      <GlobalsManager
        globals={globals}
        onSave={upsertGlobal}
        onDelete={removeGlobal}
        onBack={() => setView("list")}
        darkMode={darkMode}
      />
    );
  }
  if (view === "formulas") {
    return (
      <FormulasManager
        formulas={formulas}
        globals={globals}
        onUpsert={upsertFormula}
        onDelete={removeFormula}
        onBack={() => setView("list")}
        darkMode={darkMode}
      />
    );
  }
  return (
    <Calculator
      doc={currentDoc}
      onBack={backToList}
      darkMode={darkMode}
      setDarkMode={setDarkMode}
      settings={settings}
      updateSetting={updateSetting}
      globals={globals}
      onUpsertGlobal={upsertGlobal}
      onDeleteGlobal={removeGlobal}
      formulas={formulas}
      onUpsertFormula={upsertFormula}
      onDeleteFormula={removeFormula}
    />
  );
}

// ----------------------- Documents list screen -----------------------
function DocsList({
  docs, onOpen, onNew, onDelete, onDuplicate, onOpenGlobals, onOpenFormulas,
  globalsCount, formulasCount, folders, activeFolderId, onSelectFolder,
  onCreateFolder, onRenameFolder, onDeleteFolder, onMoveDoc,
  darkMode, setDarkMode,
}) {
  const t = darkMode
    ? { bg: "#0f1115", card: "#161922", border: "#222630", text: "#e8ecf3", muted: "#7a8090", faint: "#4a4f5a" }
    : { bg: "#EBEBEB", card: "#ffffff", border: "#eee", text: "#1a1a1a", muted: "#888", faint: "#bbb" };

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const confirmTimerRef = useRef(null);
  const askDelete = (id) => {
    if (confirmDeleteId === id) {
      clearTimeout(confirmTimerRef.current);
      setConfirmDeleteId(null);
      onDelete(id);
      return;
    }
    setConfirmDeleteId(id);
    clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  };

  // Folder UX state
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [editFolderName, setEditFolderName] = useState("");
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState(null);
  const folderDelTimer = useRef(null);
  const askDeleteFolder = (id) => {
    if (confirmDeleteFolderId === id) {
      clearTimeout(folderDelTimer.current);
      setConfirmDeleteFolderId(null);
      onDeleteFolder(id);
      setEditingFolderId(null);
      return;
    }
    setConfirmDeleteFolderId(id);
    clearTimeout(folderDelTimer.current);
    folderDelTimer.current = setTimeout(() => setConfirmDeleteFolderId(null), 3000);
  };

  // Move-to-folder modal
  const [moveDocId, setMoveDocId] = useState(null);

  const formatDate = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `hoy, ${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "ayer";
    return `${d.getDate().toString().padStart(2,"0")}/${(d.getMonth()+1).toString().padStart(2,"0")}/${d.getFullYear().toString().slice(2)}`;
  };

  const summaryFor = (doc) => {
    if (!doc.lines || !doc.lines.length) return "vacío";
    const first = doc.lines.find((l) => l.tokens && l.tokens.length);
    if (!first) return "vacío";
    return `${first.tokens.length} elemento${first.tokens.length !== 1 ? "s" : ""}${doc.lines.length > 1 ? ` · ${doc.lines.length} líneas` : ""}`;
  };

  const filteredDocs = docs.filter((d) => (d.folderId || "folder-general") === activeFolderId);
  const accentOnCard = darkMode ? "#ADD010" : "#778D1C";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: t.bg,
        color: t.text,
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {/* Section 1: Logo + name (centered) */}
      <div
        style={{
          padding: "18px 18px 12px",
          paddingTop: "calc(env(safe-area-inset-top) + 18px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
        }}
      >
        <CalcuLogo size={36} darkMode={darkMode} />
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "0.04em" }}>CALCU</div>
      </div>

      {/* Section 2: Interface buttons (calculos / fx / globales / theme) */}
      <div
        style={{
          padding: "0 14px 14px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "nowrap",
          overflowX: "auto",
        }}
      >
        <SectionBtn active darkMode={darkMode}>
          <CalculatorIcon size={14} weight="bold" />
          <span>cálculos</span>
        </SectionBtn>
        <SectionBtn onClick={onOpenGlobals} darkMode={darkMode}>
          <Lock size={14} weight="bold" />
          <span>Globales</span>
          {globalsCount > 0 && <span style={{ opacity: 0.6 }}>· {globalsCount}</span>}
        </SectionBtn>
        <button
          onClick={() => setDarkMode((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 38,
            height: 38,
            borderRadius: "50%",
            background: "#000000",
            border: "none",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {darkMode ? <Moon size={16} weight="bold" style={{ color: "#ffffff" }} /> : <Sun size={16} weight="bold" style={{ color: "#ffffff" }} />}
        </button>
      </div>

      {/* Section 3: Folder tabs */}
      <div
        style={{
          padding: "4px 14px 0",
          display: "flex",
          alignItems: "stretch",
          gap: 4,
          overflowX: "auto",
          overflowY: "hidden",
          borderBottom: `1px solid ${t.border}`,
          minHeight: 52,
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
        className="hide-scrollbar"
      >
        {folders.map((f) => {
          const isActive = f.id === activeFolderId;
          const isEditing = editingFolderId === f.id;
          const isConfirmingDel = confirmDeleteFolderId === f.id;
          if (isEditing) {
            return (
              <div
                key={f.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "10px 4px",
                  flexShrink: 0,
                }}
              >
                <input
                  value={editFolderName}
                  onChange={(e) => setEditFolderName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const name = editFolderName.trim();
                      if (name) onRenameFolder(f.id, name);
                      setEditingFolderId(null);
                    }
                    if (e.key === "Escape") setEditingFolderId(null);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    borderBottom: `2px solid ${accentOnCard}`,
                    outline: "none",
                    fontFamily: "inherit",
                    fontSize: 16,
                    color: accentOnCard,
                    padding: "2px 0",
                    width: 100,
                  }}
                />
                <button
                  onClick={() => {
                    const name = editFolderName.trim();
                    if (name) onRenameFolder(f.id, name);
                    setEditingFolderId(null);
                  }}
                  style={{
                    background: accentOnCard, border: "none", borderRadius: 4,
                    width: 24, height: 24, color: "#fff", cursor: "pointer",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Check size={12} weight="bold" />
                </button>
                {f.id !== "folder-general" && (
                  <button
                    onClick={() => askDeleteFolder(f.id)}
                    style={{
                      background: isConfirmingDel ? "#d44" : "transparent",
                      border: "none",
                      width: isConfirmingDel ? "auto" : 24,
                      padding: isConfirmingDel ? "0 8px" : 0,
                      height: 24,
                      color: isConfirmingDel ? "#fff" : "#d44",
                      cursor: "pointer",
                      borderRadius: 4,
                      fontSize: 11,
                      fontFamily: "inherit",
                      display: "inline-flex", alignItems: "center", gap: 3, justifyContent: "center",
                    }}
                  >
                    <Trash size={12} weight="bold" />
                    {isConfirmingDel && <span>borrar</span>}
                  </button>
                )}
                <button
                  onClick={() => setEditingFolderId(null)}
                  style={{
                    background: "transparent", border: "none",
                    color: t.muted, cursor: "pointer", padding: 2,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          }
          return (
            <button
              key={f.id}
              onClick={() => onSelectFolder(f.id)}
              onDoubleClick={() => {
                if (f.id === "folder-general") return;
                setEditingFolderId(f.id);
                setEditFolderName(f.name);
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: "12px 14px 10px",
                fontFamily: "inherit",
                fontSize: 15,
                color: isActive ? t.text : t.muted,
                fontWeight: isActive ? 500 : 400,
                cursor: "pointer",
                borderBottom: isActive ? `2px solid ${accentOnCard}` : "2px solid transparent",
                marginBottom: -1,
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
              title={f.id === "folder-general" ? "carpeta default" : "doble tap para renombrar"}
            >
              {f.name}
            </button>
          );
        })}
        {creatingFolder ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "10px 4px", flexShrink: 0 }}>
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const name = newFolderName.trim();
                  if (name) onCreateFolder(name);
                  setNewFolderName("");
                  setCreatingFolder(false);
                }
                if (e.key === "Escape") {
                  setNewFolderName("");
                  setCreatingFolder(false);
                }
              }}
              placeholder="carpeta"
              style={{
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${accentOnCard}`,
                outline: "none",
                fontFamily: "inherit",
                fontSize: 16,
                color: accentOnCard,
                padding: "2px 0",
                width: 110,
              }}
            />
            <button
              onClick={() => {
                const name = newFolderName.trim();
                if (name) onCreateFolder(name);
                setNewFolderName("");
                setCreatingFolder(false);
              }}
              style={{
                background: accentOnCard, border: "none", borderRadius: 4,
                width: 24, height: 24, color: "#fff", cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <Check size={12} weight="bold" />
            </button>
            <button
              onClick={() => { setNewFolderName(""); setCreatingFolder(false); }}
              style={{
                background: "transparent", border: "none",
                color: t.muted, cursor: "pointer", padding: 2,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreatingFolder(true)}
            style={{
              background: "transparent",
              border: "none",
              padding: "12px 12px 10px",
              cursor: "pointer",
              color: t.muted,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            aria-label="Nueva carpeta"
            title="Nueva carpeta"
          >
            <Plus size={16} weight="bold" />
          </button>
        )}
      </div>

      {/* Doc list */}
      <div style={{ padding: "12px 12px 80px" }}>
        {filteredDocs.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "40px 20px",
              color: t.muted,
              fontStyle: "italic",
              fontSize: 14,
            }}
          >
            no hay cálculos en {folders.find((f) => f.id === activeFolderId)?.name || "esta carpeta"}
          </div>
        )}
        {filteredDocs.map((doc) => (
          <div
            key={doc.id}
            onClick={() => onOpen(doc)}
            style={{
              background: t.card,
              border: `1px solid ${t.border}`,
              borderRadius: 12,
              padding: "14px 16px",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              cursor: "pointer",
              transition: "transform 0.08s",
            }}
            onTouchStart={(e) => { e.currentTarget.style.transform = "scale(0.99)"; }}
            onTouchEnd={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {doc.name || "Sin título"}
              </div>
              <div style={{ fontSize: 12, color: t.muted, marginTop: 3, fontStyle: "italic" }}>
                {formatDate(doc.updatedAt)} · {summaryFor(doc)}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onDuplicate) onDuplicate(doc.id);
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 8,
                marginLeft: 4,
                cursor: "pointer",
                color: t.muted,
                borderRadius: 8,
              }}
              aria-label="Duplicar cálculo"
              title="Duplicar"
            >
              <Files size={16} weight="bold" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMoveDocId(doc.id);
              }}
              style={{
                background: "transparent",
                border: "none",
                padding: 8,
                marginLeft: 4,
                cursor: "pointer",
                color: t.muted,
                borderRadius: 8,
              }}
              aria-label="Mover a otra carpeta"
              title="Mover"
            >
              <FolderOpen size={16} weight="bold" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                askDelete(doc.id);
              }}
              style={{
                background: confirmDeleteId === doc.id ? "#d44" : "transparent",
                border: "none",
                padding: confirmDeleteId === doc.id ? "8px 12px" : 8,
                marginLeft: 2,
                cursor: "pointer",
                color: confirmDeleteId === doc.id ? "white" : t.muted,
                borderRadius: 8,
                fontFamily: "inherit",
                fontSize: 12,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                transition: "all 0.15s",
              }}
            >
              <Trash size={16} weight="bold" />
              {confirmDeleteId === doc.id && <span>borrar</span>}
            </button>
          </div>
        ))}
      </div>

      {/* Move to folder modal */}
      {moveDocId && (
        <div
          onClick={() => setMoveDocId(null)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 80, display: "flex",
            alignItems: "center", justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: t.card, color: t.text,
              borderRadius: 14, padding: "16px 14px",
              fontFamily: "inherit", maxWidth: 320, width: "100%",
              boxShadow: "0 16px 40px rgba(0,0,0,0.3)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Mover a carpeta</div>
            {folders.map((f) => {
              const doc = docs.find((d) => d.id === moveDocId);
              const currentFolder = doc?.folderId || "folder-general";
              const isCurrent = f.id === currentFolder;
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    if (!isCurrent) onMoveDoc(moveDocId, f.id);
                    setMoveDocId(null);
                  }}
                  style={{
                    width: "100%", textAlign: "left",
                    padding: "12px 14px", marginBottom: 4,
                    background: isCurrent ? `${accentOnCard}1a` : "transparent",
                    border: `1px solid ${isCurrent ? accentOnCard : t.border}`,
                    borderRadius: 8,
                    fontFamily: "inherit", fontSize: 14,
                    color: isCurrent ? accentOnCard : t.text,
                    cursor: isCurrent ? "default" : "pointer",
                    display: "flex", alignItems: "center", gap: 8,
                  }}
                >
                  <FolderOpen size={14} weight="bold" />
                  <span style={{ flex: 1 }}>{f.name}</span>
                  {isCurrent && <Check size={14} weight="bold" />}
                </button>
              );
            })}
            <button
              onClick={() => setMoveDocId(null)}
              style={{
                width: "100%", marginTop: 8, padding: "10px",
                background: "transparent", border: "none",
                fontFamily: "inherit", fontSize: 13, color: t.muted,
                cursor: "pointer",
              }}
            >
              cancelar
            </button>
          </div>
        </div>
      )}

      <button
        onClick={onNew}
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "#ADD010",
          color: "#000",
          border: "none",
          boxShadow: "0 8px 24px rgba(173,208,16,0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
        aria-label="Nuevo cálculo"
      >
        <Plus size={26} weight="bold" />
      </button>
    </div>
  );
}

function SectionBtn({ children, onClick, active, darkMode }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        borderRadius: 20,
        background: active ? "#000000" : "#000000",
        opacity: active ? 1 : 0.85,
        border: "none",
        cursor: onClick ? "pointer" : "default",
        color: "#ffffff",
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

// CALCU app icon — a calculator silhouette with two yellow and one green dot.
function CalcuLogo({ size = 36, darkMode = false, mini = false }) {
  // Mini variant: simpler outline calc icon (used in section pill buttons).
  // The path uses currentColor so the icon picks up whatever color is set on
  // the parent (e.g. white when on a black pill).
  if (mini) {
    return (
      <svg width={size} height={size * (21/18)} viewBox="0 0 18 21" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
        <path d="M15.375 0H1.875C1.37772 0 0.900806 0.197544 0.549175 0.549175C0.197544 0.900806 0 1.37772 0 1.875V18.375C0 18.8723 0.197544 19.3492 0.549175 19.7008C0.900806 20.0525 1.37772 20.25 1.875 20.25H15.375C15.8723 20.25 16.3492 20.0525 16.7008 19.7008C17.0525 19.3492 17.25 18.8723 17.25 18.375V1.875C17.25 1.37772 17.0525 0.900806 16.7008 0.549175C16.3492 0.197544 15.8723 0 15.375 0ZM15 18H2.25V2.25H15V18ZM4.125 5.25C4.125 4.95163 4.24353 4.66548 4.4545 4.4545C4.66548 4.24353 4.95163 4.125 5.25 4.125H12C12.2984 4.125 12.5845 4.24353 12.7955 4.4545C13.0065 4.66548 13.125 4.95163 13.125 5.25C13.125 5.54837 13.0065 5.83452 12.7955 6.0455C12.5845 6.25647 12.2984 6.375 12 6.375H5.25C4.95163 6.375 4.66548 6.25647 4.4545 6.0455C4.24353 5.83452 4.125 5.54837 4.125 5.25ZM7.875 10.125C7.875 10.4217 7.78703 10.7117 7.6222 10.9584C7.45738 11.205 7.22311 11.3973 6.94902 11.5108C6.67494 11.6244 6.37334 11.6541 6.08236 11.5962C5.79139 11.5383 5.52412 11.3954 5.31434 11.1857C5.10456 10.9759 4.9617 10.7086 4.90382 10.4176C4.84594 10.1267 4.87565 9.82506 4.98918 9.55098C5.10271 9.27689 5.29497 9.04262 5.54164 8.8778C5.78832 8.71297 6.07833 8.625 6.375 8.625C6.77282 8.625 7.15436 8.78304 7.43566 9.06434C7.71696 9.34564 7.875 9.72718 7.875 10.125ZM12.375 10.125C12.375 10.4217 12.287 10.7117 12.1222 10.9584C11.9574 11.205 11.7231 11.3973 11.449 11.5108C11.1749 11.6244 10.8733 11.6541 10.5824 11.5962C10.2914 11.5383 10.0241 11.3954 9.81434 11.1857C9.60456 10.9759 9.4617 10.7086 9.40382 10.4176C9.34594 10.1267 9.37565 9.82506 9.48918 9.55098C9.60271 9.27689 9.79497 9.04262 10.0416 8.8778C10.2883 8.71297 10.5783 8.625 10.875 8.625C11.2728 8.625 11.6544 8.78304 11.9357 9.06434C12.217 9.34564 12.375 9.72718 12.375 10.125ZM7.875 14.625C7.875 14.9217 7.78703 15.2117 7.6222 15.4584C7.45738 15.705 7.22311 15.8973 6.94902 16.0108C6.67494 16.1244 6.37334 16.1541 6.08236 16.0962C5.79139 16.0383 5.52412 15.8954 5.31434 15.6857C5.10456 15.4759 4.9617 15.2086 4.90382 14.9176C4.84594 14.6267 4.87565 14.3251 4.98918 14.051C5.10271 13.7769 5.29497 13.5426 5.54164 13.3778C5.78832 13.213 6.07833 13.125 6.375 13.125C6.77282 13.125 7.15436 13.283 7.43566 13.5643C7.71696 13.8456 7.875 14.2272 7.875 14.625ZM12.375 14.625C12.375 14.9217 12.287 15.2117 12.1222 15.4584C11.9574 15.705 11.7231 15.8973 11.449 16.0108C11.1749 16.1244 10.8733 16.1541 10.5824 16.0962C10.2914 16.0383 10.0241 15.8954 9.81434 15.6857C9.60456 15.4759 9.4617 15.2086 9.40382 14.9176C9.34594 14.6267 9.37565 14.3251 9.48918 14.051C9.60271 13.7769 9.79497 13.5426 10.0416 13.3778C10.2883 13.213 10.5783 13.125 10.875 13.125C11.2728 13.125 11.6544 13.283 11.9357 13.5643C12.217 13.8456 12.375 14.2272 12.375 14.625Z" fill="currentColor"/>
      </svg>
    );
  }
  return (
    <svg width={size} height={size * (36/31)} viewBox="0 0 31 36" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <path d="M13.7812 25.5938C13.7812 26.1129 13.6273 26.6204 13.3389 27.0521C13.0504 27.4838 12.6404 27.8203 12.1608 28.0189C11.6811 28.2176 11.1533 28.2696 10.6441 28.1683C10.1349 28.067 9.66721 27.817 9.3001 27.4499C8.93298 27.0828 8.68297 26.6151 8.58169 26.1059C8.4804 25.5967 8.53239 25.0689 8.73107 24.5892C8.92975 24.1095 9.2662 23.6996 9.69788 23.4111C10.1296 23.1227 10.6371 22.9688 11.1562 22.9688C11.8524 22.9688 12.5201 23.2453 13.0124 23.7376C13.5047 24.2299 13.7812 24.8976 13.7812 25.5938Z" fill="#1481DB"/>
      <path d="M21.6562 25.5938C21.6562 26.1129 21.5023 26.6204 21.2139 27.0521C20.9254 27.4838 20.5155 27.8203 20.0358 28.0189C19.5561 28.2176 19.0283 28.2696 18.5191 28.1683C18.0099 28.067 17.5422 27.817 17.1751 27.4499C16.808 27.0828 16.558 26.6151 16.4567 26.1059C16.3554 25.5967 16.4074 25.0689 16.6061 24.5892C16.8047 24.1095 17.1412 23.6996 17.5729 23.4111C18.0046 23.1227 18.5121 22.9688 19.0312 22.9688C19.7274 22.9688 20.3951 23.2453 20.8874 23.7376C21.3797 24.2299 21.6562 24.8976 21.6562 25.5938Z" fill="#ADD010"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M3.28125 0H26.9062C27.7765 0 28.6111 0.345702 29.2264 0.961056C29.8418 1.57641 30.1875 2.41101 30.1875 3.28125V32.1562C30.1875 33.0265 29.8418 33.8611 29.2264 34.4764C28.6111 35.0918 27.7765 35.4375 26.9062 35.4375H3.28125C2.41101 35.4375 1.57641 35.0918 0.961056 34.4764C0.345702 33.8611 0 33.0265 0 32.1562V3.28125C0 2.41101 0.345702 1.57641 0.961056 0.961056C1.57641 0.345702 2.41101 0 3.28125 0ZM7.79538 7.79538C7.42617 8.1646 7.21875 8.66536 7.21875 9.1875C7.21875 9.70964 7.42617 10.2104 7.79538 10.5796C8.1646 10.9488 8.66536 11.1562 9.1875 11.1562H21C21.5221 11.1562 22.0229 10.9488 22.3921 10.5796C22.7613 10.2104 22.9688 9.70964 22.9688 9.1875C22.9688 8.66536 22.7613 8.1646 22.3921 7.79538C22.0229 7.42617 21.5221 7.21875 21 7.21875H9.1875C8.66536 7.21875 8.1646 7.42617 7.79538 7.79538ZM13.3389 19.1771C13.6273 18.7454 13.7812 18.2379 13.7812 17.7188C13.7812 17.0226 13.5047 16.3549 13.0124 15.8626C12.5201 15.3703 11.8524 15.0938 11.1562 15.0938C10.6371 15.0938 10.1296 15.2477 9.69788 15.5361C9.2662 15.8246 8.92975 16.2346 8.73107 16.7142C8.53239 17.1939 8.4804 17.7217 8.58169 18.2309C8.68297 18.7401 8.93298 19.2078 9.3001 19.5749C9.66721 19.942 10.1349 20.192 10.6441 20.2933C11.1533 20.3946 11.6811 20.3426 12.1608 20.1439C12.6404 19.9453 13.0504 19.6088 13.3389 19.1771ZM21.2139 19.1771C21.5023 18.7454 21.6562 18.2379 21.6562 17.7188C21.6562 17.0226 21.3797 16.3549 20.8874 15.8626C20.3951 15.3703 19.7274 15.0938 19.0312 15.0938C18.5121 15.0938 18.0046 15.2477 17.5729 15.5361C17.1412 15.8246 16.8047 16.2346 16.6061 16.7142C16.4074 17.1939 16.3554 17.7217 16.4567 18.2309C16.558 18.7401 16.808 19.2078 17.1751 19.5749C17.5422 19.942 18.0099 20.192 18.5191 20.2933C19.0283 20.3946 19.5561 20.3426 20.0358 20.1439C20.5155 19.9453 20.9254 19.6088 21.2139 19.1771ZM13.3389 27.0521C13.6273 26.6204 13.7812 26.1129 13.7812 25.5938C13.7812 24.8976 13.5047 24.2299 13.0124 23.7376C12.5201 23.2453 11.8524 22.9688 11.1562 22.9688C10.6371 22.9688 10.1296 23.1227 9.69788 23.4111C9.2662 23.6996 8.92975 24.1095 8.73107 24.5892C8.53239 25.0689 8.4804 25.5967 8.58169 26.1059C8.68297 26.6151 8.93298 27.0828 9.3001 27.4499C9.66721 27.817 10.1349 28.067 10.6441 28.1683C11.1533 28.2696 11.6811 28.2176 12.1608 28.0189C12.6404 27.8203 13.0504 27.4838 13.3389 27.0521ZM21.2139 27.0521C21.5023 26.6204 21.6562 26.1129 21.6562 25.5938C21.6562 24.8976 21.3797 24.2299 20.8874 23.7376C20.3951 23.2453 19.7274 22.9688 19.0312 22.9688C18.5121 22.9688 18.0046 23.1227 17.5729 23.4111C17.1412 23.6996 16.8047 24.1095 16.6061 24.5892C16.4074 25.0689 16.3554 25.5967 16.4567 26.1059C16.558 26.6151 16.808 27.0828 17.1751 27.4499C17.5422 27.817 18.0099 28.067 18.5191 28.1683C19.0283 28.2696 19.5561 28.2176 20.0358 28.0189C20.5155 27.8203 20.9254 27.4838 21.2139 27.0521Z" fill="black"/>
    </svg>
  );
}

// ----------------------- main calculator component -----------------------
function Calculator({ doc, onBack, darkMode, setDarkMode, settings = DEFAULT_SETTINGS, updateSetting = () => {}, globals = [], onUpsertGlobal, onDeleteGlobal, formulas = [], onUpsertFormula = () => {}, onDeleteFormula = () => {} }) {
  const [lines, setLines] = useState(() => doc?.lines && doc.lines.length ? doc.lines : [makeLine([])]);
  const [docName, setDocName] = useState(doc?.name || "Sin título");
  const [docId] = useState(doc?.id || uid());
  const [showSettings, setShowSettings] = useState(false);
  const [activeLineId, setActiveLineId] = useState(() => null);
  const [selection, setSelection] = useState(null);
  const [clipboard, setClipboard] = useState(null);
  const [copyToast, _setCopyToast] = useState(null);
  const copyToastTimer = useRef(null);
  const setCopyToast = (msg) => {
    _setCopyToast(msg);
    if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
    copyToastTimer.current = setTimeout(() => _setCopyToast(null), 1800);
  };
  const [menu, setMenu] = useState(null);
  const [editing, setEditing] = useState(null);
  const [history, setHistory] = useState([]);
  const [labelEditor, setLabelEditor] = useState(null);
  const [drag, setDrag] = useState(null);
  const [keypadMode, setKeypadMode] = useState("numpad"); // "numpad" | "vars" | "share"
  const [varsTab, setVarsTab] = useState("internas"); // "internas" | "globales"
  const [keypadHidden, setKeypadHidden] = useState(false);

  // Auto-save document whenever lines or name change.
  useEffect(() => {
    const handle = setTimeout(() => {
      saveDoc({
        id: docId,
        name: docName,
        lines,
        updatedAt: Date.now(),
        createdAt: doc?.createdAt || Date.now(),
      });
    }, 600);
    return () => clearTimeout(handle);
  }, [lines, docName, docId, doc]);

  // Theme object — every component reads its colors from here.
  const theme = darkMode
    ? {
        bg: "#0f1115",
        toolbar: "#161922",
        toolbarBorder: "#222630",
        text: "#e8ecf3",
        textMuted: "#7a8090",
        textFaint: "#4a4f5a",
        tokenText: "#e8ecf3",
        opText: "#8f95a3",
        equals: "#555a68",
        keyBg: "#1c1f28",
        keyText: "#e8ecf3",
        keyTopBg: "#161922",
        keyTopText: "#9098a8",
        keySidebar: "#12141a",
        keypadBg: "#0a0c11",
        keypadBorder: "#222630",
        labelBg: "#1c1f28",
        menuBg: "#2a2d36",
        menuText: "#eee",
        labelEditorBg: "#1a1d25",
        labelEditorText: "#e8ecf3",
        inputBorder: "#2a2d36",
        hintBg: "#1a2200",
        hintBorder: "#5a3b10",
        hintText: "#cae454",
        errText: "#ff7a88",
        accent: "#ADD010",
        accentOnWhite: "#ADD010",
      }
    : {
        bg: "#ffffff",
        toolbar: "#EBEBEB",
        toolbarBorder: "#eee",
        text: "#1a1a1a",
        textMuted: "#888",
        textFaint: "#ccc",
        tokenText: "#1a1a1a",
        opText: "#666",
        equals: "#aaa",
        keyBg: "#EBEBEB",
        keyText: "#1a1a1a",
        keyTopBg: "#f0f0f0",
        keyTopText: "#666",
        keySidebar: "#ddd",
        keypadBg: "#EBEBEB",
        keypadBorder: "#e5e5e5",
        labelBg: "#f4f4f4",
        menuBg: "#2a2a2a",
        menuText: "#eee",
        labelEditorBg: "#ffffff",
        labelEditorText: "#333",
        inputBorder: "#eee",
        hintBg: "#fff8ec",
        hintBorder: "#ffd89a",
        hintText: "#b36a00",
        errText: "#d4a",
        accent: "#ADD010",
        accentOnWhite: "#778D1C",
      };

  // Text scale: 0..6 maps to 0.7x..1.6x. Default (3) = 1.0x.
  const textScale = 0.7 + (settings.textScale ?? 3) * 0.15;
  theme.textScale = textScale;
  theme.textWeight = settings.textWeight === "bold" ? 500 : 300;
  theme.leftHanded = !!settings.leftHanded;

  const canvasRef = useRef(null);
  const chipRefs = useRef({});
  const [chipPositions, setChipPositions] = useState({});
  // When a chip handles a tap/pickup/drag, it sets this flag to suppress
  // the following root onClick that would otherwise clear the selection.
  const suppressNextRootClick = useRef(false);

  // Set active line on mount
  useEffect(() => {
    if (!activeLineId && lines.length > 0) setActiveLineId(lines[0].id);
  }, []);

  // Auto-scroll the canvas so the end of the active line stays visible.
  // Triggers when the active line changes or when its number of tokens changes
  // (e.g. user is appending). We scroll the LAST token of the line into view;
  // that handles both horizontal (line growing right) and vertical (line below
  // the viewport) cases.
  const activeLine = lines.find((l) => l.id === activeLineId);
  const activeLineTokenCount = activeLine?.tokens?.length || 0;
  // Signature of the last token — changes when the user types digits into a
  // number being built (token count stays the same but value/raw mutates).
  const lastTokSig = (() => {
    if (!activeLine || !activeLine.tokens || activeLine.tokens.length === 0) return "";
    const t = activeLine.tokens[activeLine.tokens.length - 1];
    if (t.kind === "num") return `num:${t.raw ?? t.value}`;
    if (t.kind === "op") return `op:${t.value}`;
    if (t.kind === "paren") return `paren:${t.value}`;
    if (t.kind === "ref") return `ref:${t.sourceId}`;
    if (t.kind === "tokenref") return `tref:${t.lineId}:${t.tokenId}`;
    if (t.kind === "globalref") return `gref:${t.globalId}`;
    return "";
  })();
  useEffect(() => {
    if (!activeLineId) return;
    const line = lines.find((l) => l.id === activeLineId);
    if (!line) return;
    // Defer to next frame so layout has settled after token mutation.
    const t = setTimeout(() => {
      let target = null;
      if (line.tokens && line.tokens.length > 0) {
        const lastTok = line.tokens[line.tokens.length - 1];
        target = chipRefs.current[`${line.id}:${lastTok.id}`];
      }
      // Fallback to the line container itself.
      if (!target && canvasRef.current) {
        target = canvasRef.current.querySelector(`[data-lineid="${line.id}"]`);
      }
      if (target && typeof target.scrollIntoView === "function") {
        try {
          target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        } catch (e) {}
      }
    }, 30);
    return () => clearTimeout(t);
  }, [activeLineId, activeLineTokenCount, lastTokSig]);

  const pushHistory = useCallback((prev) => {
    setHistory((h) => [...h.slice(-30), prev]);
  }, []);

  const mutateLines = useCallback(
    (updater) => {
      setLines((prev) => {
        pushHistory(prev);
        return updater(prev);
      });
    },
    [pushHistory]
  );

  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      setLines(h[h.length - 1]);
      return h.slice(0, -1);
    });
    setSelection(null);
    setEditing(null);
    setMenu(null);
  };

  const resolveGlobalValue = useCallback(
    (gid) => {
      const g = globals.find((g) => g.id === gid);
      return g ? g.value : null;
    },
    [globals]
  );

  const resolveValue = useCallback(
    (lineId, seen = new Set()) => {
      if (seen.has(lineId)) return null;
      seen.add(lineId);
      const line = lines.find((l) => l.id === lineId);
      if (!line) return null;
      const r = evalTokens(
        line.tokens,
        (srcId) => resolveValue(srcId, seen),
        resolveGlobalValue,
        resolveTokenValue
      );
      return r.value;
    },
    [lines, resolveGlobalValue]
  );

  // Resolve tokenref: find the token in the given line and return its value.
  // Only num tokens with a label are valid targets (internal variables); if the
  // token has lost its label, the link is considered broken.
  const resolveTokenValue = useCallback(
    (lineId, tokenId) => {
      const line = lines.find((l) => l.id === lineId);
      if (!line) return null;
      const tok = line.tokens.find((t) => t.id === tokenId);
      if (!tok || tok.kind !== "num") return null;
      const hasLabel = !!(line.labels && line.labels[tokenId]);
      if (!hasLabel) return null; // label gone → link broken
      return tok.value;
    },
    [lines]
  );

  const results = useMemo(() => {
    const r = {};
    for (const line of lines) {
      r[line.id] = evalTokens(
        line.tokens,
        (srcId) => resolveValue(srcId),
        resolveGlobalValue,
        resolveTokenValue
      );
    }
    return r;
  }, [lines, resolveValue, resolveGlobalValue, resolveTokenValue]);

  // measure chip positions for SVG lines
  useLayoutEffect(() => {
    const positions = {};
    Object.entries(chipRefs.current).forEach(([key, node]) => {
      if (node && canvasRef.current) {
        const canvasRect = canvasRef.current.getBoundingClientRect();
        const r = node.getBoundingClientRect();
        positions[key] = {
          x: r.left - canvasRect.left + r.width / 2,
          y: r.top - canvasRect.top,
          cy: r.top - canvasRect.top + r.height / 2,
          by: r.top - canvasRect.top + r.height,
          w: r.width,
          h: r.height,
        };
      }
    });
    setChipPositions(positions);
  }, [lines, selection, activeLineId]);

  // ---------- token building ----------
  const addLine = () => {
    const nl = makeLine([]);
    mutateLines((p) => [...p, nl]);
    setActiveLineId(nl.id);
    setSelection(null);
  };

  const ensureActive = () => {
    if (activeLineId) return activeLineId;
    const nl = makeLine([]);
    mutateLines((p) => [...p, nl]);
    setActiveLineId(nl.id);
    return nl.id;
  };

  const insertDigit = (d) => {
    // Case 1: A number is selected → the digit REPLACES that number (typing replaces, not appends).
    if (selection && selection.target !== "result") {
      const line = lines.find((l) => l.id === selection.lineId);
      const tok = line?.tokens.find((t) => t.id === selection.target);
      if (tok && tok.kind === "num") {
        // If this token is already being built (user already typed one digit since selecting),
        // append the new digit to the raw string.
        if (tok._building) {
          const cur = tok.raw ?? String(tok.value);
          if (d === "." && cur.includes(".")) return;
          const raw = cur + d;
          mutateLines((prev) =>
            prev.map((l) =>
              l.id === selection.lineId
                ? {
                    ...l,
                    tokens: l.tokens.map((t) =>
                      t.id === selection.target
                        ? { ...t, raw, value: parseFloat(raw) || 0, _building: true }
                        : t
                    ),
                  }
                : l
            )
          );
          return;
        }
        // First digit after selection → replace the number entirely.
        const newRaw = d === "." ? "0." : d;
        const newVal = parseFloat(newRaw) || 0;
        mutateLines((prev) =>
          prev.map((l) =>
            l.id === selection.lineId
              ? {
                  ...l,
                  tokens: l.tokens.map((t) =>
                    t.id === selection.target
                      ? { ...t, value: newVal, raw: newRaw, _building: true }
                      : t
                  ),
                }
              : l
          )
        );
        setActiveLineId(selection.lineId);
        return;
      }
    }
    // Case 2: Normal append at end of active line.
    const id = ensureActive();
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const last = l.tokens[l.tokens.length - 1];
        if (last && last.kind === "num" && last._building) {
          const raw = (last.raw ?? String(last.value)) + d;
          if (d === "." && last.raw && last.raw.includes(".")) return l;
          return {
            ...l,
            tokens: [
              ...l.tokens.slice(0, -1),
              { ...last, raw, value: parseFloat(raw) || 0 },
            ],
          };
        }
        return {
          ...l,
          tokens: [
            ...l.tokens,
            { id: uid(), kind: "num", value: parseFloat(d) || 0, raw: d, _building: true },
          ],
        };
      })
    );
  };

  const finalizeBuilding = (l) => ({
    ...l,
    tokens: l.tokens.map((t) => (t._building ? { ...t, _building: false } : t)),
  });

  // Insert a globalref token (links a global variable into the active line)
  const insertGlobalRef = (globalId) => {
    const id = ensureActive();
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const lf = finalizeBuilding(l);
        const last = lf.tokens[lf.tokens.length - 1];
        const newTok = { id: uid(), kind: "globalref", globalId };
        if (last && (last.kind === "num" || last.kind === "ref" || last.kind === "tokenref" || last.kind === "globalref")) {
          return { ...lf, tokens: [...lf.tokens, { id: uid(), kind: "op", value: "*" }, newTok] };
        }
        return { ...lf, tokens: [...lf.tokens, newTok] };
      })
    );
  };

  // Insert a ref token to a labeled token in this same document (internal var)
  const insertInternalRef = (sourceLineId, sourceTokenId) => {
    const id = ensureActive();
    if (id === sourceLineId) return; // don't self-reference
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const lf = finalizeBuilding(l);
        const last = lf.tokens[lf.tokens.length - 1];
        // If sourceTokenId is "result" → ref to whole line; else ref to specific token's value
        // For consistency we always ref the result; if user wants a specific token they can copy/paste it.
        const newTok =
          sourceTokenId === "result"
            ? { id: uid(), kind: "ref", sourceId: sourceLineId }
            : { id: uid(), kind: "ref", sourceId: sourceLineId };
        if (last && (last.kind === "num" || last.kind === "ref" || last.kind === "tokenref" || last.kind === "globalref")) {
          return { ...lf, tokens: [...lf.tokens, { id: uid(), kind: "op", value: "*" }, newTok] };
        }
        return { ...lf, tokens: [...lf.tokens, newTok] };
      })
    );
  };

  // Promote a labeled internal value to a global. Replaces the original token
  // (and all its peer refs to it inside this doc) with a globalref.
  const promoteToGlobal = async () => {
    if (!selection || !onUpsertGlobal) return;
    const line = lines.find((l) => l.id === selection.lineId);
    if (!line) return;
    const labelText =
      selection.target === "result"
        ? line.labels?.result
        : line.labels?.[selection.target];
    if (!labelText) return; // need a label to promote
    // Determine current value
    let currentValue = null;
    if (selection.target === "result") {
      currentValue = results[selection.lineId]?.value;
    } else {
      const tok = line.tokens.find((t) => t.id === selection.target);
      if (tok?.kind === "num") currentValue = tok.value;
      else if (tok?.kind === "ref") currentValue = results[tok.sourceId]?.value;
      else if (tok?.kind === "tokenref") {
        const srcLine = lines.find((l) => l.id === tok.lineId);
        const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
        currentValue = srcTok && srcTok.kind === "num" ? srcTok.value : null;
      }
    }
    if (currentValue === null || currentValue === undefined) return;
    const g = makeGlobal(labelText, currentValue);
    await onUpsertGlobal(g);
    // Tell the user via UI: switch selection? Just leave it—the promoted value
    // is now also available in the global panel.
  };

  // Save a calculation line as a reusable formula. Replaces internal refs with
  // their current numeric values (snapshot). Globals are preserved.
  const saveLineAsFormula = async (lineId, name) => {
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const formula = lineToFormula(line, results, name);
    await onUpsertFormula(formula);
  };

  // Paste a saved formula into the active line: appends its tokens to the
  // active line, or creates a new line if there isn't one.
  const pasteFormula = (formula) => {
    if (!formula) return;
    // Build new tokens with fresh ids and a labels map.
    const idMap = {};
    const newTokens = formula.tokens.map((tok) => {
      const newId = uid();
      idMap[tok.id] = newId;
      // Strip _building flag if present
      const { _building, ...clean } = tok;
      return { ...clean, id: newId };
    });
    const newLabels = {};
    if (formula.labels) {
      for (const [oldId, lbl] of Object.entries(formula.labels)) {
        if (idMap[oldId]) newLabels[idMap[oldId]] = lbl;
      }
    }
    if (activeLineId) {
      mutateLines((prev) =>
        prev.map((l) => {
          if (l.id !== activeLineId) return l;
          const lf = finalizeBuilding(l);
          // If active line has tokens already, append " × " before formula.
          const sep =
            lf.tokens.length > 0 &&
            ["num", "ref", "globalref"].includes(lf.tokens[lf.tokens.length - 1].kind)
              ? [{ id: uid(), kind: "op", value: "*" }]
              : [];
          return {
            ...lf,
            tokens: [...lf.tokens, ...sep, ...newTokens],
            labels: { ...lf.labels, ...newLabels },
          };
        })
      );
    } else {
      // Create new line
      const newLine = { id: uid(), tokens: newTokens, labels: newLabels };
      mutateLines((prev) => [...prev, newLine]);
      setActiveLineId(newLine.id);
    }
  };

  const insertOp = (op) => {
    // If a token is currently selected and it's an op, replace its value
    // in-place. This is the "tap op chip → tap another op in numpad" flow.
    if (selection && selection.target && selection.target !== "result") {
      const line = lines.find((l) => l.id === selection.lineId);
      const tok = line?.tokens.find((t) => t.id === selection.target);
      if (tok && tok.kind === "op") {
        mutateLines((prev) =>
          prev.map((l) => {
            if (l.id !== selection.lineId) return l;
            return {
              ...l,
              tokens: l.tokens.map((t) =>
                t.id === selection.target ? { ...t, value: op } : t
              ),
            };
          })
        );
        // Keep the op selected after replacement so the user can change again.
        return;
      }
    }
    // If we're editing a selected number, finalize it (keep the new value) and clear selection.
    if (selection && selection.target !== "result") {
      const line = lines.find((l) => l.id === selection.lineId);
      const tok = line?.tokens.find((t) => t.id === selection.target);
      if (tok && tok.kind === "num" && tok._building) {
        mutateLines((prev) =>
          prev.map((l) =>
            l.id === selection.lineId
              ? {
                  ...l,
                  tokens: l.tokens.map((t) =>
                    t.id === selection.target ? { ...t, _building: false } : t
                  ),
                }
              : l
          )
        );
        setSelection(null);
        // Don't also insert an op—just commit the edit, user can tap op again if needed.
        return;
      }
    }
    const id = ensureActive();
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const lf = finalizeBuilding(l);
        const last = lf.tokens[lf.tokens.length - 1];
        if (!last) return lf;
        if (last.kind === "op") {
          return {
            ...lf,
            tokens: [...lf.tokens.slice(0, -1), { id: uid(), kind: "op", value: op }],
          };
        }
        return { ...lf, tokens: [...lf.tokens, { id: uid(), kind: "op", value: op }] };
      })
    );
  };

  const insertParen = (p) => {
    const id = ensureActive();
    mutateLines((prev) =>
      prev.map((l) =>
        l.id !== id
          ? l
          : {
              ...finalizeBuilding(l),
              tokens: [...finalizeBuilding(l).tokens, { id: uid(), kind: "paren", value: p }],
            }
      )
    );
  };

  const backspace = () => {
    // If a number is selected, backspace trims its raw string.
    if (selection && selection.target !== "result") {
      const line = lines.find((l) => l.id === selection.lineId);
      const tok = line?.tokens.find((t) => t.id === selection.target);
      if (tok && tok.kind === "num") {
        const raw = (tok.raw ?? String(tok.value)).slice(0, -1);
        if (raw === "" || raw === "-") {
          // Remove the token entirely and clear selection.
          mutateLines((prev) =>
            prev.map((l) =>
              l.id === selection.lineId
                ? { ...l, tokens: l.tokens.filter((t) => t.id !== selection.target) }
                : l
            )
          );
          setSelection(null);
          return;
        }
        mutateLines((prev) =>
          prev.map((l) =>
            l.id === selection.lineId
              ? {
                  ...l,
                  tokens: l.tokens.map((t) =>
                    t.id === selection.target
                      ? { ...t, raw, value: parseFloat(raw) || 0, _building: true }
                      : t
                  ),
                }
              : l
          )
        );
        return;
      }
    }
    if (!activeLineId) return;
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== activeLineId) return l;
        if (!l.tokens.length) return l;
        const last = l.tokens[l.tokens.length - 1];
        if (last.kind === "num" && last.raw && last.raw.length > 1) {
          const raw = last.raw.slice(0, -1);
          return {
            ...l,
            tokens: [
              ...l.tokens.slice(0, -1),
              { ...last, raw, value: parseFloat(raw) || 0, _building: true },
            ],
          };
        }
        return { ...l, tokens: l.tokens.slice(0, -1) };
      })
    );
  };

  // Square-X button: deletes the *last* token (or the currently selected
  // token if any), not the whole line. The user can tap multiple times to
  // chain-delete tokens. Use long-press behavior would clear the whole line
  // — but for now keep it simple: one tap = one token gone.
  const clearLine = () => {
    // If a token is selected, remove that token.
    if (selection && selection.target && selection.target !== "result" && selection.kind !== "global" && selection.kind !== "line") {
      mutateLines((prev) =>
        prev.map((l) =>
          l.id === selection.lineId
            ? { ...l, tokens: l.tokens.filter((t) => t.id !== selection.target) }
            : l
        )
      );
      setSelection(null);
      return;
    }
    if (!activeLineId) return;
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== activeLineId) return l;
        if (!l.tokens.length) return l;
        return { ...l, tokens: l.tokens.slice(0, -1) };
      })
    );
  };

  const equals = () => {
    if (!activeLineId) return;
    // commit current line, then add a fresh empty line after it
    let newLineId = null;
    mutateLines((prev) => {
      const committed = prev.map((l) => (l.id === activeLineId ? finalizeBuilding(l) : l));
      const idx = committed.findIndex((l) => l.id === activeLineId);
      const nl = makeLine([]);
      newLineId = nl.id;
      return [...committed.slice(0, idx + 1), nl, ...committed.slice(idx + 1)];
    });
    setTimeout(() => newLineId && setActiveLineId(newLineId), 0);
  };

  const toggleSign = () => {
    if (selection && selection.target !== "result") {
      const line = lines.find((l) => l.id === selection.lineId);
      const tok = line?.tokens.find((t) => t.id === selection.target);
      if (tok && tok.kind === "num") {
        const raw = tok.raw?.startsWith("-")
          ? tok.raw.slice(1)
          : "-" + (tok.raw ?? String(tok.value));
        mutateLines((prev) =>
          prev.map((l) =>
            l.id === selection.lineId
              ? {
                  ...l,
                  tokens: l.tokens.map((t) =>
                    t.id === selection.target ? { ...t, value: -tok.value, raw } : t
                  ),
                }
              : l
          )
        );
        return;
      }
    }
    if (!activeLineId) return;
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== activeLineId) return l;
        const last = l.tokens[l.tokens.length - 1];
        if (last && last.kind === "num") {
          const newRaw = last.raw?.startsWith("-") ? last.raw.slice(1) : "-" + (last.raw ?? String(last.value));
          return {
            ...l,
            tokens: [...l.tokens.slice(0, -1), { ...last, value: -last.value, raw: newRaw }],
          };
        }
        return l;
      })
    );
  };

  // ---------- menu ----------
  const onChipLongPress = (lineId, target, anchorRect) => {
    setSelection({ lineId, target });
    setMenu({
      x: anchorRect.left + anchorRect.width / 2,
      y: anchorRect.top - 10,
    });
    setActiveLineId(lineId);
  };

  const closeMenu = () => setMenu(null);

  const copySelection = () => {
    if (!selection) return closeMenu();

    // Helper to write a string to the OS clipboard (best-effort).
    const writeToOSClipboard = (text) => {
      if (!text) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(() => {});
          return;
        }
      } catch (e) {}
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) {}
    };

    // Resolve the displayed value & optional label of the current selection,
    // so we can also place it on the OS clipboard for pasting outside the app.
    let displayValue = null;
    let displayLabel = null;

    // Whole line selected — copy all tokens (with internal refs resolved to
    // literal numbers, globalrefs preserved as live links). Also place a
    // human-readable rendering on the OS clipboard.
    if (selection.kind === "line") {
      const line = lines.find((l) => l.id === selection.lineId);
      if (!line || !line.tokens || line.tokens.length === 0) return closeMenu();
      const resolvedTokens = line.tokens.map((tk) => {
        if (tk.kind === "ref") {
          const v = results[tk.sourceId]?.value;
          return { id: uid(), kind: "num", value: (v === null || v === undefined || Number.isNaN(v)) ? 0 : v };
        }
        if (tk.kind === "tokenref") {
          const srcLine = lines.find((l) => l.id === tk.lineId);
          const srcTok = srcLine?.tokens.find((t) => t.id === tk.tokenId);
          const v = srcTok && srcTok.kind === "num" ? srcTok.value : null;
          return { id: uid(), kind: "num", value: (v === null || v === undefined || Number.isNaN(v)) ? 0 : v };
        }
        // Re-id to avoid collisions when pasting back into the same doc.
        return { ...tk, id: uid() };
      });
      setClipboard({ kind: "line-tokens", tokens: resolvedTokens, labels: { ...(line.labels || {}) } });

      // Build a plain-text rendering for the OS clipboard, using the same
      // formatting conventions as the share panel:
      //   - line name (label.result) in *single-asterisk bold* at the top
      //   - each token's label in (_underscore_) right after its value
      //   - the result in *bold* at the end
      //   - operators rendered as × ÷ etc.
      let osText = "";
      try {
        const withLabel = (valStr, lbl) => (lbl ? `${valStr} (_${lbl}_)` : valStr);
        const parts = line.tokens.map((tk) => {
          if (tk.kind === "num") {
            const lbl = line.labels?.[tk.id];
            return withLabel(fmt(tk.value), lbl);
          }
          if (tk.kind === "op") {
            return tk.value === "*" ? "×" : tk.value === "/" ? "÷" : tk.value;
          }
          if (tk.kind === "paren") return tk.value;
          if (tk.kind === "ref") {
            const sourceLine = lines.find((l) => l.id === tk.sourceId);
            const lbl = sourceLine?.labels?.result || line.labels?.[tk.id];
            const v = results[tk.sourceId]?.value;
            const valStr = v !== null && v !== undefined ? fmt(v) : "?";
            return withLabel(valStr, lbl);
          }
          if (tk.kind === "tokenref") {
            const sourceLine = lines.find((l) => l.id === tk.lineId);
            const sourceTok = sourceLine?.tokens.find((t) => t.id === tk.tokenId);
            const lbl = sourceLine?.labels?.[tk.tokenId] || line.labels?.[tk.id];
            const v = sourceTok && sourceTok.kind === "num" ? sourceTok.value : null;
            const valStr = v !== null && v !== undefined ? fmt(v) : "?";
            return withLabel(valStr, lbl);
          }
          if (tk.kind === "globalref") {
            const g = globals.find((x) => x.id === tk.globalId);
            if (g) return withLabel(fmt(g.value), g.name);
            return "?";
          }
          return "";
        });
        const r = results[selection.lineId];
        const resLabel = line.labels?.result;
        const exprText = parts.join(" ");
        let bodyLine = exprText;
        if (r && r.value !== null && r.value !== undefined) {
          const resStr = `*${fmt(r.value)}*`;
          // Add (_label_) to the result if labels.result is set.
          const resWithLabel = resLabel ? `${resStr} (_${resLabel}_)` : resStr;
          bodyLine = `${exprText} = ${resWithLabel}`;
        }
        // If the line has a name, put it as a *bold* heading on its own line
        // (mirrors how the file name is rendered when sharing the whole doc).
        const lineName = line.name;
        osText = lineName ? `*${lineName}*\n${bodyLine}` : bodyLine;
        writeToOSClipboard(osText);
      } catch (e) {}

      setCopyToast(osText ? "línea copiada" : "copiada");
      closeMenu();
      return;
    }

    // Global variable selected from the panel.
    if (selection.kind === "global") {
      const g = globals.find((x) => x.id === selection.globalId);
      if (g && g.kind === "line") {
        // Line global — copy its tokens into the line-tokens clipboard so it
        // can be pasted as a new line via the paste button. Build OS clipboard
        // text using the same formatting as line copy.
        if (!g.tokens || g.tokens.length === 0) return closeMenu();
        const resolvedTokens = g.tokens.map((tk) => ({ ...tk, id: uid() }));
        setClipboard({ kind: "line-tokens", tokens: resolvedTokens, labels: {} });

        let osText = "";
        try {
          const withLabel = (valStr, lbl) => (lbl ? `${valStr} (_${lbl}_)` : valStr);
          const parts = g.tokens.map((tk) => {
            if (tk.kind === "num") return fmt(tk.value);
            if (tk.kind === "op") {
              return tk.value === "*" ? "×" : tk.value === "/" ? "÷" : tk.value;
            }
            if (tk.kind === "paren") return tk.value;
            if (tk.kind === "globalref") {
              const gg = globals.find((x) => x.id === tk.globalId);
              if (gg) return withLabel(fmt(gg.value), gg.name);
              return "?";
            }
            return "";
          });
          osText = `*${g.name}*\n${parts.join(" ")}`;
          writeToOSClipboard(osText);
        } catch (e) {}
        setCopyToast("línea copiada");
        closeMenu();
        return;
      }
      if (g) {
        displayValue = fmt(g.value);
        displayLabel = g.name;
      }
      setClipboard({ kind: "globalref", globalId: selection.globalId });
    } else if (selection.target === "result") {
      const r = results[selection.lineId];
      if (r && r.value !== null && r.value !== undefined) {
        displayValue = fmt(r.value);
      }
      const srcLine = lines.find((l) => l.id === selection.lineId);
      displayLabel = srcLine?.labels?.result || null;
      setClipboard({ kind: "ref", sourceId: selection.lineId });
    } else {
      const line = lines.find((l) => l.id === selection.lineId);
      const tok = line?.tokens.find((t) => t.id === selection.target);
      if (!tok) return closeMenu();
      displayLabel = line.labels?.[selection.target] || null;
      if (tok.kind === "num") {
        displayValue = fmt(tok.value);
        // If this num has a label, it's an internal variable. Copy as a
        // tokenref so the paste creates a live link instead of a literal.
        const hasLabel = !!(line.labels && line.labels[selection.target]);
        if (hasLabel) {
          setClipboard({ kind: "tokenref", lineId: selection.lineId, tokenId: selection.target });
        } else {
          setClipboard({ kind: "num", value: tok.value });
        }
      } else if (tok.kind === "ref") {
        const r = results[tok.sourceId];
        if (r && r.value !== null && r.value !== undefined) displayValue = fmt(r.value);
        const srcLine = lines.find((l) => l.id === tok.sourceId);
        if (!displayLabel) displayLabel = srcLine?.labels?.result || null;
        setClipboard({ kind: "ref", sourceId: tok.sourceId });
      } else if (tok.kind === "tokenref") {
        const srcLine = lines.find((l) => l.id === tok.lineId);
        const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
        const v = srcTok && srcTok.kind === "num" ? srcTok.value : null;
        if (v !== null && v !== undefined) displayValue = fmt(v);
        if (!displayLabel) displayLabel = srcLine?.labels?.[tok.tokenId] || null;
        setClipboard({ kind: "tokenref", lineId: tok.lineId, tokenId: tok.tokenId });
      } else if (tok.kind === "globalref") {
        const g = globals.find((x) => x.id === tok.globalId);
        if (g) {
          displayValue = fmt(g.value);
          if (!displayLabel) displayLabel = g.name;
        }
        setClipboard({ kind: "globalref", globalId: tok.globalId });
      }
    }

    if (displayValue !== null) {
      const osText = displayLabel ? `${displayValue} (_${displayLabel}_)` : displayValue;
      writeToOSClipboard(osText);
      setCopyToast("copiado");
    }

    closeMenu();
  };

  const pasteClipboard = () => {
    if (!clipboard || !activeLineId) return closeMenu();

    // Pasting a copied whole line — insert as a NEW line below the active one.
    if (clipboard.kind === "line-tokens") {
      const newLine = {
        id: uid(),
        tokens: clipboard.tokens.map((tk) => ({ ...tk, id: uid() })),
        labels: { ...(clipboard.labels || {}) },
      };
      // Drop the result label from the source — would collide / not meaningful here.
      delete newLine.labels.result;
      mutateLines((prev) => {
        const idx = prev.findIndex((l) => l.id === activeLineId);
        if (idx < 0) return [...prev, newLine];
        const next = prev.slice();
        next.splice(idx + 1, 0, newLine);
        return next;
      });
      setActiveLineId(newLine.id);
      closeMenu();
      return;
    }

    let newTok;
    if (clipboard.kind === "ref") newTok = { id: uid(), kind: "ref", sourceId: clipboard.sourceId };
    else if (clipboard.kind === "tokenref") newTok = { id: uid(), kind: "tokenref", lineId: clipboard.lineId, tokenId: clipboard.tokenId };
    else if (clipboard.kind === "globalref") newTok = { id: uid(), kind: "globalref", globalId: clipboard.globalId };
    else newTok = { id: uid(), kind: "num", value: clipboard.value, raw: String(clipboard.value) };
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== activeLineId) return l;
        const lf = finalizeBuilding(l);
        const last = lf.tokens[lf.tokens.length - 1];
        if (last && (last.kind === "num" || last.kind === "ref" || last.kind === "tokenref" || last.kind === "globalref")) {
          return {
            ...lf,
            tokens: [...lf.tokens, { id: uid(), kind: "op", value: "*" }, newTok],
          };
        }
        return { ...lf, tokens: [...lf.tokens, newTok] };
      })
    );
    closeMenu();
  };

  const deleteSelection = () => {
    if (!selection) return closeMenu();
    if (selection.kind === "global") {
      // Don't allow deleting globals from inside calculator selection — use globals manager.
      closeMenu();
      return;
    }
    if (selection.target === "result") {
      mutateLines((prev) => prev.filter((l) => l.id !== selection.lineId));
      if (activeLineId === selection.lineId) setActiveLineId(null);
    } else {
      mutateLines((prev) =>
        prev.map((l) =>
          l.id === selection.lineId
            ? { ...l, tokens: l.tokens.filter((t) => t.id !== selection.target) }
            : l
        )
      );
    }
    setSelection(null);
    closeMenu();
  };

  const openLabelEditor = () => {
    // Target a specific token (or the result chip) based on selection.
    const lineId = selection?.lineId || activeLineId;
    const target = selection?.target || "result";
    if (!lineId) return closeMenu();
    setLabelEditor({ lineId, target });
    closeMenu();
  };

  const saveLabel = (text) => {
    if (!labelEditor) return;
    mutateLines((prev) =>
      prev.map((l) => {
        if (l.id !== labelEditor.lineId) return l;
        const labels = { ...(l.labels || {}) };
        if (text.trim() === "") delete labels[labelEditor.target];
        else labels[labelEditor.target] = text;
        return { ...l, labels };
      })
    );
    setLabelEditor(null);
  };

  // ---------- number inline edit ----------
  const startEditNumber = (lineId, tokenId) => {
    const line = lines.find((l) => l.id === lineId);
    const tok = line?.tokens.find((t) => t.id === tokenId);
    if (!tok || tok.kind !== "num") return;
    setEditing({ lineId, tokenId, buffer: tok.raw ?? String(tok.value) });
    setActiveLineId(lineId);
  };

  const commitEditNumber = () => {
    if (!editing) return;
    const v = parseFloat(editing.buffer);
    if (!isNaN(v)) {
      mutateLines((prev) =>
        prev.map((l) =>
          l.id === editing.lineId
            ? {
                ...l,
                tokens: l.tokens.map((t) =>
                  t.id === editing.tokenId ? { ...t, value: v, raw: editing.buffer } : t
                ),
              }
            : l
        )
      );
    }
    setEditing(null);
  };

  // ---------- drag & drop (new pick-up model) ----------
  // Called when the user has held a chip long enough to "pick it up".
  // Starts a drag session with ghost visible.
  const onChipPickUp = (lineId, target, x, y) => {
    suppressNextRootClick.current = true;
    let tokenSpec;
    if (target === "result") {
      tokenSpec = { kind: "ref", sourceId: lineId };
    } else {
      const line = lines.find((l) => l.id === lineId);
      const tok = line?.tokens.find((t) => t.id === target);
      if (!tok) return;
      if (tok.kind === "num") {
        // If this num has a label (it's an internal variable), create a tokenref
        // so the drop creates a live link instead of a literal copy.
        const hasLabel = !!(line?.labels && line.labels[target]);
        if (hasLabel) {
          tokenSpec = { kind: "tokenref", lineId, tokenId: target };
        } else {
          tokenSpec = { kind: "num", value: tok.value };
        }
      }
      else if (tok.kind === "ref") tokenSpec = { kind: "ref", sourceId: tok.sourceId };
      else if (tok.kind === "tokenref") tokenSpec = { kind: "tokenref", lineId: tok.lineId, tokenId: tok.tokenId };
      else if (tok.kind === "globalref") tokenSpec = { kind: "globalref", globalId: tok.globalId };
      else return;
    }
    const dragColor =
      tokenSpec.kind === "ref"
        ? getLineColor(lines, tokenSpec.sourceId, darkMode)
        : tokenSpec.kind === "tokenref"
        ? getLineColor(lines, tokenSpec.lineId, darkMode)
        : tokenSpec.kind === "globalref"
        ? (theme.accent || "#ADD010")
        : getLineColor(lines, lineId, darkMode);
    let dragText;
    if (tokenSpec.kind === "ref") {
      dragText = fmt(results[tokenSpec.sourceId]?.value);
    } else if (tokenSpec.kind === "tokenref") {
      const srcLine = lines.find((l) => l.id === tokenSpec.lineId);
      const srcTok = srcLine?.tokens.find((t) => t.id === tokenSpec.tokenId);
      dragText = srcTok ? fmt(srcTok.value) : "—";
    } else if (tokenSpec.kind === "globalref") {
      const g = globals.find((x) => x.id === tokenSpec.globalId);
      dragText = g ? fmt(g.value) : "—";
    } else {
      dragText = fmt(tokenSpec.value);
    }
    setDrag({
      sourceLineId: lineId,
      sourceTarget: target,
      token: tokenSpec,
      x,
      y,
      color: dragColor,
      text: dragText,
    });
  };

  const onChipDragMove = (x, y) => {
    setDrag((d) => (d ? { ...d, x, y } : null));
  };

  const onChipDragEnd = (x, y) => {
    suppressNextRootClick.current = true;
    if (!drag) return;
    const el = document.elementFromPoint(x, y);
    let targetLineId = null;
    let n = el;
    while (n && n !== document.body) {
      if (n.dataset && n.dataset.lineid) {
        targetLineId = n.dataset.lineid;
        break;
      }
      n = n.parentElement;
    }

    // Build the token to insert from the drag spec.
    const buildTok = () => {
      if (drag.token.kind === "ref") return { id: uid(), kind: "ref", sourceId: drag.token.sourceId };
      if (drag.token.kind === "tokenref") return { id: uid(), kind: "tokenref", lineId: drag.token.lineId, tokenId: drag.token.tokenId };
      if (drag.token.kind === "globalref") return { id: uid(), kind: "globalref", globalId: drag.token.globalId };
      return { id: uid(), kind: "num", value: drag.token.value, raw: String(drag.token.value) };
    };

    if (targetLineId && targetLineId !== drag.sourceLineId) {
      // Drop over an existing line → append to that line.
      const newTok = buildTok();
      mutateLines((prev) =>
        prev.map((l) => {
          if (l.id !== targetLineId) return l;
          const lf = finalizeBuilding(l);
          const last = lf.tokens[lf.tokens.length - 1];
          if (last && (last.kind === "num" || last.kind === "ref" || last.kind === "tokenref" || last.kind === "globalref")) {
            return {
              ...lf,
              tokens: [...lf.tokens, { id: uid(), kind: "op", value: "*" }, newTok],
            };
          }
          return { ...lf, tokens: [...lf.tokens, newTok] };
        })
      );
      setActiveLineId(targetLineId);
    } else if (!targetLineId) {
      // Drop in empty canvas area → check if it's within the canvas and create a new line.
      let inCanvas = false;
      let nn = el;
      while (nn && nn !== document.body) {
        if (nn === canvasRef.current) {
          inCanvas = true;
          break;
        }
        nn = nn.parentElement;
      }
      if (inCanvas) {
        const newTok = buildTok();
        const newLine = { id: uid(), tokens: [newTok], labels: {} };
        mutateLines((prev) => [...prev, newLine]);
        setActiveLineId(newLine.id);
      }
    }
    setDrag(null);
  };

  // ---------- connections ----------
  const connections = useMemo(() => {
    const list = [];
    for (const line of lines) {
      for (const tok of line.tokens) {
        if (tok.kind === "ref") {
          list.push({
            fromKey: `${tok.sourceId}:result`,
            toKey: `${line.id}:${tok.id}`,
            id: `${line.id}-${tok.id}`,
            sourceLineId: tok.sourceId,
            targetLineId: line.id,
            targetTokenId: tok.id,
          });
        } else if (tok.kind === "tokenref") {
          list.push({
            fromKey: `${tok.lineId}:${tok.tokenId}`,
            toKey: `${line.id}:${tok.id}`,
            id: `${line.id}-${tok.id}`,
            sourceLineId: tok.lineId,
            targetLineId: line.id,
            targetTokenId: tok.id,
          });
        }
      }
    }
    return list;
  }, [lines]);

  // ---------- render ----------
  return (
    <div
      className="w-full flex flex-col"
      style={{
        height: "100dvh",
        maxHeight: "100dvh",
        overflow: "hidden",
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontVariantNumeric: "lining-nums tabular-nums",
        background: theme.bg,
        color: theme.text,
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        touchAction: drag ? "none" : "auto",
        transition: "background 0.25s, color 0.25s",
      }}
      onClick={(e) => {
        if (suppressNextRootClick.current) {
          suppressNextRootClick.current = false;
          return;
        }
        // Detect if click landed inside the canvas (the area between toolbar
        // and selection bar) but NOT on a specific line. That's "tap below
        // the lines" and should create a new empty line.
        const canvasEl = canvasRef.current;
        const targetEl = e.target;
        const isInsideCanvas = canvasEl && canvasEl.contains(targetEl);
        // A line wraps everything in a div with data-lineid; if the target's
        // closest ancestor with data-lineid exists, it's a line tap (already
        // handled by LineView).
        const onLine = isInsideCanvas && targetEl.closest && targetEl.closest("[data-lineid]");
        if (isInsideCanvas && !onLine) {
          // Tap on canvas surface (not on any line) → create a new empty line
          // (or focus the existing empty last line).
          const lastLine = lines[lines.length - 1];
          if (lastLine && (!lastLine.tokens || lastLine.tokens.length === 0)) {
            setActiveLineId(lastLine.id);
            setSelection(null);
            if (editing) commitEditNumber();
            return;
          }
          let newId = null;
          mutateLines((prev) => {
            const committed = activeLineId
              ? prev.map((l) => (l.id === activeLineId ? finalizeBuilding(l) : l))
              : prev;
            const nl = makeLine([]);
            newId = nl.id;
            return [...committed, nl];
          });
          setSelection(null);
          if (editing) commitEditNumber();
          setTimeout(() => newId && setActiveLineId(newId), 0);
          return;
        }
        closeMenu();
        setSelection(null);
        if (editing) commitEditNumber();
      }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center px-3 py-2"
        style={{
          borderBottom: `1px solid ${theme.toolbarBorder}`,
          background: theme.toolbar,
          gap: 6,
          flexDirection: theme.leftHanded ? "row-reverse" : "row",
          paddingTop: "calc(env(safe-area-inset-top) + 8px)",
          transition: "background 0.25s, border-color 0.25s",
        }}
      >
        {/* Back to docs list */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onBack && onBack();
          }}
          style={{ background: "transparent", border: "none", padding: 6, cursor: "pointer" }}
          aria-label="Volver"
        >
          <CaretLeft size={22} style={{ color: theme.accentOnWhite }} weight="bold" />
        </button>
        {/* Settings (opens popup with dark mode etc) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowSettings(true);
          }}
          style={{ background: "transparent", border: "none", padding: 6, cursor: "pointer" }}
          aria-label="Configuración"
        >
          <Gear size={22} style={{ color: theme.accentOnWhite }} weight="bold" />
        </button>

        {/* Document name input — fills the center */}
        <input
          value={docName}
          onChange={(e) => setDocName(e.target.value)}
          placeholder="Sin título"
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onFocus={(e) => {
            // Select all on focus for easy rename
            if (docName === "Sin título") e.target.select();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            outline: "none",
            textAlign: "center",
            fontSize: 17,
            color: theme.accentOnWhite,
            fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontWeight: 400,
            letterSpacing: "0.01em",
            padding: "6px 8px",
            userSelect: "text",
            WebkitUserSelect: "text",
            cursor: "text",
            touchAction: "auto",
          }}
        />

        {/* Right cluster: undo / tag / new line */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            undo();
          }}
          disabled={!history.length}
          style={{ background: "transparent", border: "none", padding: 6, cursor: "pointer" }}
          aria-label="Deshacer"
        >
          <ArrowUUpLeft
            size={22}
            style={{ color: history.length ? theme.accentOnWhite : theme.textFaint }}
            weight="bold"
          />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setKeypadHidden((v) => !v);
          }}
          style={{ background: "transparent", border: "none", padding: 6, cursor: "pointer" }}
          aria-label={keypadHidden ? "Mostrar teclado" : "Ocultar teclado"}
          title={keypadHidden ? "Mostrar teclado" : "Ocultar teclado"}
        >
          {keypadHidden ? (
            <EyeSlash size={22} style={{ color: theme.accentOnWhite }} weight="bold" />
          ) : (
            <Eye size={22} style={{ color: theme.accentOnWhite }} weight="bold" />
          )}
        </button>
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="flex-1 relative"
        style={{ padding: "8px 12px 8px", overflowY: "auto", overflowX: "auto", minHeight: 0 }}
      >
        <svg
          style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", zIndex: 1, pointerEvents: "none" }}
        >
          {connections.map((c) => {
            const from = chipPositions[c.fromKey];
            const to = chipPositions[c.toKey];
            if (!from || !to) return null;
            // Only render connections involving the currently selected token/result.
            // - If selected token is a ref → show its arrow back to source.
            // - If selected target is a result → show all arrows feeding from this line.
            // - If selected token is a labeled internal value → show arrows it feeds (forward).
            let visible = false;
            if (selection && selection.kind !== "global") {
              if (
                selection.target === "result" &&
                c.sourceLineId === selection.lineId
              ) {
                visible = true;
              }
              // Selected token IS the ref destination → show its incoming arrow.
              if (
                selection.target !== "result" &&
                c.targetLineId === selection.lineId &&
                c.targetTokenId === selection.target
              ) {
                visible = true;
              }
            }
            if (!visible) return null;
            const fromY = from.by;
            const toY = to.y;
            const cp1y = fromY + Math.abs(toY - fromY) * 0.5;
            const cp2y = toY - Math.abs(toY - fromY) * 0.5;
            const path = `M ${from.x} ${fromY} C ${from.x} ${cp1y}, ${to.x} ${cp2y}, ${to.x} ${toY - 4}`;
            const connColor = getLineColor(lines, c.sourceLineId, darkMode);
            return (
              <g key={c.id}>
                <path d={path} stroke={connColor} strokeWidth="1.4" fill="none" opacity="0.55" />
                <polygon
                  points={`${to.x - 4},${toY - 6} ${to.x + 4},${toY - 6} ${to.x},${toY - 1}`}
                  fill={connColor}
                  opacity="0.75"
                />
              </g>
            );
          })}
        </svg>

        {lines.map((line) => (
          <LineView
            key={line.id}
            line={line}
            result={results[line.id]}
            isActive={activeLineId === line.id}
            selection={selection}
            editing={editing}
            setActiveLine={() => {
              if (suppressNextRootClick.current) {
                suppressNextRootClick.current = false;
                return;
              }
              setActiveLineId(line.id);
              // Empty-area tap on a line with content → select the whole line.
              // Empty line → just clear selection.
              if (line.tokens && line.tokens.length > 0) {
                setSelection({ kind: "line", lineId: line.id });
              } else {
                setSelection(null);
              }
            }}
            onChipLongPress={onChipLongPress}
            onChipPickUp={onChipPickUp}
            onChipDragMove={onChipDragMove}
            onChipDragEnd={onChipDragEnd}
            onChipTap={(lid, target) => {
              suppressNextRootClick.current = true;
              // Self-clear in case click never fires (e.g. on desktop).
              setTimeout(() => { suppressNextRootClick.current = false; }, 400);
              setActiveLineId(lid);
              setSelection({ lineId: lid, target });
            }}
            startEditNumber={startEditNumber}
            onEditChange={(buf) => setEditing((e) => ({ ...e, buffer: buf }))}
            commitEditNumber={commitEditNumber}
            chipRefs={chipRefs}
            refValueOf={(srcId) => results[srcId]?.value}
            tokenRefValueOf={(srcLineId, srcTokenId) => {
              const src = lines.find((l) => l.id === srcLineId);
              if (!src) return null;
              const tk = src.tokens.find((t) => t.id === srcTokenId);
              if (!tk || tk.kind !== "num") return null;
              const hasLabel = !!(src.labels && src.labels[srcTokenId]);
              if (!hasLabel) return null; // link broken
              return tk.value;
            }}
            globalValueOf={(gid) => {
              const g = globals.find((x) => x.id === gid);
              return g ? g.value : null;
            }}
            globalLabelOf={(gid) => {
              const g = globals.find((x) => x.id === gid);
              return g ? g.name : null;
            }}
            refLabelOf={(srcId) => {
              const src = lines.find((l) => l.id === srcId);
              return src?.labels?.result || null;
            }}
            tokenRefLabelOf={(srcLineId, srcTokenId) => {
              const src = lines.find((l) => l.id === srcLineId);
              return src?.labels?.[srcTokenId] || null;
            }}
            colorOf={(srcId) => getLineColor(lines, srcId, darkMode)}
            lineColor={getLineColor(lines, line.id, darkMode)}
            theme={theme}
          />
        ))}

        <div style={{ height: 24 }} />
      </div>

      {/* Drag ghost */}
      {drag && (
        <div
          style={{
            position: "fixed",
            left: drag.x - 30,
            top: drag.y - 22,
            padding: "8px 18px",
            borderRadius: 12,
            background: drag.color || "#ADD010",
            color: "#000",
            fontSize: 24,
            fontWeight: 500,
            fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            boxShadow: `0 16px 40px ${drag.color || "#ADD010"}88, 0 2px 6px rgba(0,0,0,0.2)`,
            pointerEvents: "none",
            zIndex: 100,
            transform: "rotate(-4deg) scale(1.1)",
          }}
        >
          {drag.text}
        </div>
      )}

      {menu && (
        <ChipMenu
          x={menu.x}
          y={menu.y}
          onCopy={copySelection}
          onPaste={pasteClipboard}
          onDelete={deleteSelection}
          onLabel={openLabelEditor}
          canPaste={!!clipboard}
        />
      )}

      {labelEditor && (
        <LabelEditor
          initial={
            lines.find((l) => l.id === labelEditor.lineId)?.labels?.[labelEditor.target] || ""
          }
          onSave={saveLabel}
          onCancel={() => setLabelEditor(null)}
          theme={theme}
        />
      )}

      {showSettings && (
        <SettingsPopup
          settings={settings}
          updateSetting={updateSetting}
          onClose={() => setShowSettings(false)}
          theme={theme}
          darkMode={darkMode}
        />
      )}

      {!keypadHidden && (
        <>
          {copyToast && (
            <div
              style={{
                position: "fixed",
                bottom: 80,
                left: "50%",
                transform: "translateX(-50%)",
                background: "#000",
                color: "#fff",
                padding: "8px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                zIndex: 100,
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              {copyToast}
            </div>
          )}
          {(() => {
            // Hide the selection bar entirely when an op chip is selected —
            // there's nothing useful to show or do from the bar in that case.
            if (selection && selection.target && selection.target !== "result" && selection.kind !== "global" && selection.kind !== "line") {
              const selLine = lines.find((l) => l.id === selection.lineId);
              const selTok = selLine?.tokens.find((t) => t.id === selection.target);
              if (selTok && selTok.kind === "op") return null;
            }
            return (
          <SelectionBar
            selection={selection}
            lines={lines}
            results={results}
            clipboard={clipboard}
            onCopy={copySelection}
            onPaste={pasteClipboard}
        onPromote={promoteToGlobal}
        canPromote={(() => {
          if (!selection) return false;
          if (selection.kind === "global") return false; // already global
          const line = lines.find((l) => l.id === selection.lineId);
          if (!line) return false;
          const tok = line.tokens.find((t) => t.id === selection.target);
          if (tok?.kind === "globalref") return false;
          const labelText =
            selection.target === "result"
              ? line.labels?.result
              : line.labels?.[selection.target];
          return !!labelText;
        })()}
        onLabelChange={(text) => {
          if (!selection) return;
          // If selection is a global, update the global's name.
          if (selection.kind === "global") {
            const g = globals.find((x) => x.id === selection.globalId);
            if (g && onUpsertGlobal) {
              onUpsertGlobal({ ...g, name: text });
            }
            return;
          }
          // Whole line selected: edit line.name (the line variable's name),
          // independent from labels.result (the result-token's label).
          if (selection.kind === "line") {
            setLines((prev) =>
              prev.map((l) => {
                if (l.id !== selection.lineId) return l;
                const trimmed = text.trim();
                if (trimmed === "") {
                  // Remove name entirely.
                  const next = { ...l };
                  delete next.name;
                  return next;
                }
                return { ...l, name: text };
              })
            );
            return;
          }
          // Otherwise update the local label on the token.
          // Don't push to undo history per keystroke — labels are non-destructive.
          setLines((prev) =>
            prev.map((l) => {
              if (l.id !== selection.lineId) return l;
              const labels = { ...(l.labels || {}) };
              if (text.trim() === "") delete labels[selection.target];
              else labels[selection.target] = text;
              return { ...l, labels };
            })
          );
        }}
        theme={theme}
        getLabel={(s) => {
          if (!s) return null;
          if (s.kind === "global") {
            const g = globals.find((x) => x.id === s.globalId);
            return g?.name || null;
          }
          const line = lines.find((l) => l.id === s.lineId);
          if (!line) return null;
          if (s.target === "result") return line.labels?.result || null;
          const tok = line.tokens.find((t) => t.id === s.target);
          if (!tok) return null;
          if (line.labels?.[tok.id]) return line.labels[tok.id];
          if (tok.kind === "ref") {
            const src = lines.find((l) => l.id === tok.sourceId);
            return src?.labels?.result || null;
          }
          if (tok.kind === "tokenref") {
            const src = lines.find((l) => l.id === tok.lineId);
            return src?.labels?.[tok.tokenId] || null;
          }
          if (tok.kind === "globalref") {
            const g = globals.find((x) => x.id === tok.globalId);
            return g?.name || null;
          }
          return null;
        }}
        getValue={(s) => {
          if (!s) return null;
          if (s.kind === "global") {
            const g = globals.find((x) => x.id === s.globalId);
            return g?.value;
          }
          if (s.target === "result") return results[s.lineId]?.value;
          const line = lines.find((l) => l.id === s.lineId);
          const tok = line?.tokens.find((t) => t.id === s.target);
          if (!tok) return null;
          if (tok.kind === "num") return tok.value;
          if (tok.kind === "ref") return results[tok.sourceId]?.value;
          if (tok.kind === "tokenref") {
            const srcLine = lines.find((l) => l.id === tok.lineId);
            const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
            return srcTok && srcTok.kind === "num" ? srcTok.value : null;
          }
          if (tok.kind === "globalref") {
            const g = globals.find((x) => x.id === tok.globalId);
            return g?.value;
          }
          return null;
        }}
        getColor={(s) => {
          if (!s) return null;
          if (s.kind === "global") return theme.accent || "#ADD010";
          if (s.target === "result") return getLineColor(lines, s.lineId, darkMode);
          const line = lines.find((l) => l.id === s.lineId);
          const tok = line?.tokens.find((t) => t.id === s.target);
          if (tok?.kind === "ref") return getLineColor(lines, tok.sourceId, darkMode);
          if (tok?.kind === "tokenref") return getLineColor(lines, tok.lineId, darkMode);
          if (tok?.kind === "globalref") return theme.accent || "#ADD010";
          return null;
        }}
        canBreakLink={(() => {
          if (!selection || selection.kind === "global") return false;
          // Whole-line selection — only if line has at least one ref/tokenref/globalref.
          if (selection.kind === "line") {
            const line = lines.find((l) => l.id === selection.lineId);
            if (!line) return false;
            return line.tokens.some((t) => t.kind === "ref" || t.kind === "tokenref" || t.kind === "globalref");
          }
          const line = lines.find((l) => l.id === selection.lineId);
          if (!line) return false;
          // Result chip — only if it has a label to remove.
          if (selection.target === "result") {
            return !!(line.labels && line.labels.result);
          }
          // Token chip:
          //   - ref/tokenref/globalref → always (resolve to literal)
          //   - num with a label → enabled (label can be removed)
          //   - num without label → no
          const tok = line.tokens.find((t) => t.id === selection.target);
          if (!tok) return false;
          if (tok.kind === "ref" || tok.kind === "tokenref" || tok.kind === "globalref") return true;
          if (tok.kind === "num") {
            return !!(line.labels && line.labels[selection.target]);
          }
          return false;
        })()}
        onBreakLink={() => {
          if (!selection || selection.kind === "global") return;
          // Whole-line selection: resolve every ref/globalref in the line to
          // a literal number, and clear name + all labels (the line loses its
          // "variable" identity because labels are what mark it as one).
          if (selection.kind === "line") {
            const line = lines.find((l) => l.id === selection.lineId);
            if (!line) return;
            mutateLines((prev) =>
              prev.map((l) => {
                if (l.id !== selection.lineId) return l;
                const newTokens = l.tokens.map((t) => {
                  if (t.kind === "ref") {
                    const v = results[t.sourceId]?.value;
                    return {
                      id: t.id,
                      kind: "num",
                      value: v === null || v === undefined || Number.isNaN(v) ? 0 : v,
                    };
                  }
                  if (t.kind === "tokenref") {
                    const srcLine = prev.find((l2) => l2.id === t.lineId);
                    const srcTok = srcLine?.tokens.find((tk) => tk.id === t.tokenId);
                    const v = srcTok && srcTok.kind === "num" ? srcTok.value : null;
                    return {
                      id: t.id,
                      kind: "num",
                      value: v === null || v === undefined || Number.isNaN(v) ? 0 : v,
                    };
                  }
                  if (t.kind === "globalref") {
                    const g = globals.find((x) => x.id === t.globalId);
                    const v = g?.value;
                    return {
                      id: t.id,
                      kind: "num",
                      value: v === null || v === undefined || Number.isNaN(v) ? 0 : v,
                    };
                  }
                  return t;
                });
                const next = { ...l, tokens: newTokens, labels: {} };
                delete next.name;
                return next;
              })
            );
            return;
          }
          const line = lines.find((l) => l.id === selection.lineId);
          if (!line) return;
          // Result chip with label → just remove that label.
          if (selection.target === "result") {
            mutateLines((prev) =>
              prev.map((l) => {
                if (l.id !== selection.lineId) return l;
                const labels = { ...(l.labels || {}) };
                delete labels.result;
                return { ...l, labels };
              })
            );
            return;
          }
          const tok = line.tokens.find((t) => t.id === selection.target);
          if (!tok) return;
          // Labeled num chip → just remove that token's label.
          if (tok.kind === "num") {
            mutateLines((prev) =>
              prev.map((l) => {
                if (l.id !== selection.lineId) return l;
                const labels = { ...(l.labels || {}) };
                delete labels[selection.target];
                return { ...l, labels };
              })
            );
            return;
          }
          // ref / tokenref / globalref → resolve to literal value.
          let newValue = null;
          if (tok.kind === "ref") {
            newValue = results[tok.sourceId]?.value;
          } else if (tok.kind === "tokenref") {
            const srcLine = lines.find((l) => l.id === tok.lineId);
            const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
            newValue = srcTok && srcTok.kind === "num" ? srcTok.value : null;
          } else if (tok.kind === "globalref") {
            const g = globals.find((x) => x.id === tok.globalId);
            newValue = g?.value;
          }
          if (newValue === null || newValue === undefined || Number.isNaN(newValue)) return;
          mutateLines((prev) =>
            prev.map((l) => {
              if (l.id !== selection.lineId) return l;
              return {
                ...l,
                tokens: l.tokens.map((t) =>
                  t.id === selection.target
                    ? { id: t.id, kind: "num", value: newValue }
                    : t
                ),
              };
            })
          );
        }}
        getLineColor={(lineId) => getLineColor(lines, lineId, darkMode)}
        onDeleteLine={(lineId) => {
          mutateLines((prev) => prev.filter((l) => l.id !== lineId));
          setSelection(null);
          if (activeLineId === lineId) setActiveLineId(null);
        }}
      />
            );
          })()}

      {keypadMode === "vars" ? (
        <VariablesPanel
          tab={varsTab}
          setTab={setVarsTab}
          selection={selection}
          internalVars={getInternalVars(lines, results)}
          globals={globals}
          onPickInternal={(lineId, tokenId) => {
            setActiveLineId(lineId);
            if (tokenId === "__line__") {
              // Line variable — select the whole line. From here the user can
              // rename, copy, paste or delete via the selection bar.
              setSelection({ kind: "line", lineId });
            } else {
              setSelection({ lineId, target: tokenId });
            }
          }}
          onPickGlobal={(gid) => {
            setSelection({ kind: "global", globalId: gid });
          }}
          onCreateGlobal={async (name, value) => {
            const g = makeGlobal(name, value);
            await onUpsertGlobal(g);
          }}
          onUpdateGlobal={async (g) => {
            await onUpsertGlobal(g);
          }}
          onDeleteGlobal={async (id) => {
            await onDeleteGlobal(id);
          }}
          onPromoteInternal={async (v) => {
            // Promote an internal var (from the panel) to a global var.
            // For "line" kind, create a global of kind "line" with a snapshot
            // of the line's tokens (internal refs resolved to literals,
            // globalrefs preserved as live links). Token labels are not carried
            // over — the global line stands alone.
            if (v.kind === "line" && v.tokenId === "__line__") {
              const sourceLine = lines.find((l) => l.id === v.lineId);
              if (!sourceLine || !sourceLine.tokens || sourceLine.tokens.length === 0) return;
              const snapshotTokens = sourceLine.tokens.map((tk) => {
                if (tk.kind === "ref") {
                  const val = results[tk.sourceId]?.value;
                  return {
                    id: uid(),
                    kind: "num",
                    value: val === null || val === undefined || Number.isNaN(val) ? 0 : val,
                  };
                }
                // Re-id every token so the global doesn't share IDs with the
                // source line (avoids confusion if someone pastes it back).
                return { ...tk, id: uid() };
              });
              const g = makeGlobalLine(v.name, snapshotTokens, {});
              await onUpsertGlobal(g);
              setVarsTab("globales");
              return;
            }
            // Number kind — keep the existing behavior.
            if (v.value === null || v.value === undefined) return;
            const g = makeGlobal(v.name, v.value);
            await onUpsertGlobal(g);
            setVarsTab("globales");
          }}
          onDeleteInternal={(v) => {
            // Remove the label/name that turns this line into an internal
            // variable. The line itself stays. For "line" kind, clear the
            // line.name; otherwise clear the corresponding entry in labels.
            if (v.kind === "line" && v.tokenId === "__line__") {
              setLines((prev) =>
                prev.map((l) => {
                  if (l.id !== v.lineId) return l;
                  const next = { ...l };
                  delete next.name;
                  return next;
                })
              );
              // Also clear selection if it was pointing at this line.
              if (selection && selection.kind === "line" && selection.lineId === v.lineId) {
                setSelection(null);
              }
            } else {
              setLines((prev) =>
                prev.map((l) => {
                  if (l.id !== v.lineId) return l;
                  const labels = { ...(l.labels || {}) };
                  delete labels[v.tokenId];
                  return { ...l, labels };
                })
              );
              if (
                selection &&
                selection.kind !== "global" &&
                selection.kind !== "line" &&
                selection.lineId === v.lineId &&
                selection.target === v.tokenId
              ) {
                setSelection(null);
              }
            }
          }}
          formulas={formulas}
          onSaveLineAsFormula={saveLineAsFormula}
          onPasteFormula={pasteFormula}
          onUpsertFormula={onUpsertFormula}
          onDeleteFormula={onDeleteFormula}
          activeLineId={activeLineId}
          lines={lines}
          results={results}
          onSwitchToNumpad={() => setKeypadMode("numpad")}
          onSwitchToShare={() => setKeypadMode("share")}
          theme={theme}
          darkMode={darkMode}
        />
      ) : keypadMode === "share" ? (
        <SharePanel
          doc={{ ...doc, name: docName, lines }}
          results={results}
          globals={globals}
          internalVars={getInternalVars(lines, results)}
          onSwitchToNumpad={() => setKeypadMode("numpad")}
          onSwitchToVars={() => setKeypadMode("vars")}
          theme={theme}
          darkMode={darkMode}
        />
      ) : (
        <Keypad
          onDigit={insertDigit}
          onOp={insertOp}
          onBackspace={backspace}
          onClear={clearLine}
          onEquals={equals}
          onNewLine={addLine}
          onDecimal={() => insertDigit(".")}
          onSign={toggleSign}
          onParen={insertParen}
          onPower={() => insertOp("^")}
          onPercent={() => insertOp("%")}
          onSwitchToVars={() => setKeypadMode("vars")}
          onSwitchToShare={() => setKeypadMode("share")}
          theme={theme}
        />
      )}
        </>
      )}
    </div>
  );
}

// ----------------------- line view -----------------------
function LineView({
  line,
  result,
  isActive,
  selection,
  editing,
  setActiveLine,
  onChipLongPress,
  onChipPickUp,
  onChipDragMove,
  onChipDragEnd,
  onChipTap,
  startEditNumber,
  onEditChange,
  commitEditNumber,
  chipRefs,
  refValueOf,
  tokenRefValueOf,
  refLabelOf,
  tokenRefLabelOf,
  colorOf,
  lineColor,
  theme,
  globalValueOf,
  globalLabelOf,
}) {
  const hasResult = result && result.value !== null;
  const isLineSelected =
    selection && selection.lineId === line.id && selection.target === "result";
  const isWholeLineSelected =
    selection && selection.kind === "line" && selection.lineId === line.id;

  return (
    <div
      data-lineid={line.id}
      onClick={(e) => {
        e.stopPropagation();
        setActiveLine(e);
      }}
      style={{
        padding: "12px 4px 8px",
        borderLeft: isWholeLineSelected
          ? `5px solid ${lineColor}`
          : isActive
          ? `2px solid ${lineColor}`
          : "2px solid transparent",
        paddingLeft: isWholeLineSelected ? 7 : isActive ? 10 : 12,
        marginBottom: 2,
        position: "relative",
        zIndex: 2,
        width: "max-content",
        minWidth: "100%",
      }}
    >
      {/* Line name (line variable) — shown bold above the line in its color. */}
      {line.name && line.name.trim() && (
        <div
          style={{
            fontSize: 12 * (theme?.textScale ?? 1),
            fontWeight: 700,
            color: lineColor,
            marginBottom: 2,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {line.name}
        </div>
      )}
      <div
        className="flex items-center"
        style={{
          fontSize: 30 * (theme?.textScale ?? 1),
          gap: 8,
          lineHeight: 1.3,
          fontWeight: theme?.textWeight ?? 300,
          flexWrap: "nowrap",
          whiteSpace: "nowrap",
          paddingBottom: 4,
          width: "max-content",
        }}
      >
        {line.tokens.length === 0 && !hasResult && (
          <span
            style={{
              color: theme.textFaint,
              fontStyle: "italic",
              fontSize: 18 * (theme?.textScale ?? 1),
            }}
          >
            toca un número…
          </span>
        )}
        {line.tokens.map((tok) => {
          const label = getLabelForToken(line, tok, refLabelOf, globalLabelOf, tokenRefLabelOf);
          // A ref token borrows the color of its source line.
          // A globalref uses the accent color (matches the chip).
          const tokColor =
            tok.kind === "ref"
              ? colorOf(tok.sourceId)
              : tok.kind === "tokenref"
              ? colorOf(tok.lineId)
              : tok.kind === "globalref"
              ? (theme?.accent || "#ADD010")
              : null;
          return (
            <span
              key={tok.id}
              style={{
                position: "relative",
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              {label && (
                <span
                  style={{
                    fontSize: 11,
                    color: tokColor || theme.textMuted || "#888",
                    fontStyle: "italic",
                    fontWeight: 400,
                    letterSpacing: "0.02em",
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    opacity: 0.9,
                    lineHeight: 1,
                    marginBottom: 1,
                  }}
                >
                  {label}
                </span>
              )}
              <TokenView
                tok={tok}
                lineId={line.id}
                selection={selection}
                editing={editing}
                onLongPress={onChipLongPress}
                onPickUp={onChipPickUp}
                onDragMove={onChipDragMove}
                onDragEnd={onChipDragEnd}
                onTap={onChipTap}
                startEditNumber={startEditNumber}
                onEditChange={onEditChange}
                commitEditNumber={commitEditNumber}
                chipRefs={chipRefs}
                refValueOf={refValueOf}
                tokenRefValueOf={tokenRefValueOf}
                refColor={tokColor}
                theme={theme}
                globalValueOf={globalValueOf}
              />
            </span>
          );
        })}
        {hasResult && line.tokens.length > 0 && (
          <>
            <span style={{ color: theme.equals, margin: "0 4px", flexShrink: 0 }}>=</span>
            <span
              style={{
                position: "relative",
                display: "inline-flex",
                flexDirection: "column",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              {line.labels?.result && (
                <span
                  style={{
                    fontSize: 11,
                    color: lineColor || theme.textMuted || "#888",
                    fontStyle: "italic",
                    fontWeight: 400,
                    letterSpacing: "0.02em",
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    opacity: 0.9,
                    lineHeight: 1,
                    marginBottom: 1,
                  }}
                >
                  {line.labels.result}
                </span>
              )}
              <ResultChip
                lineId={line.id}
                value={result.value}
                selected={isLineSelected}
                onLongPress={onChipLongPress}
                onPickUp={onChipPickUp}
                onDragMove={onChipDragMove}
                onDragEnd={onChipDragEnd}
                onTap={(lid) => onChipTap(lid, "result")}
                chipRefs={chipRefs}
                color={lineColor}
                theme={theme}
              />
            </span>
          </>
        )}
        {!hasResult && line.tokens.length > 0 && result?.error && (
          <span style={{ color: theme.errText, fontSize: 14, fontStyle: "italic", marginLeft: 10 }}>
            {result.error}
          </span>
        )}
      </div>
    </div>
  );
}

function getLabelForToken(line, tok, refLabelOf, globalLabelOf, tokenRefLabelOf) {
  // Explicit label on this token wins.
  const own = line.labels?.[tok.id];
  if (own) return own;
  // If this is a reference token, inherit the source line's result label.
  if (tok.kind === "ref") {
    return refLabelOf(tok.sourceId);
  }
  // Token reference → use the source token's label.
  if (tok.kind === "tokenref" && tokenRefLabelOf) {
    return tokenRefLabelOf(tok.lineId, tok.tokenId);
  }
  // Global ref → use the global's name as the label.
  if (tok.kind === "globalref" && globalLabelOf) {
    return globalLabelOf(tok.globalId);
  }
  return null;
}

function LabelTag({ text, color, theme }) {
  return (
    <span
      style={{
        position: "absolute",
        bottom: "calc(100% + 2px)",
        left: "50%",
        transform: "translateX(-50%)",
        fontSize: 11,
        color: color || (theme ? theme.textMuted : "#888"),
        fontStyle: "italic",
        fontWeight: 400,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        opacity: 0.9,
      }}
    >
      {text}
    </span>
  );
}

// ----------------------- token view -----------------------
function TokenView({
  tok,
  lineId,
  selection,
  editing,
  onLongPress,
  onPickUp,
  onDragMove,
  onDragEnd,
  onTap,
  startEditNumber,
  onEditChange,
  commitEditNumber,
  chipRefs,
  refValueOf,
  tokenRefValueOf,
  refColor,
  globalValueOf,
  theme,
}) {
  const isSelected = selection && selection.lineId === lineId && selection.target === tok.id;
  const isNumOrRef = tok.kind === "num" || tok.kind === "ref" || tok.kind === "globalref" || tok.kind === "tokenref";
  const [lifted, setLifted] = useState(false);
  const t = theme || {};
  const accent = t.accent || "#ADD010";

  const gestureRef = useChipGesture({
    onTap: isNumOrRef ? () => onTap(lineId, tok.id) : null,
    onLongPress: isNumOrRef ? (rect) => { setLifted(false); onLongPress(lineId, tok.id, rect); } : null,
    onPickUp: isNumOrRef ? (x, y) => {
      setLifted(true);
      onPickUp(lineId, tok.id, x, y);
    } : null,
    onDragMove: isNumOrRef ? (x, y) => onDragMove(x, y) : null,
    onDragEnd: isNumOrRef ? (x, y) => { setLifted(false); onDragEnd(x, y); } : null,
  });

  const setEl = (el) => {
    gestureRef.current = el;
    if (el) chipRefs.current[`${lineId}:${tok.id}`] = el;
  };

  if (tok.kind === "op") {
    const display = tok.value === "*" ? "×" : tok.value === "/" ? "÷" : tok.value === "-" ? "−" : tok.value;
    return (
      <span
        ref={setEl}
        onClick={(e) => {
          e.stopPropagation();
          if (onTap) onTap(lineId, tok.id);
        }}
        style={{
          color: isSelected ? accent : (t.opText || "#666"),
          padding: "0 4px",
          background: isSelected ? `${accent}22` : "transparent",
          borderRadius: 4,
          cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
        }}
      >
        {display}
      </span>
    );
  }
  if (tok.kind === "paren") {
    return <span style={{ color: t.opText || "#666" }}>{tok.value}</span>;
  }
  if (tok.kind === "num") {
    const isEditing = editing && editing.lineId === lineId && editing.tokenId === tok.id;
    if (isEditing) {
      return (
        <input
          autoFocus
          value={editing.buffer}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={commitEditNumber}
          onKeyDown={(e) => e.key === "Enter" && commitEditNumber()}
          onClick={(e) => e.stopPropagation()}
          style={{
            fontSize: 30,
            fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontWeight: 300,
            width: Math.max(60, (editing.buffer?.length || 1) * 20),
            border: "none",
            borderBottom: `2px solid ${accent}`,
            outline: "none",
            background: "transparent",
            color: t.tokenText || "#1a1a1a",
            padding: "0 4px",
          }}
        />
      );
    }
    return (
      <span
        ref={setEl}
        style={{
          cursor: "pointer",
          padding: isSelected || lifted ? "3px 12px" : "2px 4px",
          borderRadius: 10,
          background: lifted ? accent : isSelected ? accent : "transparent",
          color: lifted || isSelected ? "white" : (t.tokenText || "#1a1a1a"),
          fontWeight: isSelected || lifted ? 400 : 300,
          transition: "all 0.12s",
          touchAction: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
          boxShadow: lifted
            ? `0 8px 24px ${accent}80`
            : isSelected
            ? `0 2px 8px ${accent}59`
            : "none",
          transform: lifted ? "scale(1.15)" : "scale(1)",
          opacity: lifted ? 0.4 : 1,
        }}
      >
        {tok._building && tok.raw !== undefined
          ? tok.raw.replace(".", ",")
          : fmt(tok.value)}
      </span>
    );
  }
  if (tok.kind === "ref") {
    const v = refValueOf(tok.sourceId);
    const c = refColor || "#7c3aed";
    return (
      <span
        ref={setEl}
        style={{
          display: "inline-block",
          padding: isSelected || lifted ? "2px 10px" : "2px 4px",
          borderRadius: 10,
          background: lifted ? c : isSelected ? c : "transparent",
          color: lifted || isSelected ? "white" : c,
          fontWeight: 400,
          cursor: "grab",
          boxShadow: lifted ? `0 8px 24px ${c}88` : isSelected ? `0 3px 10px ${c}66` : "none",
          transition: "all 0.15s",
          touchAction: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
          transform: lifted ? "scale(1.15)" : "scale(1)",
          opacity: lifted ? 0.4 : 1,
        }}
      >
        {v !== null && v !== undefined ? fmt(v) : "—"}
      </span>
    );
  }
  if (tok.kind === "tokenref") {
    const v = tokenRefValueOf ? tokenRefValueOf(tok.lineId, tok.tokenId) : null;
    const c = refColor || "#7c3aed";
    return (
      <span
        ref={setEl}
        style={{
          display: "inline-block",
          padding: isSelected || lifted ? "2px 10px" : "2px 4px",
          borderRadius: 10,
          background: lifted ? c : isSelected ? c : "transparent",
          color: lifted || isSelected ? "white" : c,
          fontWeight: 400,
          cursor: "grab",
          boxShadow: lifted ? `0 8px 24px ${c}88` : isSelected ? `0 3px 10px ${c}66` : "none",
          transition: "all 0.15s",
          touchAction: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
          transform: lifted ? "scale(1.15)" : "scale(1)",
          opacity: lifted ? 0.4 : 1,
        }}
      >
        {v !== null && v !== undefined ? fmt(v) : "—"}
      </span>
    );
  }
  if (tok.kind === "globalref") {
    // Globalref always renders in accent (orange) with a small lock icon.
    const v = globalValueOf ? globalValueOf(tok.globalId) : null;
    const c = t.accent || "#ADD010";
    return (
      <span
        ref={setEl}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          padding: isSelected || lifted ? "2px 10px" : "2px 4px",
          borderRadius: 10,
          background: lifted ? c : isSelected ? c : "transparent",
          color: lifted || isSelected ? "white" : c,
          fontWeight: 400,
          cursor: "grab",
          boxShadow: lifted ? `0 8px 24px ${c}88` : isSelected ? `0 3px 10px ${c}66` : "none",
          transition: "all 0.15s",
          touchAction: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
          transform: lifted ? "scale(1.15)" : "scale(1)",
          opacity: lifted ? 0.4 : 1,
        }}
      >
        <Lock
          size={12}
          weight="bold"
          style={{ marginRight: 1, opacity: lifted || isSelected ? 1 : 0.7 }}
        />
        {v !== null && v !== undefined ? fmt(v) : "—"}
      </span>
    );
  }
  return null;
}

// ----------------------- result chip -----------------------
function ResultChip({ lineId, value, selected, onLongPress, onPickUp, onDragMove, onDragEnd, onTap, chipRefs, color }) {
  const c = color || "#ADD010";
  const [lifted, setLifted] = useState(false);

  const gestureRef = useChipGesture({
    onTap: () => onTap && onTap(lineId),
    onLongPress: (rect) => { setLifted(false); onLongPress(lineId, "result", rect); },
    onPickUp: (x, y) => { setLifted(true); onPickUp(lineId, "result", x, y); },
    onDragMove: (x, y) => onDragMove(x, y),
    onDragEnd: (x, y) => { setLifted(false); onDragEnd(x, y); },
  });

  const setEl = (el) => {
    gestureRef.current = el;
    if (el) chipRefs.current[`${lineId}:result`] = el;
  };

  return (
    <span
      ref={setEl}
      style={{
        display: "inline-block",
        padding: "3px 14px",
        borderRadius: 12,
        background: lifted ? c : selected ? c : "transparent",
        color: lifted || selected ? "white" : c,
        border: `1.5px solid ${c}`,
        fontWeight: 400,
        cursor: "grab",
        boxShadow: lifted
          ? `0 10px 28px ${c}88`
          : selected
          ? `0 3px 12px ${c}66`
          : "none",
        transform: lifted ? "scale(1.18)" : selected ? "scale(1.03)" : "scale(1)",
        transition: "all 0.15s",
        touchAction: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        opacity: lifted ? 0.4 : 1,
      }}
    >
      {fmt(value)}
    </span>
  );
}

// ----------------------- menu -----------------------
function ChipMenu({ x, y, onCopy, onPaste, onDelete, onLabel, canPaste }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        transform: "translate(-50%, -100%)",
        background: "#2a2a2a",
        borderRadius: 12,
        boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
        display: "flex",
        overflow: "hidden",
        zIndex: 50,
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
    >
      <MenuBtn onClick={onCopy}>Copiar</MenuBtn>
      <MenuBtn onClick={onPaste} disabled={!canPaste}>Pegar</MenuBtn>
      <MenuBtn onClick={onDelete} danger>Borrar</MenuBtn>
    </div>
  );
}
function MenuBtn({ children, onClick, disabled, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "11px 16px",
        fontSize: 14,
        border: "none",
        background: "transparent",
        color: disabled ? "#666" : danger ? "#ff7a88" : "#eee",
        cursor: disabled ? "default" : "pointer",
        fontFamily: "inherit",
        letterSpacing: "0.01em",
      }}
    >
      {children}
    </button>
  );
}

// ----------------------- label editor -----------------------
function LabelEditor({ initial, onSave, onCancel, theme }) {
  const [text, setText] = useState(initial);
  const t = theme || {};
  const isDark = t.bg && t.bg !== "#ffffff";
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 60,
        display: "flex",
        alignItems: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.labelEditorBg || "#ffffff",
          width: "100%",
          padding: "22px 22px 32px",
          borderRadius: "18px 18px 0 0",
          fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          boxShadow: isDark ? "0 -10px 40px rgba(0,0,0,0.4)" : "0 -10px 40px rgba(0,0,0,0.1)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: t.textMuted || "#888",
            marginBottom: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Etiqueta para este valor
        </div>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="ej. subtotal, IVA, precio unit…"
          style={{
            width: "100%",
            fontSize: 22,
            padding: "8px 0",
            border: "none",
            borderBottom: `2px solid ${t.accent || "#ADD010"}`,
            outline: "none",
            fontFamily: "inherit",
            fontStyle: "italic",
            color: t.labelEditorText || "#333",
            background: "transparent",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave(text);
            if (e.key === "Escape") onCancel();
          }}
        />
        <div style={{ fontSize: 11, color: t.textFaint || "#aaa", marginTop: 6 }}>
          Deja el campo vacío y guarda para borrar la etiqueta.
        </div>
        <div style={{ marginTop: 22, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "10px 18px",
              border: "none",
              borderRadius: 8,
              background: isDark ? "#2a2d36" : "#f3f3f3",
              color: t.textMuted || "#666",
              fontSize: 15,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            onClick={() => onSave(text)}
            style={{
              padding: "10px 18px",
              border: "none",
              borderRadius: 8,
              background: t.accent || "#ADD010",
              color: "#000",
              fontSize: 15,
              fontWeight: 400,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------- keypad -----------------------
function Keypad({
  onDigit,
  onOp,
  onBackspace,
  onClear,
  onEquals,
  onNewLine,
  onDecimal,
  onSign,
  onParen,
  onPower,
  onPercent,
  onSwitchToVars,
  onSwitchToShare,
  theme,
}) {
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };
  const t = theme || {};

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        borderTop: `1px solid ${t.keypadBorder || "#e5e5e5"}`,
        background: t.keypadBg || "#EBEBEB",
        display: "flex",
        flexDirection: t.leftHanded ? "row-reverse" : "row",
        paddingBottom: "env(safe-area-inset-bottom)",
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        transition: "background 0.25s",
      }}
    >
      {/* Left sidebar */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: "repeat(3, 1fr)",
          background: t.keySidebar || "#ddd",
          width: 48,
        }}
      >
        <SideBtn onClick={stop(onNewLine)} title="Nueva línea" highlight theme={t}>
          <CalculatorIcon size={18} weight="bold" style={{ color: t.accentOnWhite || "#778D1C" }} />
        </SideBtn>
        <SideBtn onClick={stop(() => onSwitchToVars && onSwitchToVars())} title="Variables" theme={t}>
          <Tag size={17} weight="bold" style={{ color: t.textMuted || "#888" }} />
        </SideBtn>
        <SideBtn onClick={stop(() => onSwitchToShare && onSwitchToShare())} title="Compartir" theme={t}>
          <Share size={17} weight="bold" style={{ color: t.textMuted || "#888" }} />
        </SideBtn>
      </div>

      {/* Main grid */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, paddingLeft: 8 }}>
        {/* top row */}
        <TopBtn onClick={stop(onClear)} theme={t}>
          <XSquare size={24} weight="bold" />
        </TopBtn>
        <TopBtn onClick={stop(onBackspace)} theme={t}>
          <Backspace size={24} weight="bold" />
        </TopBtn>
        <TopBtn onClick={stop(() => onParen("("))} theme={t}>(</TopBtn>
        <TopBtn onClick={stop(() => onParen(")"))} theme={t}>)</TopBtn>

        <KeyBtn onClick={stop(onPercent)} theme={t}>%</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("7"))} theme={t}>7</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("8"))} theme={t}>8</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("9"))} theme={t}>9</KeyBtn>

        <KeyBtn onClick={stop(onPower)} theme={t}>
          x<sup style={{ fontSize: 13 }}>y</sup>
        </KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("4"))} theme={t}>4</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("5"))} theme={t}>5</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("6"))} theme={t}>6</KeyBtn>

        <KeyBtn onClick={stop(() => { onPower(); onDigit("0"); onDigit("."); onDigit("5"); })} theme={t}>√</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("1"))} theme={t}>1</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("2"))} theme={t}>2</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("3"))} theme={t}>3</KeyBtn>

        <KeyBtn disabled theme={t}>!</KeyBtn>
        <KeyBtn onClick={stop(() => onDigit("0"))} theme={t}>0</KeyBtn>
        <KeyBtn onClick={stop(onDecimal)} theme={t}>,</KeyBtn>
        <KeyBtn onClick={stop(onSign)} theme={t}>±</KeyBtn>
      </div>

      {/* Right operator column */}
      <div style={{ width: 72, display: "grid", gridTemplateRows: "repeat(5, 1fr)", gap: 1 }}>
        <OpBtn onClick={stop(() => onOp("/"))} theme={t}>÷</OpBtn>
        <OpBtn onClick={stop(() => onOp("*"))} theme={t}>×</OpBtn>
        <OpBtn onClick={stop(() => onOp("-"))} theme={t}>−</OpBtn>
        <OpBtn onClick={stop(() => onOp("+"))} theme={t}>+</OpBtn>
        <OpBtn onClick={stop(onEquals)} theme={t}>=</OpBtn>
      </div>
    </div>
  );
}

function KeyBtn({ children, onClick, disabled, theme }) {
  const t = theme || {};
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: t.keyBg || "#EBEBEB",
        border: "none",
        padding: "10px 0",
        fontSize: 22,
        color: disabled ? (t.textFaint || "#ccc") : (t.keyText || "#1a1a1a"),
        fontFamily: "inherit",
        fontWeight: 300,
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.2s, color 0.2s",
      }}
    >
      {children}
    </button>
  );
}
function TopBtn({ children, onClick, disabled, theme }) {
  const t = theme || {};
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: t.keyTopBg || "#f0f0f0",
        border: "none",
        padding: "8px 0",
        fontSize: 18,
        color: disabled ? (t.textFaint || "#ccc") : (t.keyTopText || "#666"),
        fontFamily: "inherit",
        fontWeight: 300,
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 0.2s, color 0.2s",
      }}
    >
      {children}
    </button>
  );
}
function OpBtn({ children, onClick, theme }) {
  const t = theme || {};
  return (
    <button
      onClick={onClick}
      style={{
        background: t.accent || "#ADD010",
        border: "none",
        fontSize: 22,
        color: "#000",
        fontFamily: "inherit",
        fontWeight: 400,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
function SideBtn({ children, onClick, disabled, highlight, theme }) {
  const t = theme || {};
  const isDark = t.bg && t.bg !== "#ffffff";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: highlight ? (isDark ? "#1c1f28" : "#eee") : "transparent",
        border: "none",
        borderRight: `1px solid ${isDark ? "#2a2d36" : "#ccc"}`,
        borderBottom: `1px solid ${isDark ? "#2a2d36" : "#ccc"}`,
        padding: "10px 0",
        color: t.textMuted || "#888",
        fontFamily: "inherit",
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

// ----------------------- Selection bar above keypad -----------------------
function SelectionBar({ selection, lines, results, clipboard, onCopy, onPaste, onLabelChange, onPromote, canPromote, onBreakLink, canBreakLink, onDeleteLine, getLineColor, theme, getLabel, getValue, getColor }) {
  const t = theme || {};
  const hasSelection = !!selection;
  const isLineSel = hasSelection && selection.kind === "line";
  const lineSelLine = isLineSel ? lines.find((l) => l.id === selection.lineId) : null;
  const lineSelResult = isLineSel ? results[selection.lineId] : null;
  const lineSelColor = isLineSel && getLineColor ? getLineColor(selection.lineId) : null;
  const value = hasSelection && !isLineSel ? getValue(selection) : null;
  const label = hasSelection && !isLineSel ? getLabel(selection) : null;
  const color = hasSelection && !isLineSel ? getColor(selection) : null;

  // Common bar wrapper styles, used for both render modes.
  const wrapperStyle = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 14px",
    background: "#000000",
    borderTop: "1px solid #000000",
    fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    height: 60,
    boxSizing: "border-box",
    flexDirection: t.leftHanded ? "row-reverse" : "row",
    overflow: "hidden",
  };

  // Whole-line selection mode: simple bar with "línea" indicator + result + copy/paste/delete.
  if (isLineSel) {
    const resultValue = lineSelResult?.value;
    const lineLabel = lineSelLine?.name || "";
    const canPaste = !!clipboard;
    return (
      <div onClick={(e) => e.stopPropagation()} style={wrapperStyle}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, color: t.accent || "#ADD010" }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="4" x2="13" y2="4" />
            <line x1="3" y1="8" x2="13" y2="8" />
            <line x1="3" y1="12" x2="13" y2="12" />
          </svg>
          <input
            value={lineLabel}
            onChange={(e) => onLabelChange && onLabelChange(e.target.value)}
            placeholder="etiquetar…"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              color: t.accent || "#ADD010",
              fontFamily: "inherit",
              fontSize: 16,
              fontStyle: "italic",
              width: 110,
              padding: "2px 4px",
              cursor: "text",
              userSelect: "text",
              WebkitUserSelect: "text",
              touchAction: "auto",
            }}
          />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "center",
            fontSize: 16,
            color: lineSelColor || "#ffffff",
            fontWeight: 500,
            fontVariantNumeric: "lining-nums tabular-nums",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {resultValue !== null && resultValue !== undefined ? formatBarNumber(resultValue) : "—"}
        </div>
        {canBreakLink && (
          <button
            onClick={(e) => { e.stopPropagation(); if (onBreakLink) onBreakLink(); }}
            style={{ background: "transparent", border: "none", padding: 6, cursor: "pointer", color: "#ffffff" }}
            aria-label="Romper vínculos"
            title="Convertir todos los valores en números literales"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 17H7A5 5 0 0 1 7 7" />
              <path d="M15 7h2a5 5 0 0 1 4 8" />
              <line x1="8" y1="12" x2="12" y2="12" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); if (onCopy) onCopy(); }}
          style={{ background: "transparent", border: "none", padding: 6, cursor: "pointer", color: "#ffffff" }}
          aria-label="Copiar línea"
          title="Copiar línea"
        >
          <Copy size={20} weight="bold" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); if (canPaste && onPaste) onPaste(); }}
          disabled={!canPaste}
          style={{ background: "transparent", border: "none", padding: 6, cursor: canPaste ? "pointer" : "default", opacity: canPaste ? 1 : 0.35, color: "#ffffff" }}
          aria-label="Pegar"
          title="Pegar"
        >
          <ClipboardText size={20} weight="bold" />
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={wrapperStyle}
    >
      {/* Tag: editable inline. Click input to type a label. Click icon to promote to global. */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          opacity: hasSelection ? 1 : 0.35,
          color: t.accent || "#ADD010",
          flexShrink: 0,
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (canPromote && onPromote) onPromote();
          }}
          disabled={!canPromote}
          style={{
            background: "transparent",
            border: "none",
            padding: 4,
            cursor: canPromote ? "pointer" : "default",
            color: t.accent || "#ADD010",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-label={canPromote ? "Convertir en variable global" : "Etiqueta"}
          title={canPromote ? "Tocar candado: convertir en variable global" : ""}
        >
          {canPromote ? <Lock size={15} weight="bold" /> : <Tag size={16} weight="bold" />}
        </button>
        <input
          value={label || ""}
          onChange={(e) => hasSelection && onLabelChange(e.target.value)}
          placeholder={hasSelection ? "etiquetar…" : ""}
          disabled={!hasSelection}
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            background: "transparent",
            border: "none",
            outline: "none",
            color: t.accent || "#ADD010",
            fontFamily: "inherit",
            fontSize: 16,
            fontStyle: "italic",
            width: 110,
            padding: "2px 4px",
            cursor: hasSelection ? "text" : "default",
            userSelect: "text",
            WebkitUserSelect: "text",
            touchAction: "auto",
          }}
        />
      </div>

      {/* Selected value (centered) */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "center",
          fontSize: hasSelection ? 16 : 14,
          color: hasSelection ? (color || "#ffffff") : "#888888",
          fontWeight: hasSelection ? 500 : 400,
          fontStyle: hasSelection ? "normal" : "italic",
          fontVariantNumeric: "lining-nums tabular-nums",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {hasSelection
          ? value !== null && value !== undefined
            ? formatBarNumber(value)
            : "—"
          : "selecciona un valor"}
      </div>

      {/* Break link — only shown when selection is a ref or globalref */}
      {canBreakLink && (
        <button
          onClick={(e) => { e.stopPropagation(); if (onBreakLink) onBreakLink(); }}
          style={{
            background: "transparent",
            border: "none",
            padding: 6,
            cursor: "pointer",
            color: "#ffffff",
          }}
          aria-label="Romper vínculo"
          title="Convertir referencia en número"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 17H7A5 5 0 0 1 7 7" />
            <path d="M15 7h2a5 5 0 0 1 4 8" />
            <line x1="8" y1="12" x2="12" y2="12" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        </button>
      )}

      {/* Copy / paste icons */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (hasSelection) onCopy();
        }}
        disabled={!hasSelection}
        style={{
          background: "transparent",
          border: "none",
          padding: 6,
          cursor: hasSelection ? "pointer" : "default",
          opacity: hasSelection ? 1 : 0.35,
          color: "#ffffff",
        }}
        aria-label="Copiar"
      >
        <Copy size={20} weight="bold" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (clipboard) onPaste();
        }}
        disabled={!clipboard}
        style={{
          background: "transparent",
          border: "none",
          padding: 6,
          cursor: clipboard ? "pointer" : "default",
          opacity: clipboard ? 1 : 0.35,
          color: "#ffffff",
        }}
        aria-label="Pegar"
      >
        <ClipboardText size={20} weight="bold" />
      </button>
    </div>
  );
}

function formatBarNumber(n) {
  return fmtN(n, _currentSettings || DEFAULT_SETTINGS);
}

// ----------------------- Share Panel -----------------------
// Renders the document as plain text, allows copying, exporting to PDF (via
// print dialog), and previewing/saving an image of the canvas content.
function SharePanel({ doc, results, globals, internalVars, onSwitchToNumpad, onSwitchToVars, theme, darkMode }) {
  const t = theme || {};
  const accent = t.accent || "#ADD010";
  const isDark = !!darkMode;
  const accentOnWhite = isDark ? accent : "#778D1C";
  const [toast, setToast] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const captureRef = useRef(null);
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  // Build a plain-text representation of the document, with labels in **bold**
  // (markdown). Each line: tokens rendered as text + " = " + result.
  const buildPlainText = () => {
    const lines = doc.lines || [];
    const out = [];
    // File name in *single-asterisk bold* (WhatsApp/Slack-style).
    if (doc.name) out.push(`*${doc.name}*`, "");
    // Helper: format a value with optional label as "value (_etiqueta_)".
    const withLabel = (valStr, label) => (label ? `${valStr} (_${label}_)` : valStr);
    for (const line of lines) {
      const parts = [];
      for (const tok of line.tokens) {
        if (tok.kind === "num") {
          const lbl = line.labels?.[tok.id];
          parts.push(withLabel(fmt(tok.value), lbl));
        } else if (tok.kind === "op") {
          const opChar = tok.value === "*" ? "×" : tok.value === "/" ? "÷" : tok.value;
          parts.push(opChar);
        } else if (tok.kind === "paren") {
          parts.push(tok.value);
        } else if (tok.kind === "ref") {
          const sourceLine = lines.find((l) => l.id === tok.sourceId);
          const lbl = sourceLine?.labels?.result || line.labels?.[tok.id];
          const valStr = fmt(results[tok.sourceId]?.value);
          parts.push(withLabel(valStr, lbl));
        } else if (tok.kind === "tokenref") {
          const sourceLine = lines.find((l) => l.id === tok.lineId);
          const sourceTok = sourceLine?.tokens.find((t) => t.id === tok.tokenId);
          const lbl = sourceLine?.labels?.[tok.tokenId] || line.labels?.[tok.id];
          const v = sourceTok && sourceTok.kind === "num" ? sourceTok.value : null;
          parts.push(withLabel(fmt(v), lbl));
        } else if (tok.kind === "globalref") {
          const g = globals.find((x) => x.id === tok.globalId);
          if (g) parts.push(withLabel(fmt(g.value), g.name));
        }
      }
      const r = results[line.id];
      if (r && r.value !== null && r.value !== undefined) {
        const resLabel = line.labels?.result;
        // Result wrapped in *bold*.
        const resStr = `*${fmt(r.value)}*`;
        parts.push("=", withLabel(resStr, resLabel));
      }
      out.push(parts.join(" "));
    }
    return out.join("\n");
  };

  const handleCopyText = async () => {
    const text = buildPlainText();
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copiado al portapapeles");
    } catch (e) {
      // Fallback: textarea + execCommand
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("Copiado al portapapeles");
      } catch (err) {
        showToast("No se pudo copiar");
      }
    }
  };

  // Export the document as an .xlsx file with the following layout per line:
  //   Row 1: line name (merged across the whole row of cells used)
  //   Row 2: per-token labels (variable names, in italics)
  //   Row 3: per-token values; operators in their own cells; result is a live
  //          Excel formula referencing the value cells of this same line.
  //   Row 4: empty separator.
  // No separate "Globales" sheet; globalref/ref/tokenref values are written
  // inline as numbers, with their label going in the row-2 label cell.
  const handleExportExcel = async () => {
    try {
      const lines = doc.lines || [];
      if (!lines.some((l) => l.tokens && l.tokens.length > 0)) {
        showToast("Nada que exportar");
        return;
      }
      const XLSX = await import("xlsx");

      // Resolve the numeric value and label of any token, in this doc's context.
      const resolveToken = (tok, line) => {
        let label = line.labels?.[tok.id] || null;
        let value = null;
        if (tok.kind === "num") {
          value = tok.value;
        } else if (tok.kind === "ref") {
          const v = results[tok.sourceId]?.value;
          value = v !== null && v !== undefined && !Number.isNaN(v) ? v : 0;
          if (!label) {
            const src = lines.find((l) => l.id === tok.sourceId);
            label = src?.labels?.result || null;
          }
        } else if (tok.kind === "tokenref") {
          const srcLine = lines.find((l) => l.id === tok.lineId);
          const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
          const v = srcTok && srcTok.kind === "num" ? srcTok.value : 0;
          value = v;
          if (!label) label = srcLine?.labels?.[tok.tokenId] || null;
        } else if (tok.kind === "globalref") {
          const g = globals.find((x) => x.id === tok.globalId);
          value = g?.value ?? 0;
          if (!label) label = g?.name || null;
        }
        return { value, label };
      };

      // Excel column letter from 0-indexed column number.
      const colLetter = (n) => {
        let s = "";
        n = n + 1;
        while (n > 0) {
          const m = (n - 1) % 26;
          s = String.fromCharCode(65 + m) + s;
          n = Math.floor((n - 1) / 26);
        }
        return s;
      };

      // We build everything as cell objects keyed by A1 address, plus track
      // !ref (used range) and !merges (merged ranges).
      const cells = {};
      const merges = [];
      let maxCol = 0;
      let curRow = 0; // 0-indexed for our own bookkeeping; convert to A1 with +1

      const setCell = (r, c, cellObj) => {
        const addr = colLetter(c) + (r + 1);
        cells[addr] = cellObj;
        if (c > maxCol) maxCol = c;
      };

      for (const line of lines) {
        if (!line.tokens || line.tokens.length === 0) continue;

        // Column 0 is reserved as a left margin / line-name column.
        // Tokens start at column 1.
        const tokenStartCol = 1;
        // Compute where the result chip will go: after all tokens, after "=".
        // We assign one cell per token (num/ref/globalref/tokenref/op/paren),
        // then one cell for "=" then one cell for the result.
        const tokenCount = line.tokens.length;
        const eqCol = tokenStartCol + tokenCount;
        const resultCol = eqCol + 1;

        // Row 1: line name spanning columns tokenStartCol..resultCol
        const nameRow = curRow;
        const nameText = (line.name && line.name.trim())
          ? line.name
          : (line.labels?.result || "");
        if (nameText) {
          setCell(nameRow, tokenStartCol, {
            t: "s",
            v: nameText,
            s: { font: { bold: true, sz: 13 } },
          });
          if (resultCol > tokenStartCol) {
            merges.push({
              s: { r: nameRow, c: tokenStartCol },
              e: { r: nameRow, c: resultCol },
            });
          }
        }

        // Row 2: per-token labels.
        const labelRow = curRow + 1;
        line.tokens.forEach((tok, idx) => {
          const c = tokenStartCol + idx;
          if (tok.kind === "op" || tok.kind === "paren") {
            // No label for operators / parens.
            return;
          }
          const { label } = resolveToken(tok, line);
          if (label) {
            setCell(labelRow, c, {
              t: "s",
              v: label,
              s: { font: { italic: true, sz: 10, color: { rgb: "888888" } } },
            });
          }
        });
        // Label for the result chip itself goes in the result column.
        const resultLabel = line.labels?.result;
        if (resultLabel) {
          setCell(labelRow, resultCol, {
            t: "s",
            v: resultLabel,
            s: { font: { italic: true, sz: 10, color: { rgb: "888888" } } },
          });
        }

        // Row 3: values + operators + "=" + live formula in result.
        const valueRow = curRow + 2;
        const valueCellAddrs = []; // addresses of numeric token cells, used to build the formula
        line.tokens.forEach((tok, idx) => {
          const c = tokenStartCol + idx;
          if (tok.kind === "op") {
            const display = tok.value === "*" ? "×" : tok.value === "/" ? "÷" : tok.value === "-" ? "−" : tok.value;
            setCell(valueRow, c, {
              t: "s",
              v: display,
              s: { alignment: { horizontal: "center" }, font: { color: { rgb: "888888" } } },
            });
            valueCellAddrs.push({ kind: "op", value: tok.value });
          } else if (tok.kind === "paren") {
            setCell(valueRow, c, {
              t: "s",
              v: tok.value,
              s: { alignment: { horizontal: "center" }, font: { color: { rgb: "888888" } } },
            });
            valueCellAddrs.push({ kind: "paren", value: tok.value });
          } else {
            const { value } = resolveToken(tok, line);
            setCell(valueRow, c, { t: "n", v: value });
            valueCellAddrs.push({ kind: "num", addr: colLetter(c) + (valueRow + 1) });
          }
        });
        // "=" cell
        setCell(valueRow, eqCol, {
          t: "s",
          v: "=",
          s: { alignment: { horizontal: "center" }, font: { color: { rgb: "888888" } } },
        });
        // Live formula in result cell, built from the value-cell addresses.
        // Operators stay as-is, parens stay, num cells become their address.
        const formulaParts = valueCellAddrs.map((p) => {
          if (p.kind === "op") return p.value;
          if (p.kind === "paren") return p.value;
          return p.addr;
        });
        const formulaStr = formulaParts.join("");
        const r = results[line.id];
        const computed = r && r.value !== null && r.value !== undefined ? r.value : 0;
        setCell(valueRow, resultCol, {
          t: "n",
          v: computed,
          f: formulaStr,
          s: { font: { bold: true, color: { rgb: "778D1C" } } },
        });

        // Advance: 3 rows used + 1 separator row.
        curRow += 4;
      }

      if (Object.keys(cells).length === 0) {
        showToast("Nada que exportar");
        return;
      }

      // Build worksheet object.
      const ws = {};
      Object.assign(ws, cells);
      // !ref must cover the full used range.
      ws["!ref"] = `A1:${colLetter(maxCol)}${curRow}`;
      if (merges.length) ws["!merges"] = merges;
      // Reasonable column widths.
      const cols = [];
      for (let c = 0; c <= maxCol; c++) {
        cols.push({ wch: c === 0 ? 4 : 14 });
      }
      ws["!cols"] = cols;

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Cálculo");

      // Generate .xlsx as ArrayBuffer.
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const safeName = (doc.name || "calcu").replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 40) || "calcu";
      const filename = `${safeName}.xlsx`;
      const file = new File([blob], filename, { type: blob.type });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: doc.name || "CALCU",
          });
          return;
        } catch (e) {
          if (e && e.name === "AbortError") return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Excel descargado");
    } catch (err) {
      console.error("excel export error:", err);
      showToast("No se pudo exportar");
    }
  };

  // Capture the clean view as a PNG. Renders an offscreen div with the doc
  // contents, rasterizes it via html-to-image, then shares it (Web Share API)
  // or downloads as fallback.
  // iOS Safari workarounds applied:
  //   - Wait for fonts.ready and an extra frame so layout settles.
  //   - Call toPng twice — first call "warms up" the renderer, second is the
  //     real capture. This is a known Safari/html-to-image fix for blank PNGs.
  const handleScreenshot = async () => {
    setCapturing(true);
    // Wait several frames + fonts so the offscreen DOM is fully painted.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (e) {}
      }
      const node = captureRef.current;
      if (!node) {
        showToast("No se pudo capturar");
        setCapturing(false);
        return;
      }
      const mod = await import("html-to-image");
      const opts = {
        pixelRatio: 2,
        backgroundColor: isDark ? "#0f1115" : "#ffffff",
        cacheBust: true,
      };
      // Warm-up call — discarded. Forces Safari to pre-rasterize the node so
      // the second call returns a populated image instead of an empty canvas.
      try { await mod.toPng(node, opts); } catch (e) {}
      // Small extra wait to let any async image/font fetches finish.
      await new Promise((r) => setTimeout(r, 60));
      const dataUrl = await mod.toPng(node, opts);
      // Sanity check: a "blank" iOS render is often <1KB. If we got that,
      // try one more time before giving up.
      let finalDataUrl = dataUrl;
      if (typeof dataUrl === "string" && dataUrl.length < 2000) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const retry = await mod.toPng(node, opts);
          if (typeof retry === "string" && retry.length > finalDataUrl.length) {
            finalDataUrl = retry;
          }
        } catch (e) {}
      }
      const res = await fetch(finalDataUrl);
      const blob = await res.blob();
      const safeName = (doc.name || "calcu").replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 40) || "calcu";
      const filename = `${safeName}.png`;
      const file = new File([blob], filename, { type: "image/png" });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: doc.name || "CALCU",
          });
          setCapturing(false);
          return;
        } catch (e) {
          if (e && e.name === "AbortError") {
            setCapturing(false);
            return;
          }
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Imagen descargada");
    } catch (err) {
      console.error("screenshot error:", err);
      showToast("No se pudo generar la imagen");
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        borderTop: `1px solid ${t.keypadBorder || "#e5e5e5"}`,
        background: t.keypadBg || "#EBEBEB",
        display: "flex",
        flexDirection: t.leftHanded ? "row-reverse" : "row",
        paddingBottom: "env(safe-area-inset-bottom)",
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        height: 285,
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: "repeat(3, 1fr)",
          background: t.keySidebar || "#ddd",
          width: 48,
        }}
      >
        <SideBtn onClick={(e) => { e.stopPropagation(); onSwitchToNumpad(); }} title="Volver al teclado" theme={t}>
          <CalculatorIcon size={18} weight="bold" style={{ color: t.textMuted || "#888" }} />
        </SideBtn>
        <SideBtn onClick={(e) => { e.stopPropagation(); onSwitchToVars && onSwitchToVars(); }} title="Variables" theme={t}>
          <Tag size={17} weight="bold" style={{ color: t.textMuted || "#888" }} />
        </SideBtn>
        <SideBtn disabled theme={t} highlight>
          <Share size={17} weight="bold" style={{ color: accentOnWhite }} />
        </SideBtn>
      </div>

      {/* Main share options */}
      <div
        style={{
          flex: 1,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: t.textMuted || "#888",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 2,
          }}
        >
          Compartir “{doc.name || "Sin título"}”
        </div>

        <ShareBtn onClick={handleExportExcel} theme={t} accent={accent}>
          <FileXls size={18} weight="bold" style={{ color: accent }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Exportar como Excel</div>
            <div style={{ fontSize: 11, color: t.textMuted || "#888", marginTop: 2 }}>
              Archivo .xlsx con fórmulas vivas
            </div>
          </div>
        </ShareBtn>

        <ShareBtn onClick={handleScreenshot} theme={t} accent={accent}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="1.5">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="12" cy="12" r="3.5" />
          </svg>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Captura del archivo</div>
            <div style={{ fontSize: 11, color: t.textMuted || "#888", marginTop: 2 }}>
              Vista limpia para hacer screenshot
            </div>
          </div>
        </ShareBtn>

        <ShareBtn onClick={handleCopyText} theme={t} accent={accent}>
          <Copy size={18} weight="bold" style={{ color: accent }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Copiar como texto</div>
            <div style={{ fontSize: 11, color: t.textMuted || "#888", marginTop: 2 }}>
              Resultados en *negrita* y etiquetas en (_cursiva_)
            </div>
          </div>
        </ShareBtn>

        {toast && (
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              background: isDark ? "#222" : "#333",
              color: "white",
              padding: "8px 16px",
              borderRadius: 8,
              fontSize: 12,
              zIndex: 10,
              boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
            }}
          >
            {toast}
          </div>
        )}
      </div>
      {capturing && (
        <CaptureView
          ref={captureRef}
          doc={doc}
          results={results}
          globals={globals}
          theme={t}
          isDark={isDark}
          accent={accent}
        />
      )}
    </div>
  );
}

// Hidden offscreen rendering used for screenshot capture. Positioned far off
// the viewport so it doesn't affect layout but is fully painted (necessary
// for html-to-image to rasterize).
const CaptureView = React.forwardRef(function CaptureView(
  { doc, results, globals, theme, isDark, accent },
  ref
) {
  const t = theme || {};
  const bg = isDark ? "#0f1115" : "#ffffff";
  const text = isDark ? "#e8ecf3" : "#1a1a1a";
  const muted = isDark ? "#7a8090" : "#888";
  const equals = isDark ? "#555a68" : "#aaa";
  const opText = isDark ? "#8f95a3" : "#666";
  const accentOnWhite = isDark ? "#ADD010" : "#778D1C";
  const lines = doc.lines || [];
  const palette = isDark ? LINE_COLORS_DARK : LINE_COLORS_LIGHT;
  const lineColor = (lineId) => {
    const idx = lines.findIndex((l) => l.id === lineId);
    return palette[(idx < 0 ? 0 : idx) % palette.length];
  };
  // Render a token as inline JSX with its label above (if any), styled to
  // mirror the canvas appearance closely.
  const renderToken = (tok, line) => {
    if (tok.kind === "op") {
      const display = tok.value === "*" ? "×" : tok.value === "/" ? "÷" : tok.value === "-" ? "−" : tok.value;
      return <span style={{ color: opText, padding: "0 4px" }}>{display}</span>;
    }
    if (tok.kind === "paren") return <span style={{ color: opText }}>{tok.value}</span>;
    let label = line.labels?.[tok.id] || null;
    let value = null;
    let color = text;
    let bordered = false;
    if (tok.kind === "num") {
      value = fmt(tok.value);
    } else if (tok.kind === "ref") {
      const v = results[tok.sourceId]?.value;
      value = v !== null && v !== undefined ? fmt(v) : "—";
      color = lineColor(tok.sourceId);
      if (!label) {
        const src = lines.find((l) => l.id === tok.sourceId);
        label = src?.labels?.result || null;
      }
    } else if (tok.kind === "tokenref") {
      const srcLine = lines.find((l) => l.id === tok.lineId);
      const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
      const v = srcTok && srcTok.kind === "num" ? srcTok.value : null;
      value = v !== null && v !== undefined ? fmt(v) : "—";
      color = lineColor(tok.lineId);
      if (!label) label = srcLine?.labels?.[tok.tokenId] || null;
    } else if (tok.kind === "globalref") {
      const g = globals.find((x) => x.id === tok.globalId);
      value = g ? fmt(g.value) : "—";
      color = accent;
      if (!label) label = g?.name || null;
    }
    return (
      <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
        {label && (
          <span
            style={{
              fontSize: 11,
              color: color,
              fontStyle: "italic",
              fontWeight: 400,
              opacity: 0.9,
              lineHeight: 1,
              marginBottom: 1,
            }}
          >
            {label}
          </span>
        )}
        <span style={{ color, fontWeight: 400, padding: "2px 4px" }}>{value}</span>
      </span>
    );
  };
  return (
    <div
      ref={ref}
      style={{
        // Positioned within the viewport but hidden via opacity. iOS Safari
        // refuses to rasterize nodes positioned far offscreen (left:-9999),
        // so we keep the node on-screen, layered over everything but
        // non-interactive and invisible to the user.
        position: "fixed",
        left: 0,
        top: 0,
        width: 720,
        opacity: 0,
        pointerEvents: "none",
        zIndex: -1,
        background: bg,
        padding: "32px 36px",
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        color: text,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 500,
          color: accentOnWhite,
          marginBottom: 20,
          letterSpacing: "0.01em",
        }}
      >
        {doc.name || "Sin título"}
      </div>
      {lines.map((line) => {
        const r = results[line.id];
        const hasResult = r && r.value !== null && r.value !== undefined;
        const lc = lineColor(line.id);
        return (
          <div
            key={line.id}
            style={{
              padding: "12px 0 10px",
              borderBottom: `1px solid ${isDark ? "#222630" : "#eee"}`,
              fontSize: 26,
              fontWeight: 300,
              lineHeight: 1.4,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            {line.name && line.name.trim() && (
              <div
                style={{
                  width: "100%",
                  fontSize: 12,
                  fontWeight: 700,
                  color: lc,
                  marginBottom: 2,
                  letterSpacing: "0.02em",
                }}
              >
                {line.name}
              </div>
            )}
            {line.tokens.map((tok) => (
              <React.Fragment key={tok.id}>{renderToken(tok, line)}</React.Fragment>
            ))}
            {hasResult && line.tokens.length > 0 && (
              <>
                <span style={{ color: equals, margin: "0 4px" }}>=</span>
                <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
                  {line.labels?.result && (
                    <span
                      style={{
                        fontSize: 11,
                        color: lc,
                        fontStyle: "italic",
                        fontWeight: 400,
                        opacity: 0.9,
                        lineHeight: 1,
                        marginBottom: 1,
                      }}
                    >
                      {line.labels.result}
                    </span>
                  )}
                  <span
                    style={{
                      display: "inline-block",
                      padding: "3px 14px",
                      borderRadius: 12,
                      border: `1.5px solid ${lc}`,
                      color: lc,
                      fontWeight: 400,
                    }}
                  >
                    {fmt(r.value)}
                  </span>
                </span>
              </>
            )}
          </div>
        );
      })}
      <div
        style={{
          marginTop: 24,
          fontSize: 11,
          color: muted,
          textAlign: "center",
          letterSpacing: "0.06em",
        }}
      >
        CALCU · {new Date().toLocaleDateString("es-ES")}
      </div>
    </div>
  );
});

function ShareBtn({ children, onClick, theme, accent }) {
  const t = theme || {};
  return (
    <button
      onClick={onClick}
      style={{
        background: t.keyBg || "#fff",
        border: `1px solid ${t.keypadBorder || t.tokenBorder || "#e5e5e5"}`,
        borderRadius: 10,
        padding: "8px 12px",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
        color: t.text || "#1a1a1a",
        display: "flex",
        alignItems: "center",
        gap: 10,
        transition: "transform 0.08s",
      }}
      onTouchStart={(e) => { e.currentTarget.style.transform = "scale(0.98)"; }}
      onTouchEnd={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
    >
      {children}
    </button>
  );
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


// ----------------------- Settings (full-screen) -----------------------
function SettingsPopup({ settings, updateSetting, onClose, theme, darkMode }) {
  const [subView, setSubView] = useState(null); // null | "decimal" | "text"
  const t = theme || {};
  const isDark = !!darkMode;
  const bg = isDark ? "#0f1115" : "#ffffff";
  const sectionBg = isDark ? "#161922" : "#ffffff";
  const sectionBorder = isDark ? "#222630" : "#eee";
  const text = isDark ? "#e8ecf3" : "#1a1a1a";
  const muted = isDark ? "#7a8090" : "#888";
  const dividerBg = isDark ? "#0a0c11" : "#f4f4f6";
  const accent = "#ADD010";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: bg,
        zIndex: 70,
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        color: text,
        userSelect: "none",
        WebkitUserSelect: "none",
        overflow: "auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          alignItems: "center",
          padding: "14px 16px",
          paddingTop: "calc(env(safe-area-inset-top) + 14px)",
          borderBottom: `1px solid ${sectionBorder}`,
        }}
      >
        <button
          onClick={() => (subView ? setSubView(null) : null)}
          style={{
            background: "transparent",
            border: "none",
            padding: 4,
            cursor: subView ? "pointer" : "default",
            color: subView ? accent : "transparent",
            fontFamily: "inherit",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 16,
            justifySelf: "start",
          }}
        >
          {subView && <CaretLeft size={20} weight="bold" />}
          {subView && <span>Atrás</span>}
        </button>
        <div style={{ fontSize: 16, fontWeight: 500, color: text, textAlign: "center" }}>
          {subView === "decimal" ? "Formato decimal" : subView === "text" ? "Tamaño del texto" : "Ajustes"}
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            padding: 4,
            cursor: "pointer",
            color: accent,
            fontFamily: "inherit",
            fontSize: 16,
            fontWeight: 600,
            justifySelf: "end",
          }}
        >
          OK
        </button>
      </div>

      {subView === null && (
        <SettingsRoot
          settings={settings}
          updateSetting={updateSetting}
          openSubView={setSubView}
          theme={{ bg, sectionBg, sectionBorder, text, muted, dividerBg, accent, isDark }}
        />
      )}
      {subView === "decimal" && (
        <SettingsDecimal
          settings={settings}
          updateSetting={updateSetting}
          theme={{ bg, sectionBg, sectionBorder, text, muted, dividerBg, accent, isDark }}
        />
      )}
      {subView === "text" && (
        <SettingsText
          settings={settings}
          updateSetting={updateSetting}
          theme={{ bg, sectionBg, sectionBorder, text, muted, dividerBg, accent, isDark }}
        />
      )}
    </div>
  );
}

function SettingsRoot({ settings, updateSetting, openSubView, theme }) {
  return (
    <div>
      {/* Group 1: angles, decimal, text */}
      <SettingsGroup theme={theme} marginTop={16}>
        <SettingsRow theme={theme} label="Ángulos">
          <SegmentedControl
            options={[
              { value: "rad", label: "Radianes" },
              { value: "deg", label: "Grados" },
            ]}
            value={settings.angleMode}
            onChange={(v) => updateSetting("angleMode", v)}
            theme={theme}
          />
        </SettingsRow>
        <SettingsRow theme={theme} label="Formato decimal" onClick={() => openSubView("decimal")}>
          <ChevronRightIcon color={theme.muted} />
        </SettingsRow>
        <SettingsRow theme={theme} label="Tamaño del texto" onClick={() => openSubView("text")} last>
          <ChevronRightIcon color={theme.muted} />
        </SettingsRow>
      </SettingsGroup>

      {/* Group 2: toggles */}
      <SettingsGroup theme={theme}>
        <SettingsRow
          theme={theme}
          label={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {settings.darkMode ? <Moon size={16} weight="bold" /> : <Sun size={16} weight="bold" />}
              <span>Tema oscuro</span>
            </span>
          }
        >
          <Toggle
            value={settings.darkMode}
            onChange={(v) => updateSetting("darkMode", v)}
            theme={theme}
          />
        </SettingsRow>
        <SettingsRow theme={theme} label="Zurdos" last>
          <Toggle
            value={settings.leftHanded}
            onChange={(v) => updateSetting("leftHanded", v)}
            theme={theme}
          />
        </SettingsRow>
      </SettingsGroup>
      <div style={{ height: 40 }} />
    </div>
  );
}

function SettingsDecimal({ settings, updateSetting, theme }) {
  const previewN = 1234.5679;
  return (
    <div>
      {/* Preview */}
      <SettingsGroup theme={theme} marginTop={16}>
        <div style={{ padding: "20px 16px", textAlign: "center", color: theme.accent, fontSize: 32, fontWeight: 300 }}>
          {fmtN(previewN, settings)}
        </div>
      </SettingsGroup>

      {/* Max decimals slider */}
      <SettingsGroup theme={theme}>
        <SettingsRow theme={theme} label="Máx. decimales">
          <span style={{ color: theme.text, fontVariantNumeric: "tabular-nums" }}>{settings.maxDecimals}</span>
        </SettingsRow>
        <div style={{ padding: "0 20px 16px", background: theme.sectionBg }}>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={settings.maxDecimals}
            onChange={(e) => updateSetting("maxDecimals", parseInt(e.target.value))}
            style={{ width: "100%", accentColor: theme.accent }}
          />
        </div>
        <SettingsRow theme={theme} label="Separadores de miles" last>
          <Toggle
            value={settings.thousandsSep}
            onChange={(v) => updateSetting("thousandsSep", v)}
            theme={theme}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Sci notation threshold */}
      <SettingsGroup theme={theme} title="Notación científica cuando">
        <SettingsRow theme={theme} label="Mayor que">
          <span style={{ color: theme.text, fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
            10^{settings.sciAbove}
          </span>
        </SettingsRow>
        <div style={{ padding: "0 20px 16px", background: theme.sectionBg }}>
          <input
            type="range"
            min={3}
            max={20}
            step={1}
            value={settings.sciAbove}
            onChange={(e) => updateSetting("sciAbove", parseInt(e.target.value))}
            style={{ width: "100%", accentColor: theme.accent }}
          />
        </div>
      </SettingsGroup>
      <div style={{ height: 40 }} />
    </div>
  );
}

function SettingsText({ settings, updateSetting, theme }) {
  const previewSize = 18 + (settings.textScale - 3) * 4;
  return (
    <div>
      {/* Preview */}
      <SettingsGroup theme={theme} marginTop={16}>
        <div style={{ padding: "26px 16px", textAlign: "center" }}>
          <span
            style={{
              color: theme.text,
              fontSize: previewSize,
              fontWeight: settings.textWeight === "bold" ? 600 : 400,
              fontFamily: '"Roboto Mono", ui-monospace, monospace',
            }}
          >
            1 + 2 = 3
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup theme={theme} title="Tamaño">
        <div style={{ padding: "16px 20px", background: theme.sectionBg, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: theme.text }}>A</span>
          <input
            type="range"
            min={0}
            max={6}
            step={1}
            value={settings.textScale}
            onChange={(e) => updateSetting("textScale", parseInt(e.target.value))}
            style={{ flex: 1, accentColor: theme.accent }}
          />
          <span style={{ fontSize: 22, color: theme.text }}>A</span>
        </div>
      </SettingsGroup>

      <SettingsGroup theme={theme} title="Peso">
        <SettingsRow theme={theme} label="Regular" onClick={() => updateSetting("textWeight", "regular")}>
          {settings.textWeight === "regular" && <Check size={16} weight="bold" style={{ color: theme.accent }} />}
        </SettingsRow>
        <SettingsRow theme={theme} label="Negrita" onClick={() => updateSetting("textWeight", "bold")} last>
          {settings.textWeight === "bold" && <Check size={16} weight="bold" style={{ color: theme.accent }} />}
        </SettingsRow>
      </SettingsGroup>
      <div style={{ height: 40 }} />
    </div>
  );
}

// ---- helper components ----
function SettingsGroup({ children, theme, title, marginTop }) {
  return (
    <div style={{ marginTop: marginTop ?? 28 }}>
      {title && (
        <div
          style={{
            fontSize: 11,
            color: theme.muted,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            padding: "0 16px 6px",
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          background: theme.sectionBg,
          borderTop: `1px solid ${theme.sectionBorder}`,
          borderBottom: `1px solid ${theme.sectionBorder}`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function SettingsRow({ label, children, onClick, last, theme }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 16px",
        background: theme.sectionBg,
        cursor: onClick ? "pointer" : "default",
        borderBottom: last ? "none" : `1px solid ${theme.sectionBorder}`,
      }}
    >
      <div style={{ fontSize: 16, color: theme.text }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>{children}</div>
    </div>
  );
}

function SegmentedControl({ options, value, onChange, theme }) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: theme.isDark ? "#1a2200" : "#f1eee6",
        borderRadius: 8,
        padding: 2,
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          onClick={(e) => { e.stopPropagation(); onChange(o.value); }}
          style={{
            background: value === o.value ? theme.accent : "transparent",
            color: value === o.value ? "#000" : theme.accent,
            border: "none",
            padding: "6px 14px",
            borderRadius: 6,
            fontFamily: "inherit",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            transition: "all 0.15s",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange, theme }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!value); }}
      style={{
        width: 46,
        height: 26,
        borderRadius: 13,
        background: value ? theme.accent : (theme.isDark ? "#3a3d46" : "#d0d0d0"),
        border: "none",
        cursor: "pointer",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
      }}
      aria-label="Alternar"
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: value ? 23 : 3,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "white",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transition: "left 0.2s",
        }}
      />
    </button>
  );
}

function ChevronRightIcon({ color }) {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
      <polyline points="1,1 9,7 1,13" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}



// ----------------------- Internal vars derived from doc -----------------------
// "Internal vars" are all labeled tokens (and labeled results) within the document.
function getInternalVars(lines, results) {
  const vars = [];
  for (const line of lines) {
    // Token labels (including labels.result) — each one is a "number" variable
    // with the value of that token / the line's result.
    if (line.labels) {
      for (const [key, name] of Object.entries(line.labels)) {
        if (!name || !name.trim()) continue;
        let value = null;
        if (key === "result") {
          value = results[line.id]?.value;
        } else {
          const tok = line.tokens.find((t) => t.id === key);
          if (!tok) continue;
          if (tok.kind === "num") value = tok.value;
          else if (tok.kind === "ref") value = results[tok.sourceId]?.value;
          else if (tok.kind === "tokenref") {
            const srcLine = lines.find((l) => l.id === tok.lineId);
            const srcTok = srcLine?.tokens.find((t) => t.id === tok.tokenId);
            value = srcTok && srcTok.kind === "num" ? srcTok.value : null;
          }
          else if (tok.kind === "globalref") continue; // already a global
          else continue;
        }
        vars.push({
          lineId: line.id,
          tokenId: key,
          name,
          value,
          kind: "number",
        });
      }
    }
    // Line name (separate from labels) — this is a "line" variable. The value
    // shown is the line's result, but the variable itself represents the
    // tokens of the line (used for inserting in Etapa 3.3).
    if (line.name && line.name.trim()) {
      vars.push({
        lineId: line.id,
        tokenId: "__line__",
        name: line.name,
        value: results[line.id]?.value,
        kind: "line",
      });
    }
  }
  return vars;
}

// ----------------------- Variables panel (replaces numpad) -----------------------
function VariablesPanel({
  tab,
  setTab,
  selection,
  internalVars,
  globals,
  onPickInternal,
  onPickGlobal,
  onCreateGlobal,
  onUpdateGlobal,
  onDeleteGlobal,
  onPromoteInternal,
  onDeleteInternal,
  formulas = [],
  onSaveLineAsFormula,
  onPasteFormula,
  onUpsertFormula,
  onDeleteFormula,
  activeLineId,
  lines = [],
  results = {},
  onSwitchToNumpad,
  onSwitchToShare,
  theme,
  darkMode,
}) {
  const t = theme || {};
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingGlobalId, setEditingGlobalId] = useState(null);
  const [editingFormulaId, setEditingFormulaId] = useState(null);
  const [editFormulaName, setEditFormulaName] = useState("");
  const [savingFormulaName, setSavingFormulaName] = useState("");
  const [showSaveFormulaInput, setShowSaveFormulaInput] = useState(false);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  // Open variable row menu — string of form "internal:lineId:tokenId" or "global:gid"
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const [searchText, setSearchText] = useState("");
  // Reset search when switching tabs.
  useEffect(() => { setSearchText(""); }, [tab]);
  const matches = (name) => {
    if (!searchText.trim()) return true;
    return (name || "").toLowerCase().includes(searchText.toLowerCase());
  };
  const confirmTimerRef = useRef(null);
  const askDelete = (id) => {
    if (confirmDeleteId === id) {
      // Second tap → execute delete
      clearTimeout(confirmTimerRef.current);
      setConfirmDeleteId(null);
      onDeleteGlobal(id);
      setEditingGlobalId(null);
      return;
    }
    setConfirmDeleteId(id);
    clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  };

  const isDark = !!darkMode;
  const tabInactiveBg = isDark ? "transparent" : "transparent";
  const tabActiveBg = isDark ? "#1c1f28" : "#ffffff";
  const accent = t.accent || "#ADD010";
  // Darker green for text/icons on white backgrounds (better contrast).
  const accentOnWhite = isDark ? accent : "#778D1C";
  const rowBg = isDark ? "#1c1f28" : "#ffffff";
  const rowBorder = isDark ? "#222630" : "#eee";
  const newRowBg = isDark ? "#1a2200" : "#f0f5d8";

  const list = tab === "internas" ? internalVars : globals;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        borderTop: `1px solid ${t.keypadBorder || "#e5e5e5"}`,
        background: t.keypadBg || "#EBEBEB",
        display: "flex",
        flexDirection: t.leftHanded ? "row-reverse" : "row",
        paddingBottom: "env(safe-area-inset-bottom)",
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        transition: "background 0.25s",
        height: 285,
      }}
    >
      {/* Left sidebar — switch back to numpad */}
      <div
        style={{
          display: "grid",
          gridTemplateRows: "repeat(3, 1fr)",
          background: t.keySidebar || "#ddd",
          width: 48,
        }}
      >
        <SideBtn onClick={(e) => { e.stopPropagation(); onSwitchToNumpad(); }} title="Volver al teclado" theme={t}>
          <CalculatorIcon size={18} weight="bold" style={{ color: t.textMuted || "#888" }} />
        </SideBtn>
        <SideBtn disabled theme={t} highlight>
          <Tag size={17} weight="bold" style={{ color: accentOnWhite }} />
        </SideBtn>
        <SideBtn onClick={(e) => { e.stopPropagation(); onSwitchToShare && onSwitchToShare(); }} title="Compartir" theme={t}>
          <Share size={17} weight="bold" style={{ color: t.textMuted || "#888" }} />
        </SideBtn>
      </div>

      {/* Main panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Tabs */}
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "8px 10px 6px",
            borderBottom: `1px solid ${t.keypadBorder || "#e5e5e5"}`,
          }}
        >
          <TabBtn active={tab === "internas"} onClick={() => setTab("internas")} theme={t}>
            <Tag size={14} weight="bold" />
            <span>Internas</span>
            <span style={{ opacity: 0.5, fontSize: 12 }}>· {internalVars.length}</span>
          </TabBtn>
          <TabBtn active={tab === "globales"} onClick={() => setTab("globales")} theme={t}>
            <Lock size={14} weight="bold" />
            <span>Globales</span>
            <span style={{ opacity: 0.5, fontSize: 12 }}>· {globals.length}</span>
          </TabBtn>
        </div>

        {/* List */}
        <div style={{ overflowY: "auto", padding: "6px 8px 8px", flex: 1 }}>
          {/* Create new global row */}
          {tab === "globales" && (
            <div
              style={{
                background: newRowBg,
                border: `1px solid ${accent}33`,
                borderRadius: 10,
                padding: "8px 10px",
                marginBottom: 6,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  const v = parseUserNumber(newValue);
                  const name = newName.trim();
                  if (!name) return;
                  await onCreateGlobal(name, isNaN(v) ? 0 : v);
                  setNewName("");
                  setNewValue("");
                }}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: accent,
                  border: "none",
                  color: "#000",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                aria-label="Crear variable global"
              >
                <Plus size={16} weight="bold" />
              </button>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="nombre"
                onClick={(e) => e.stopPropagation()}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  fontSize: 15,
                  color: accent,
                  fontFamily: "inherit",
                }}
              />
              <input
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="0"
                inputMode="decimal"
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: 80,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  fontSize: 15,
                  color: accent,
                  fontFamily: "inherit",
                  textAlign: "right",
                  fontVariantNumeric: "lining-nums tabular-nums",
                }}
              />
            </div>
          )}

          {/* List items */}
          {list.length === 0 && tab === "internas" && (
            <div style={{ textAlign: "center", padding: "30px 12px", color: t.textMuted, fontStyle: "italic", fontSize: 13 }}>
              etiqueta un valor para verlo aquí
            </div>
          )}
          {list.length === 0 && tab === "globales" && (
            <div style={{ textAlign: "center", padding: "30px 12px", color: t.textMuted, fontStyle: "italic", fontSize: 13 }}>
              crea una variable global arriba
            </div>
          )}

          {tab === "internas" && internalVars.filter((v) => matches(v.name)).map((v) => {
            const isActive =
              selection &&
              selection.kind !== "global" &&
              selection.lineId === v.lineId &&
              selection.target === v.tokenId;
            return (
              <div
                key={`${v.lineId}:${v.tokenId}`}
                onClick={(e) => { e.stopPropagation(); onPickInternal(v.lineId, v.tokenId); }}
                style={{
                  background: isActive ? `${accent}1a` : rowBg,
                  border: `1px solid ${isActive ? accent : rowBorder}`,
                  borderRadius: 10,
                  padding: "10px 12px",
                  marginBottom: 5,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  transition: "all 0.12s",
                }}
              >
                {v.kind === "line" ? (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={accentOnWhite} strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <line x1="3" y1="4" x2="13" y2="4" />
                    <line x1="3" y1="8" x2="13" y2="8" />
                    <line x1="3" y1="12" x2="13" y2="12" />
                  </svg>
                ) : (
                  <Tag size={14} weight="bold" style={{ color: accentOnWhite, flexShrink: 0 }} />
                )}
                <span style={{ flex: 1, fontSize: 15, color: accentOnWhite, fontWeight: isActive ? 500 : 400 }}>{v.name}</span>
                <span style={{ fontSize: 15, color: t.text || "#1a1a1a", fontVariantNumeric: "lining-nums tabular-nums" }}>
                  {v.value !== null && v.value !== undefined ? formatBarNumber(v.value) : "—"}
                </span>
                <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const key = `internal:${v.lineId}:${v.tokenId}`;
                      setOpenMenuKey((cur) => (cur === key ? null : key));
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 4,
                      cursor: "pointer",
                      color: t.textMuted || "#888",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    aria-label={`Editar "${v.name}"`}
                    title="Editar"
                  >
                    <PencilSimple size={14} weight="bold" />
                  </button>
                  {openMenuKey === `internal:${v.lineId}:${v.tokenId}` && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        right: 0,
                        marginTop: 4,
                        background: "#1a1a1a",
                        border: "1px solid #333",
                        borderRadius: 8,
                        padding: 4,
                        minWidth: 170,
                        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
                        zIndex: 50,
                      }}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuKey(null);
                          if (onPromoteInternal) onPromoteInternal(v);
                        }}
                        style={{
                          width: "100%", background: "transparent", border: "none",
                          padding: "10px 12px", cursor: "pointer", color: "#eee",
                          fontFamily: "inherit", fontSize: 14,
                          display: "flex", alignItems: "center", gap: 8,
                          textAlign: "left", borderRadius: 6,
                        }}
                      >
                        <Lock size={14} weight="bold" />
                        <span>Promover a global</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuKey(null);
                          if (onDeleteInternal) onDeleteInternal(v);
                        }}
                        style={{
                          width: "100%", background: "transparent", border: "none",
                          padding: "10px 12px", cursor: "pointer", color: "#ff8888",
                          fontFamily: "inherit", fontSize: 14,
                          display: "flex", alignItems: "center", gap: 8,
                          textAlign: "left", borderRadius: 6,
                        }}
                      >
                        <Trash size={14} weight="bold" />
                        <span>Borrar</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {tab === "globales" && globals.filter((g) => g.kind !== "line").filter((g) => matches(g.name)).map((g) => {
            const isEditing = editingGlobalId === g.id;
            const isActive = selection && selection.kind === "global" && selection.globalId === g.id;
            return (
              <div
                key={g.id}
                style={{
                  background: isActive ? `${accent}1a` : rowBg,
                  border: `1px solid ${isActive ? accent : rowBorder}`,
                  borderRadius: 10,
                  padding: "10px 12px",
                  marginBottom: 5,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  transition: "all 0.12s",
                }}
              >
                {isEditing ? (
                  <>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        flex: 1,
                        background: "transparent",
                        border: "none",
                        borderBottom: `1px solid ${accent}`,
                        outline: "none",
                        fontSize: 15,
                        color: accent,
                        fontFamily: "inherit",
                      }}
                    />
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      inputMode="decimal"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: 90,
                        background: "transparent",
                        border: "none",
                        borderBottom: `1px solid ${accent}`,
                        outline: "none",
                        fontSize: 15,
                        color: t.text || "#1a1a1a",
                        textAlign: "right",
                        fontFamily: "inherit",
                        fontVariantNumeric: "lining-nums tabular-nums",
                      }}
                    />
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const v = parseUserNumber(editValue);
                        await onUpdateGlobal({
                          ...g,
                          name: editName.trim() || g.name,
                          value: isNaN(v) ? g.value : v,
                        });
                        setEditingGlobalId(null);
                      }}
                      style={{
                        background: accent,
                        border: "none",
                        color: "#000",
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                      }}
                      aria-label="Guardar"
                    >
                      <Check size={14} weight="bold" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        askDelete(g.id);
                      }}
                      style={{
                        background: confirmDeleteId === g.id ? "#d44" : "transparent",
                        border: "none",
                        color: confirmDeleteId === g.id ? "white" : "#d44",
                        cursor: "pointer",
                        padding: confirmDeleteId === g.id ? "4px 8px" : 4,
                        borderRadius: 6,
                        fontSize: 11,
                        fontFamily: "inherit",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        transition: "all 0.15s",
                      }}
                      aria-label={confirmDeleteId === g.id ? "Confirmar eliminar" : "Eliminar"}
                    >
                      <Trash size={14} weight="bold" />
                      {confirmDeleteId === g.id && <span>borrar</span>}
                    </button>
                  </>
                ) : (
                  <>
                    <div
                      onClick={(e) => { e.stopPropagation(); onPickGlobal(g.id); }}
                      style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                    >
                      <Lock size={12} weight="bold" style={{ color: accentOnWhite }} />
                      <span style={{ fontSize: 15, color: accentOnWhite }}>{g.name}</span>
                    </div>
                    <span
                      onClick={(e) => { e.stopPropagation(); onPickGlobal(g.id); }}
                      style={{
                        fontSize: 15,
                        color: t.text || "#1a1a1a",
                        fontVariantNumeric: "lining-nums tabular-nums",
                        cursor: "pointer",
                      }}
                    >
                      {formatBarNumber(g.value)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingGlobalId(g.id);
                        setEditName(g.name);
                        setEditValue(formatForInput(g.value));
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: t.textMuted || "#888",
                        cursor: "pointer",
                        padding: 4,
                      }}
                      aria-label="Editar"
                    >
                      <PencilSimple size={14} weight="bold" />
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {/* Line globals — shown right below number globals in same tab. */}
          {tab === "globales" && globals.filter((g) => g.kind === "line").filter((g) => matches(g.name)).map((g) => {
            const isActive = selection && selection.kind === "global" && selection.globalId === g.id;
            return (
              <div
                key={g.id}
                onClick={(e) => { e.stopPropagation(); onPickGlobal(g.id); }}
                style={{
                  background: isActive ? `${accent}1a` : rowBg,
                  border: `1px solid ${isActive ? accent : rowBorder}`,
                  borderRadius: 10,
                  padding: "10px 12px",
                  marginBottom: 5,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  transition: "all 0.12s",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={accentOnWhite} strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <line x1="3" y1="4" x2="13" y2="4" />
                  <line x1="3" y1="8" x2="13" y2="8" />
                  <line x1="3" y1="12" x2="13" y2="12" />
                </svg>
                <span style={{ flex: 1, fontSize: 15, color: accentOnWhite, fontWeight: isActive ? 500 : 400 }}>{g.name}</span>
                <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const key = `globalLine:${g.id}`;
                      setOpenMenuKey((cur) => (cur === key ? null : key));
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 4,
                      cursor: "pointer",
                      color: t.textMuted || "#888",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    aria-label={`Editar "${g.name}"`}
                    title="Editar"
                  >
                    <PencilSimple size={14} weight="bold" />
                  </button>
                  {openMenuKey === `globalLine:${g.id}` && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        right: 0,
                        marginTop: 4,
                        background: "#1a1a1a",
                        border: "1px solid #333",
                        borderRadius: 8,
                        padding: 4,
                        minWidth: 170,
                        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
                        zIndex: 50,
                      }}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuKey(null);
                          const newName = window.prompt("Nuevo nombre", g.name);
                          if (newName && newName.trim() && onUpdateGlobal) {
                            onUpdateGlobal({ ...g, name: newName.trim() });
                          }
                        }}
                        style={{
                          width: "100%", background: "transparent", border: "none",
                          padding: "10px 12px", cursor: "pointer", color: "#eee",
                          fontFamily: "inherit", fontSize: 14,
                          display: "flex", alignItems: "center", gap: 8,
                          textAlign: "left", borderRadius: 6,
                        }}
                      >
                        <PencilSimple size={14} weight="bold" />
                        <span>Renombrar</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuKey(null);
                          if (onDeleteGlobal) onDeleteGlobal(g.id);
                        }}
                        style={{
                          width: "100%", background: "transparent", border: "none",
                          padding: "10px 12px", cursor: "pointer", color: "#ff8888",
                          fontFamily: "inherit", fontSize: 14,
                          display: "flex", alignItems: "center", gap: 8,
                          textAlign: "left", borderRadius: 6,
                        }}
                      >
                        <Trash size={14} weight="bold" />
                        <span>Borrar</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

        </div>

        {/* Search input pinned at bottom of panel. */}
        <div
          style={{
            padding: "8px 10px 10px",
            borderTop: `1px solid ${t.keypadBorder || "#e5e5e5"}`,
            background: t.keypadBg || "#EBEBEB",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: t.bg || "#fff",
              border: `1px solid ${rowBorder}`,
              borderRadius: 8,
              padding: "6px 10px",
            }}
          >
            <MagnifyingGlass size={14} weight="bold" style={{ color: t.textMuted || "#888", flexShrink: 0 }} />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="buscar…"
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                outline: "none",
                fontFamily: "inherit",
                fontSize: 16,
                color: t.text || "#1a1a1a",
                padding: 0,
                cursor: "text",
                userSelect: "text",
                WebkitUserSelect: "text",
                touchAction: "auto",
              }}
            />
            {searchText && (
              <button
                onClick={(e) => { e.stopPropagation(); setSearchText(""); }}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 2,
                  cursor: "pointer",
                  color: t.textMuted || "#888",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                aria-label="Limpiar búsqueda"
              >
                <X size={14} weight="bold" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children, theme }) {
  const t = theme || {};
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 14px",
        borderRadius: 18,
        background: active ? "#000000" : "transparent",
        border: active ? "1px solid #000000" : "1px solid transparent",
        color: active ? "#ffffff" : (t.textMuted || "#888"),
        fontFamily: "inherit",
        fontSize: 13,
        cursor: "pointer",
        transition: "all 0.15s",
      }}
    >
      {children}
    </button>
  );
}

// Build a short text preview of a formula's tokens (for display in fx tab list).
function formulaPreview(formula, globals) {
  const parts = [];
  for (const tok of formula.tokens) {
    if (tok.kind === "num") parts.push(fmt(tok.value));
    else if (tok.kind === "op") {
      parts.push(tok.value === "*" ? "×" : tok.value === "/" ? "÷" : tok.value);
    } else if (tok.kind === "paren") parts.push(tok.value);
    else if (tok.kind === "globalref") {
      const g = globals.find((x) => x.id === tok.globalId);
      parts.push(g ? g.name : "?");
    }
  }
  return parts.join(" ");
}

function FormulaRow({
  formula, globals, isEditing, editName, onStartEdit, onCancelEdit,
  onChangeEditName, onSaveEdit, onCopy, onDelete, theme, rowBg, rowBorder, accent, accentOnWhite,
}) {
  const t = theme || {};
  const acc = accentOnWhite || accent;
  const [confirmDel, setConfirmDel] = useState(false);
  const delTimer = useRef(null);
  const askDel = () => {
    if (confirmDel) {
      clearTimeout(delTimer.current);
      setConfirmDel(false);
      onDelete && onDelete();
      return;
    }
    setConfirmDel(true);
    clearTimeout(delTimer.current);
    delTimer.current = setTimeout(() => setConfirmDel(false), 3000);
  };
  return (
    <div
      style={{
        background: rowBg,
        border: `1px solid ${rowBorder}`,
        borderRadius: 10,
        padding: "10px 12px",
        marginBottom: 5,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          fontStyle: "italic",
          fontWeight: 500,
          fontSize: 13,
          color: acc,
          width: 24,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        fx
      </span>
      {isEditing ? (
        <>
          <input
            type="text"
            value={editName}
            onChange={(e) => onChangeEditName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              borderBottom: `1px solid ${accent}`,
              outline: "none",
              fontFamily: "inherit",
              fontSize: 14,
              color: acc,
              padding: "2px 0",
            }}
          />
          <button
            onClick={(e) => { e.stopPropagation(); onSaveEdit(); }}
            style={{
              background: accent, border: "none", borderRadius: 6,
              width: 26, height: 26, cursor: "pointer", color: "#000",
              display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}
            aria-label="Guardar nombre"
          >
            <Check size={13} weight="bold" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onCancelEdit(); }}
            style={{
              background: "transparent", border: `1px solid ${rowBorder}`, borderRadius: 6,
              width: 26, height: 26, cursor: "pointer", color: t.textMuted || "#888",
              display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}
            aria-label="Cancelar"
          >
            <X size={13} />
          </button>
        </>
      ) : (
        <>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                color: acc,
                fontWeight: 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {formula.name || "sin nombre"}
            </div>
            <div
              style={{
                fontSize: 11,
                color: t.textMuted || "#888",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                marginTop: 1,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formulaPreview(formula, globals)}
            </div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onCopy && onCopy(); }}
            style={{
              background: "transparent",
              border: `1px solid ${acc}66`,
              borderRadius: 6,
              padding: "4px 8px",
              cursor: "pointer",
              color: acc,
              fontFamily: "inherit",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              flexShrink: 0,
            }}
            aria-label="Insertar fórmula"
            title="Insertar en la línea activa"
          >
            <ClipboardText size={13} weight="bold" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onStartEdit && onStartEdit(); }}
            style={{
              background: "transparent",
              border: "none",
              padding: 4,
              cursor: "pointer",
              color: t.textMuted || "#888",
              flexShrink: 0,
            }}
            aria-label="Renombrar"
            title="Renombrar"
          >
            <Gear size={14} weight="bold" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); askDel(); }}
            style={{
              background: confirmDel ? "#d44" : "transparent",
              border: "none",
              padding: confirmDel ? "4px 8px" : 4,
              borderRadius: 6,
              cursor: "pointer",
              color: confirmDel ? "white" : "#d44",
              fontFamily: "inherit",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              transition: "all 0.15s",
            }}
            aria-label={confirmDel ? "Confirmar eliminar" : "Eliminar"}
          >
            <Trash size={13} weight="bold" />
            {confirmDel && <span>borrar</span>}
          </button>
        </>
      )}
    </div>
  );
}

// ----------------------- Standalone globals manager (from main screen) -----------------------
function GlobalsManager({ globals, onSave, onDelete, onBack, darkMode }) {
  const t = darkMode
    ? { bg: "#0f1115", card: "#161922", border: "#222630", text: "#e8ecf3", muted: "#7a8090", faint: "#4a4f5a", accent: "#ADD010", accentOnCard: "#ADD010", newRow: "#1a2200" }
    : { bg: "#EBEBEB", card: "#ffffff", border: "#eee", text: "#1a1a1a", muted: "#888", faint: "#bbb", accent: "#ADD010", accentOnCard: "#778D1C", newRow: "#f0f5d8" };
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const confirmTimerRef = useRef(null);
  const askDelete = (id) => {
    if (confirmDeleteId === id) {
      clearTimeout(confirmTimerRef.current);
      setConfirmDeleteId(null);
      onDelete(id);
      setEditingId(null);
      return;
    }
    setConfirmDeleteId(id);
    clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: t.bg,
        color: t.text,
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          paddingTop: "calc(env(safe-area-inset-top) + 12px)",
          borderBottom: `1px solid ${t.border}`,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <button
          onClick={onBack}
          style={{ background: "transparent", border: "none", padding: 4, cursor: "pointer" }}
        >
          <CaretLeft size={22} style={{ color: t.accentOnCard }} weight="bold" />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <Lock size={18} style={{ color: t.accentOnCard }} weight="bold" />
          <div style={{ fontSize: 18, fontWeight: 400 }}>Variables globales</div>
        </div>
      </div>

      <div style={{ padding: "12px 16px 80px" }}>
        {/* Create new */}
        <div
          style={{
            background: t.newRow,
            border: `1px solid ${t.accent}33`,
            borderRadius: 12,
            padding: "12px 14px",
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <button
            onClick={async () => {
              const name = newName.trim();
              if (!name) return;
              const v = parseUserNumber(newValue);
              await onSave({ id: uid(), name, value: isNaN(v) ? 0 : v, updatedAt: Date.now() });
              setNewName("");
              setNewValue("");
            }}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: t.accent,
              border: "none",
              color: "#000",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <Plus size={18} weight="bold" />
          </button>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="nombre de variable"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 16,
              color: t.accent,
              fontFamily: "inherit",
            }}
          />
          <input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            style={{
              width: 100,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 16,
              color: t.accent,
              fontFamily: "inherit",
              textAlign: "right",
              fontVariantNumeric: "lining-nums tabular-nums",
            }}
          />
        </div>

        {globals.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "40px 20px",
              color: t.muted,
              fontStyle: "italic",
              fontSize: 14,
            }}
          >
            todavía no hay variables globales
          </div>
        )}

        {/* Number globals — header only if there are also lines. */}
        {globals.filter((g) => g.kind !== "line").length > 0 && globals.filter((g) => g.kind === "line").length > 0 && (
          <div style={{ fontSize: 11, color: t.muted, textTransform: "uppercase", letterSpacing: "0.06em", margin: "8px 4px 6px" }}>
            números · {globals.filter((g) => g.kind !== "line").length}
          </div>
        )}

        {globals.filter((g) => g.kind !== "line").map((g) => {
            const isEditing = editingId === g.id;
            return (
              <div
                key={g.id}
                style={{
                  background: t.card,
                  border: `1px solid ${t.border}`,
                  borderRadius: 12,
                  padding: "12px 14px",
                  marginBottom: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                {isEditing ? (
                  <>
                    <Lock size={14} weight="bold" style={{ color: t.accentOnCard, flexShrink: 0 }} />
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{
                        flex: 1,
                        background: "transparent",
                        border: "none",
                        borderBottom: `1px solid ${t.accentOnCard}`,
                        outline: "none",
                        fontSize: 16,
                        color: t.accentOnCard,
                        fontFamily: "inherit",
                      }}
                    />
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      inputMode="decimal"
                      style={{
                        width: 100,
                        background: "transparent",
                        border: "none",
                        borderBottom: `1px solid ${t.accent}`,
                        outline: "none",
                        fontSize: 16,
                        color: t.text,
                        textAlign: "right",
                        fontFamily: "inherit",
                        fontVariantNumeric: "lining-nums tabular-nums",
                      }}
                    />
                    <button
                      onClick={async () => {
                        const v = parseUserNumber(editValue);
                        await onSave({
                          ...g,
                          name: editName.trim() || g.name,
                          value: isNaN(v) ? g.value : v,
                        });
                        setEditingId(null);
                      }}
                      style={{
                        background: t.accent,
                        border: "none",
                        color: "#000",
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                      }}
                    >
                      <Check size={16} weight="bold" />
                    </button>
                    <button
                      onClick={() => askDelete(g.id)}
                      style={{
                        background: confirmDeleteId === g.id ? "#d44" : "transparent",
                        border: "none",
                        color: confirmDeleteId === g.id ? "white" : "#d44",
                        cursor: "pointer",
                        padding: confirmDeleteId === g.id ? "6px 10px" : 4,
                        borderRadius: 6,
                        fontSize: 12,
                        fontFamily: "inherit",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        transition: "all 0.15s",
                      }}
                    >
                      <Trash size={16} weight="bold" />
                      {confirmDeleteId === g.id && <span>borrar</span>}
                    </button>
                  </>
                ) : (
                  <>
                    <Lock size={14} weight="bold" style={{ color: t.accentOnCard, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 16, color: t.accentOnCard }}>{g.name}</span>
                    <span
                      style={{
                        fontSize: 16,
                        color: t.text,
                        fontVariantNumeric: "lining-nums tabular-nums",
                      }}
                    >
                      {formatBarNumber(g.value)}
                    </span>
                    <button
                      onClick={() => {
                        setEditingId(g.id);
                        setEditName(g.name);
                        setEditValue(formatForInput(g.value));
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: t.muted,
                        cursor: "pointer",
                        padding: 4,
                      }}
                    >
                      <PencilSimple size={16} weight="bold" />
                    </button>
                  </>
                )}
              </div>
            );
          })}

        {/* Line globals — separate section. */}
        {globals.filter((g) => g.kind === "line").length > 0 && (
          <>
            <div style={{ fontSize: 11, color: t.muted, textTransform: "uppercase", letterSpacing: "0.06em", margin: "20px 4px 6px" }}>
              líneas · {globals.filter((g) => g.kind === "line").length}
            </div>
            {globals.filter((g) => g.kind === "line").map((g) => {
              const isEditing = editingId === g.id;
              return (
                <div
                  key={g.id}
                  style={{
                    background: t.card,
                    border: `1px solid ${t.border}`,
                    borderRadius: 12,
                    padding: "12px 14px",
                    marginBottom: 6,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={t.accentOnCard} strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
                    <line x1="3" y1="4" x2="13" y2="4" />
                    <line x1="3" y1="8" x2="13" y2="8" />
                    <line x1="3" y1="12" x2="13" y2="12" />
                  </svg>
                  {isEditing ? (
                    <>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        autoFocus
                        style={{
                          flex: 1,
                          background: "transparent",
                          border: "none",
                          borderBottom: `1px solid ${t.accentOnCard}`,
                          outline: "none",
                          fontSize: 16,
                          color: t.accentOnCard,
                          fontFamily: "inherit",
                        }}
                      />
                      <button
                        onClick={async () => {
                          const name = editName.trim();
                          if (!name) return;
                          await onSave({ ...g, name });
                          setEditingId(null);
                        }}
                        style={{
                          background: t.accent, border: "none", borderRadius: 6,
                          width: 30, height: 30, cursor: "pointer", color: "#000",
                          display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        }}
                      >
                        <Check size={14} weight="bold" />
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        style={{
                          background: "transparent", border: `1px solid ${t.border}`, borderRadius: 6,
                          width: 30, height: 30, cursor: "pointer", color: t.muted,
                          display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        }}
                      >
                        <X size={14} />
                      </button>
                      <button
                        onClick={() => askDelete(g.id)}
                        style={{
                          background: confirmDeleteId === g.id ? "#d44" : "transparent",
                          border: confirmDeleteId === g.id ? "none" : `1px solid #d4444466`,
                          borderRadius: 6,
                          padding: confirmDeleteId === g.id ? "0 10px" : 0,
                          width: confirmDeleteId === g.id ? "auto" : 30,
                          height: 30,
                          color: confirmDeleteId === g.id ? "#fff" : "#d44",
                          cursor: "pointer",
                          fontSize: 11,
                          fontFamily: "inherit",
                          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
                          flexShrink: 0,
                        }}
                      >
                        <Trash size={13} weight="bold" />
                        {confirmDeleteId === g.id && <span>borrar</span>}
                      </button>
                    </>
                  ) : (
                    <>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 16, color: t.accentOnCard, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {g.name || "sin nombre"}
                        </div>
                        <div style={{ fontSize: 11, color: t.muted, marginTop: 2, fontStyle: "italic" }}>
                          {(g.tokens || []).length} elementos
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setEditingId(g.id);
                          setEditName(g.name);
                        }}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: t.muted,
                          cursor: "pointer",
                          padding: 4,
                        }}
                        title="Renombrar"
                      >
                        <PencilSimple size={16} weight="bold" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ----------------------- Formulas Manager (full-screen) -----------------------
function FormulasManager({ formulas, globals, onUpsert, onDelete, onBack, darkMode }) {
  const t = darkMode
    ? { bg: "#0f1115", card: "#161922", border: "#222630", text: "#e8ecf3", muted: "#7a8090", faint: "#4a4f5a", accent: "#ADD010", accentOnCard: "#ADD010" }
    : { bg: "#EBEBEB", card: "#ffffff", border: "#eee", text: "#1a1a1a", muted: "#888", faint: "#bbb", accent: "#ADD010", accentOnCard: "#778D1C" };
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const confirmTimerRef = useRef(null);
  const askDelete = (id) => {
    if (confirmDeleteId === id) {
      clearTimeout(confirmTimerRef.current);
      setConfirmDeleteId(null);
      onDelete(id);
      setEditingId(null);
      return;
    }
    setConfirmDeleteId(id);
    clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 3000);
  };
  return (
    <div
      style={{
        minHeight: "100vh",
        background: t.bg,
        color: t.text,
        fontFamily: '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 16px",
          borderBottom: `1px solid ${t.border}`,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: t.card,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "transparent",
            border: "none",
            padding: 4,
            cursor: "pointer",
            color: t.accentOnCard,
            fontFamily: "inherit",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 16,
          }}
        >
          <CaretLeft size={20} weight="bold" />
          <span>Atrás</span>
        </button>
        <div style={{ flex: 1, textAlign: "center", fontSize: 16, fontWeight: 500 }}>
          <span style={{ fontStyle: "italic", color: t.accentOnCard, marginRight: 6 }}>fx</span>
          Fórmulas
        </div>
        <div style={{ width: 60 }} />
      </div>

      {/* Body */}
      <div style={{ padding: "16px" }}>
        {formulas.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "60px 20px",
              color: t.muted,
              fontStyle: "italic",
              fontSize: 14,
            }}
          >
            Aún no hay fórmulas guardadas.
            <div style={{ marginTop: 10, fontSize: 12, color: t.faint, fontStyle: "normal" }}>
              Para guardar una, abre un cálculo y usa el tab fx en el panel de variables.
            </div>
          </div>
        )}
        {formulas.map((f) => {
          const isEditing = editingId === f.id;
          return (
            <div
              key={f.id}
              style={{
                background: t.card,
                border: `1px solid ${t.border}`,
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span
                style={{
                  fontStyle: "italic",
                  fontWeight: 500,
                  fontSize: 16,
                  color: t.accentOnCard,
                  width: 28,
                  textAlign: "center",
                  flexShrink: 0,
                }}
              >
                fx
              </span>
              {isEditing ? (
                <>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    autoFocus
                    style={{
                      flex: 1,
                      background: "transparent",
                      border: "none",
                      borderBottom: `1px solid ${t.accentOnCard}`,
                      outline: "none",
                      fontFamily: "inherit",
                      fontSize: 16,
                      color: t.accentOnCard,
                      padding: "4px 0",
                    }}
                  />
                  <button
                    onClick={async () => {
                      const name = editName.trim();
                      if (!name) return;
                      await onUpsert({ ...f, name });
                      setEditingId(null);
                    }}
                    style={{
                      background: t.accent, border: "none", borderRadius: 6,
                      width: 30, height: 30, cursor: "pointer", color: "#000",
                      display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                    }}
                  >
                    <Check size={14} weight="bold" />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    style={{
                      background: "transparent", border: `1px solid ${t.border}`, borderRadius: 6,
                      width: 30, height: 30, cursor: "pointer", color: t.muted,
                      display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                    }}
                  >
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 16,
                        color: t.accentOnCard,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {f.name || "sin nombre"}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: t.muted,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        marginTop: 3,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formulaPreview(f, globals)}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setEditingId(f.id);
                      setEditName(f.name);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 6,
                      cursor: "pointer",
                      color: t.muted,
                      flexShrink: 0,
                    }}
                    aria-label="Renombrar"
                  >
                    <PencilSimple size={16} weight="bold" />
                  </button>
                  <button
                    onClick={() => askDelete(f.id)}
                    style={{
                      background: confirmDeleteId === f.id ? "#d44" : "transparent",
                      border: "none",
                      padding: confirmDeleteId === f.id ? "6px 10px" : 6,
                      borderRadius: 6,
                      cursor: "pointer",
                      color: confirmDeleteId === f.id ? "white" : "#d44",
                      fontFamily: "inherit",
                      fontSize: 12,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      flexShrink: 0,
                      transition: "all 0.15s",
                    }}
                  >
                    <Trash size={16} weight="bold" />
                    {confirmDeleteId === f.id && <span>borrar</span>}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
