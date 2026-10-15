const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../app.js"), "utf8");

function fixture(position, reducedMotion) {
  const properties = {};
  const state = {};
  const heading = {
    setAttribute: (key, value) => { state[key] = value; },
    focus: (options) => { state.focus = options; },
  };
  const target = {
    querySelector: () => heading,
    scrollIntoView: (options) => { state.scroll = options; },
  };
  const container = {
    style: { setProperty: (key, value) => { properties[key] = value; } },
    querySelector: (selector) => selector === '[id="spending"]' ? target : null,
  };
  const link = {
    closest: () => nav,
    getAttribute: () => "#spending",
    removeAttribute: () => {},
    setAttribute: (key, value) => { state.current = value; },
  };
  const nav = {
    closest: () => container,
    getBoundingClientRect: () => ({ height: 52 }),
    querySelectorAll: () => [link],
  };
  const header = { getBoundingClientRect: () => ({ height: 124 }) };
  const ctx = vm.createContext({
    document: { querySelector: () => header, querySelectorAll: () => [nav] },
    window: { getComputedStyle: () => ({ position }), matchMedia: () => ({ matches: reducedMotion }) },
  });
  for (const name of ["updateSectionNavigationLayout", "jumpToSection"]) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0], ctx);
  }
  return { ctx, link, state, properties };
}

test("jump accounts for the actual sticky header and navigation height", () => {
  const { ctx, link, state, properties } = fixture("sticky", false);
  assert.equal(ctx.jumpToSection(link), true);
  assert.equal(properties["--section-nav-top"], "132px");
  assert.equal(properties["--section-jump-offset"], "200px");
  assert.equal(state.current, "location");
  assert.equal(state.focus.preventScroll, true);
  assert.equal(state.scroll.block, "start");
  assert.equal(state.scroll.behavior, "smooth");
});

test("mobile static header adds no offset and reduced motion skips animation", () => {
  const { ctx, link, state, properties } = fixture("static", true);
  ctx.jumpToSection(link);
  assert.equal(properties["--section-nav-top"], "8px");
  assert.equal(properties["--section-jump-offset"], "76px");
  assert.equal(state.scroll.behavior, "instant");
});

test("missing sections do not throw or move focus", () => {
  const { ctx, link, state } = fixture("sticky", false);
  link.getAttribute = () => "#missing";
  assert.equal(ctx.jumpToSection(link), false);
  assert.equal(state.focus, undefined);
});
