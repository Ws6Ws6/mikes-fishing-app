#!/usr/bin/env python3
"""Capture phone + desktop screenshots of Mike's Fishing App."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "screenshots"
BASE = "http://127.0.0.1:8899/"
OUT.mkdir(parents=True, exist_ok=True)


def wait_ready(page, timeout=60000):
    page.goto(BASE, wait_until="networkidle", timeout=timeout)
    page.wait_for_function(
        "() => window.__mfa && window.__mfa.getLakes().length > 0", timeout=timeout
    )
    page.wait_for_timeout(1500)


def shot(page, name):
    path = OUT / name
    page.screenshot(path=str(path), full_page=False)
    print("wrote", path)


def close_card(page):
    page.evaluate(
        """() => {
      const c = document.getElementById('lakeCard');
      if (c) c.classList.add('hidden');
    }"""
    )


def run_viewport(browser, w, h, prefix):
    context = browser.new_context(
        viewport={"width": w, "height": h},
        device_scale_factor=2 if w < 500 else 1,
        is_mobile=w < 500,
        has_touch=w < 500,
    )
    page = context.new_page()
    wait_ready(page)

    # 1) zoomed out — streets + multiple lakes
    page.evaluate(
        """() => {
      window.__mfa.map.setView([41.45, -85.45], 9);
      document.getElementById('lakeCard').classList.add('hidden');
    }"""
    )
    page.wait_for_timeout(2200)
    shot(page, f"{prefix}_zoomed_out_streets.png")

    # 2) zoomed into Lake Wawasee with contours (rich 5ft data)
    page.evaluate("""() => window.__mfa.selectLakeByName('Lake Wawasee')""")
    page.wait_for_timeout(2000)
    close_card(page)
    page.evaluate(
        """() => {
      const m = window.__mfa.map;
      m.setZoom(14);
    }"""
    )
    page.wait_for_timeout(2500)
    shot(page, f"{prefix}_lake_contours.png")

    # 3) lake popup open (Oliver — good attributes)
    page.evaluate("""() => window.__mfa.selectLakeByName('Oliver Lake')""")
    page.wait_for_timeout(2500)
    shot(page, f"{prefix}_lake_popup.png")

    # 4) trolling mode deep zoom on Oliver
    page.evaluate("""() => window.__mfa.startTrollDemo('Oliver Lake')""")
    page.wait_for_timeout(4500)
    shot(page, f"{prefix}_trolling_mode.png")

    context.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path="/usr/bin/google-chrome",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        run_viewport(browser, 390, 844, "phone")
        run_viewport(browser, 1280, 800, "desktop")
        browser.close()
    print("done")


if __name__ == "__main__":
    main()
