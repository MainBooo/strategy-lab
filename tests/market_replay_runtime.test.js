const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    if (force === undefined) {
      if (this.values.has(name)) { this.values.delete(name); return false; }
      this.values.add(name); return true;
    }
    if (force) this.values.add(name);
    else this.values.delete(name);
    return !!force;
  }
}

class FakeElement {
  constructor() {
    this.innerHTML = "";
    this.textContent = "";
    this.title = "";
    this.disabled = false;
    this.value = "";
    this.className = "";
    this.classList = new FakeClassList();
    this.attrs = {};
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name]; }
}

const body = new FakeElement();
const windowTarget = {
  ChartEngine: {
    Fullscreen: { FullscreenController: class {} },
  },
  LightweightCharts: {},
};
const documentTarget = {
  body,
  activeElement: null,
  head: null,
  addEventListener() {},
};
const context = vm.createContext({
  window: windowTarget,
  document: documentTarget,
  console,
  Math,
  Date,
  Intl,
  JSON,
  Object,
  Array,
  Set,
  Map,
  Number,
  String,
  Boolean,
  Promise,
  setInterval: () => 1,
  clearInterval: () => {},
  requestAnimationFrame: (cb) => cb(),
});

const source = fs.readFileSync("static/market-replay.js", "utf8");
vm.runInContext(source, context);
const Page = windowTarget.MarketReplayPage;

(function fullscreenResizeDoesNotMutateReplayState() {
  const fullscreenBtn = new FakeElement();
  const menuPanel = new FakeElement();
  menuPanel.classList.add("hidden");
  const menuBtn = new FakeElement();
  const elements = {
    "#mrFullscreenBtn": fullscreenBtn,
    "#mrSessionMenuPanel": menuPanel,
    "#mrSessionMenuBtn": menuBtn,
  };
  Page.root = { querySelector: (selector) => elements[selector] || null };
  const state = {
    session: { id: "session-42", position_side: "long" },
    reveal_index: 31,
    total_available: 2351,
  };
  Page.state = state;
  let resizeCount = 0;
  Page.core = { _onResize() { resizeCount += 1; } };

  Page._onFullscreenChange(true);
  assert.strictEqual(Page.state, state, "fullscreen must retain the exact Replay state object");
  assert.strictEqual(Page.state.session.id, "session-42");
  assert.strictEqual(Page.state.reveal_index, 31);
  assert.strictEqual(resizeCount, 1, "fullscreen change should only resize the existing ChartCore");
  assert.strictEqual(fullscreenBtn.getAttribute("aria-pressed"), "true");
  assert.ok(fullscreenBtn.innerHTML.includes("<svg"), "fullscreen button should stay SVG-based");
  assert.strictEqual(body.classList.contains("mr-fullscreen-active"), true);

  Page._onFullscreenChange(false);
  assert.strictEqual(Page.state, state);
  assert.strictEqual(resizeCount, 2);
  assert.strictEqual(fullscreenBtn.getAttribute("aria-pressed"), "false");
  assert.strictEqual(body.classList.contains("mr-fullscreen-active"), false);
})();

(function buySellStillDispatchExactlyOneExistingBusinessAction() {
  const actions = [];
  Page._order = (action) => actions.push(action);

  Page.state = { session: { position_side: null } };
  Page._handleBuy();
  Page._handleSell();

  Page.state = { session: { position_side: "long" } };
  Page._handleSell();

  Page.state = { session: { position_side: "short" } };
  Page._handleBuy();

  assert.deepStrictEqual(actions, ["buy", "short", "close", "close"]);
})();

(function playButtonReflectsPlayingStateWithoutChangingPlaybackLogic() {
  const play = new FakeElement();
  Page.root = { querySelector: (selector) => selector === "#mrPlayPause" ? play : null };

  Page.playing = false;
  Page._updatePlayButton();
  assert.strictEqual(play.getAttribute("aria-label"), "Играть");
  assert.strictEqual(play.getAttribute("aria-pressed"), "false");
  assert.ok(play.innerHTML.includes("<svg"));

  Page.playing = true;
  Page._updatePlayButton();
  assert.strictEqual(play.getAttribute("aria-label"), "Пауза");
  assert.strictEqual(play.getAttribute("aria-pressed"), "true");
  assert.ok(play.innerHTML.includes("<svg"));
})();

(function sourceContractsPreventDuplicateHandlersAndReplayResetOnFullscreen() {
  assert.strictEqual((source.match(/querySelector\("#mrBuy"\)\.onclick/g) || []).length, 1);
  assert.strictEqual((source.match(/querySelector\("#mrSell"\)\.onclick/g) || []).length, 1);
  assert.ok(source.indexOf('class="mr-quick-trade"') < source.indexOf('class="mr-transport"'),
    "Buy/Sell must be placed before compact transport controls in the mobile-first stack");

  const fsStart = source.indexOf("_onFullscreenChange(active)");
  const fsEnd = source.indexOf("\n    // Buy/Sell are contextual", fsStart);
  const fsBody = source.slice(fsStart, fsEnd);
  for (const forbidden of ["_applyState(", "_enterPlayer(", "fitContent(", "_reset(", "fetch("]) {
    assert.strictEqual(fsBody.includes(forbidden), false, `fullscreen handler must not call ${forbidden}`);
  }

  for (const id of ["mrRestart", "mrStepBack", "mrPlayPause", "mrStepFwd", "mrGotoBtn", "mrFullscreenBtn"]) {
    const pos = source.indexOf(`id="${id}"`);
    assert.ok(pos >= 0, `${id} must exist`);
    assert.ok(source.slice(pos, pos + 260).includes("aria-label="), `${id} must have aria-label`);
  }
})();

const css = fs.readFileSync("static/market-replay-mobile.css", "utf8");
assert.ok(css.includes(".mr-player.is-fullscreen"));
assert.ok(css.includes("position: fixed"));
assert.ok(css.includes("env(safe-area-inset-bottom"));
assert.ok(css.includes("@media (max-width: 560px)"));
assert.ok(css.includes(".mr-quick-trade"));

console.log("market_replay_runtime.test.js: OK");
