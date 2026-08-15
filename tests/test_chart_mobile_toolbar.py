from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOBILE = ROOT / "static" / "chart-mobile-toolbar-v3.js"
LOADER = ROOT / "static" / "chart-terminal-loader.js"
FIXES = ROOT / "static" / "chart-editor-terminal-fixes.js"


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_mobile_toolbar_has_single_owner_without_mutation_observer():
    js = source(MOBILE)
    assert "MutationObserver" not in js
    assert "gtIndicatorsMenu" in js
    assert "gtMoreMenu" in js
    assert "gtIndicatorsPop" in js
    assert "gtMorePop" in js
    assert "portalPopover" in js


def test_mobile_toolbar_keeps_core_controls_and_hides_secondary_actions():
    js = source(MOBILE)
    for token in ("gt-ticker", "gt-tf", "gt-type", "gtIndicatorsBtn", "gtMoreBtn"):
        assert token in js
    for control in (
        "gtTemplatesMenu",
        "gtAlertsMenu",
        "gtReplayBtn",
        "caUndoBtn",
        "caRedoBtn",
        "gtSaveBtn",
        "gtSettingsBtn",
        "caSnapshotBtn",
    ):
        assert control in js


def test_loader_does_not_run_desktop_overflow_algorithm_on_phone():
    js = source(LOADER)
    assert "if (isPhone())" in js
    assert "Visibility on phones is owned exclusively by chart-mobile-toolbar-v3" in js
    assert "@media (min-width:769px)" in js


def test_compat_layer_no_longer_owns_mobile_more_menu():
    js = source(FIXES)
    assert "_renderMorePopover = function" not in js
    assert "chart-mobile-toolbar-v3.js" in js
