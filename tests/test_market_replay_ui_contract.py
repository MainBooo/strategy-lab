from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "static" / "market-replay.js").read_text(encoding="utf-8")
CSS = (ROOT / "static" / "market-replay-mobile.css").read_text(encoding="utf-8")


def _method_block(name: str, next_marker: str) -> str:
    start = SOURCE.index(name)
    end = SOURCE.index(next_marker, start)
    return SOURCE[start:end]


def test_fullscreen_reuses_shared_controller_and_only_resizes_chart():
    assert "new CE.Fullscreen.FullscreenController(player" in SOURCE
    block = _method_block("_onFullscreenChange(active)", "// Buy/Sell are contextual")
    assert "this.core._onResize()" in block
    for forbidden in ("this._applyState(", "this._enterPlayer(", "fitContent(", "this._reset(", "fetch("):
        assert forbidden not in block


def test_replay_controls_have_single_existing_action_wiring():
    expected = {
        "#mrRestart": "this._reset()",
        "#mrStepBack": "this._stepBack()",
        "#mrStepFwd": "this._step()",
        "#mrPlayPause": "this._togglePlay()",
        "#mrBuy": "this._handleBuy()",
        "#mrSell": "this._handleSell()",
    }
    for selector, action in expected.items():
        pattern = re.escape(f'this.root.querySelector("{selector}").onclick') + r"\s*=\s*\(\)\s*=>\s*" + re.escape(action)
        assert len(re.findall(pattern, SOURCE)) == 1, selector


def test_mobile_trade_actions_precede_compact_transport_in_markup():
    assert SOURCE.index('class="mr-quick-trade"') < SOURCE.index('class="mr-transport"')
    assert 'id="mrBuy"' in SOURCE and ">Купить</button>" in SOURCE
    assert 'id="mrSell"' in SOURCE and ">Продать</button>" in SOURCE


def test_icon_controls_are_accessible_and_svg_based():
    for control_id in ("mrRestart", "mrStepBack", "mrPlayPause", "mrStepFwd", "mrGotoBtn", "mrFullscreenBtn"):
        start = SOURCE.index(f'id="{control_id}"')
        fragment = SOURCE[start:start + 320]
        assert "aria-label=" in fragment
    assert "ICN.restart" in SOURCE
    assert "ICN.stepBack" in SOURCE
    assert "ICN.play" in SOURCE
    assert "ICN.stepFwd" in SOURCE
    assert "ICN.calendar" in SOURCE


def test_fullscreen_css_has_ios_safe_area_and_fixed_fallback():
    assert ".mr-player.is-fullscreen" in CSS
    assert "position: fixed" in CSS
    assert "height: 100dvh" in CSS
    assert "env(safe-area-inset-bottom" in CSS
    assert "z-index: 9999" in CSS


def test_mobile_toolbar_is_one_compact_row_and_trade_buttons_are_prominent():
    mobile = CSS[CSS.index("@media (max-width: 560px)"):]
    assert ".mr-transport" in mobile
    assert "flex-wrap: nowrap" in CSS
    assert ".mr-quick-trade" in CSS
    assert "min-height: 48px" in CSS
