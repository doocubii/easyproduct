#!/usr/bin/env python3
"""HTML 파일을 PNG로 변환한다 (디자인 안 미리보기용).

사용법:
    python render_png.py file1.html file2.html ...
    python render_png.py *.html --width 1200

- Playwright(headless Chromium)로 전체 페이지를 이미지로 만든다.
- Playwright가 없으면 설치를 시도하고, 실패하면 PNG를 건너뛰고 안내만 한다
  (배치 흐름이 통째로 멈추지 않도록).
- 결과 PNG는 입력 HTML과 같은 이름/위치에 .png 로 저장된다.
"""
import argparse
import subprocess
import sys
from pathlib import Path


def ensure_playwright():
    """Playwright와 Chromium을 준비한다. 성공하면 True."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        print("· Playwright가 없어 설치를 시도합니다...")
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "playwright", "--break-system-packages"],
                check=True,
            )
        except Exception as e:
            print(f"· Playwright 설치 실패: {e}")
            return False
    # 브라우저 바이너리 확보
    try:
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True)
    except Exception as e:
        print(f"· Chromium 설치 실패: {e}")
        return False
    return True


def render(html_paths, width):
    from playwright.sync_api import sync_playwright

    made = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": 900},
                                device_scale_factor=2)
        for hp in html_paths:
            hp = Path(hp).resolve()
            if not hp.exists():
                print(f"· 건너뜀(파일 없음): {hp}")
                continue
            out = hp.with_suffix(".png")
            page.goto(hp.as_uri())
            page.wait_for_timeout(400)  # 웹폰트·렌더 안정화
            page.screenshot(path=str(out), full_page=True)
            print(f"✅ {out.name}")
            made.append(str(out))
        browser.close()
    return made


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("html", nargs="+", help="변환할 HTML 파일들")
    ap.add_argument("--width", type=int, default=1200, help="렌더 폭(px), 기본 1200")
    args = ap.parse_args()

    if not ensure_playwright():
        print("\n⚠️  PNG 변환기를 쓸 수 없습니다. HTML은 그대로 두고 PNG만 건너뜁니다.")
        print("    (사용자에게는 HTML 미리보기로 안내하세요.)")
        sys.exit(0)  # 배치가 실패로 죽지 않도록 정상 종료

    made = render(args.html, args.width)
    if not made:
        print("⚠️  만들어진 PNG가 없습니다. HTML 미리보기로 대체하세요.")


if __name__ == "__main__":
    main()
