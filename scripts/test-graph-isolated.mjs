// Isolated client graph regression: node scripts/test-graph-isolated.mjs
// Executes the graph code from viewer.mjs in a minimal VM DOM with synthetic data.
// No viewer server, network, MCP process, or database is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'server/viewer.mjs'), 'utf8');
const start = source.indexOf('const REL_COLOR =');
const end = source.indexOf('\nconst KCOL =', start);
assert.ok(start >= 0 && end > start, 'graph client code boundaries must exist');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.listeners = {}; this.clientWidth = 860; this.innerHTML = ''; this.textContent = ''; this.value = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) {
    const event = { target: this, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 858, height: 680 }; }
}
const elements = new Map();
const $ = (selector) => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); };
const checks = ['similar', 'co_tag', 'ref'].map((rel) => { const e = new Element('input'); e.dataset.rel = rel; e.checked = true; return e; });
const fixture = {
  nodes: [
    { id: 1, kind: 'fact', label: 'alpha', tip: '<alpha>' },
    { id: 2, kind: 'procedure', label: 'beta', tip: 'beta' },
    { id: 3, kind: 'episode', label: 'gamma', tip: 'gamma' },
    { id: 4, kind: 'todo', label: 'isolated', tip: 'isolated' },
  ],
  links: [
    { source: 1, target: 2, rel: 'similar', weight: 1 },
    { source: 2, target: 3, rel: 'co_tag', weight: 2 },
    { source: 1, target: 3, rel: 'ref', weight: 2 },
  ],
};
const context = {
  $, K: { fact: ['事实'], procedure: ['方法'], episode: ['经历'], preference: ['偏好'], todo: ['待办'] },
  esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  document: { createElementNS: (_ns, tag) => new Element(tag), querySelectorAll: (selector) => { assert.equal(selector, '#grep input[type="checkbox"]'); return checks; } },
  fetch: async (url) => { assert.equal(url, '/api/graph'); return { json: async () => fixture }; },
  setTimeout, clearTimeout,
};
context.window = context;
vm.createContext(context);
vm.runInContext(source.slice(start, end), context, { filename: 'viewer-graph-client.js' });
await context.loadGraph();
assert.match($('#graph').innerHTML, /4 节点 · 3 边/);
const svg = $('#gcanvas').children[0];
assert.equal(svg.tagName, 'svg');
const lines = svg.children.filter((e) => e.tagName === 'line');
const groups = svg.children.filter((e) => e.tagName === 'g');
const circles = groups.map((g) => g.children.find((e) => e.tagName === 'circle'));
assert.equal(lines.length, 3); assert.equal(circles.length, 4);
assert.ok(circles.every((c) => Number.isFinite(Number(c.getAttribute('cx'))) && Number.isFinite(Number(c.getAttribute('cy')))));

// The click handler must focus one-hop neighbors, dim unrelated nodes and escape the tip.
circles[0].dispatch('mousedown'); circles[0].dispatch('click');
assert.equal($('#gbar').style.display, 'block');
assert.match($('#gtip').innerHTML, /#1/); assert.match($('#gtip').innerHTML, /&lt;alpha&gt;/);
assert.equal(circles[1].getAttribute('fill-opacity'), '0.95');
assert.equal(circles[3].getAttribute('fill-opacity'), '0.05');
context.__graphExit(); assert.equal($('#gbar').style.display, 'none');

// Two move events: first crosses threshold, second updates the node and its edges.
const oldX = circles[0].getAttribute('cx');
circles[0].dispatch('mousedown', { clientX: 100, clientY: 100 });
svg.dispatch('mousemove', { clientX: 110, clientY: 110 });
svg.dispatch('mousemove', { clientX: 240, clientY: 280 });
svg.dispatch('mouseup');
assert.notEqual(circles[0].getAttribute('cx'), oldX);
assert.equal(circles[0].getAttribute('cx'), '240'); assert.equal(circles[0].getAttribute('cy'), '280');
assert.equal(lines[0].getAttribute('x1'), '240'); assert.equal(lines[2].getAttribute('y1'), '280');
circles[0].dispatch('click'); assert.equal($('#gbar').style.display, 'none', 'drag must not trigger focus');

// Relation controls hide only matching edges and restore them when checked again.
const original = lines.map((line) => line.getAttribute('stroke-opacity'));
checks[0].checked = false; checks[0].dispatch('change');
assert.equal(lines[0].getAttribute('stroke-opacity'), '0');
assert.equal(lines[1].getAttribute('stroke-opacity'), original[1]);
assert.equal(lines[2].getAttribute('stroke-opacity'), original[2]);
checks[0].checked = true; checks[0].dispatch('change');
assert.equal(lines[0].getAttribute('stroke-opacity'), original[0]);
console.log('PASS: isolated VM graph render, click focus, node drag and connected edges, relation filtering');
