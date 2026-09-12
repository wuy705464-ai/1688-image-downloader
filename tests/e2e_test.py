import json
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "1688_image_downloader.user.js"


PRODUCT_HTML = """<!doctype html>
<html><head><title>备用标题 - 阿里巴巴</title></head><body>
  <h1>测试珍珠项链</h1>
  <div class="price-range">¥ 8.80 - 12.50</div>
  <div class="start-amount">2 件起批</div>
  <div class="company-name">义乌市测试饰品有限公司</div>
  <div class="offer-gallery">
    <img width="600" height="600" src="https://cbu01.alicdn.com/img/ibank/first.jpg_300x300.jpg">
    <div class="video-thumb"><img width="600" height="600" src="https://cbu01.alicdn.com/img/ibank/video-cover.jpg"></div>
    <img width="600" height="600" src="https://cbu01.alicdn.com/img/ibank/second.jpg_300x300.jpg">
    <img width="600" height="600" src="https://cbu01.alicdn.com/img/ibank/third.jpg">
    <img width="600" height="600" src="https://cbu01.alicdn.com/img/ibank/fourth.jpg">
    <img width="600" height="600" src="https://cbu01.alicdn.com/img/ibank/fifth.jpg">
    <img width="600" height="600" src="https://cbu01.alicdn.com/img/ibank/sixth.jpg">
  </div>
</body></html>"""


def install_stubs(page, storage):
    initial = json.dumps(storage, ensure_ascii=False)
    script = """(() => {
          window.__store = __INITIAL__;
          window.__downloads = [];
          window.GM_getValue = (key, fallback) => Object.prototype.hasOwnProperty.call(window.__store, key) ? window.__store[key] : fallback;
          window.GM_setValue = (key, value) => { window.__store[key] = value; };
          window.GM_addStyle = css => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); };
          window.GM_download = options => { window.__downloads.push({url: options.url, name: options.name}); setTimeout(options.onload, 0); };
        })()""".replace("__INITIAL__", initial)
    page.add_init_script(script)


def run_product_test(browser):
    context = browser.new_context()
    page = context.new_page()
    page.on("pageerror", lambda error: print("pageerror:", error))
    task = {
        "url": "https://detail.1688.com/offer/123456789.html",
        "type": "product",
        "status": "visiting",
    }
    storage = {
        "a1688_image_downloader_tasks_v1": json.dumps([task]),
        "a1688_image_downloader_run_v1": json.dumps({"active": True, "returnUrl": task["url"]}),
        "a1688_image_downloader_settings_v1": json.dumps({"outputMode": "download"}),
    }
    install_stubs(page, storage)
    page.route("https://detail.1688.com/**", lambda route: route.fulfill(
        status=200,
        headers={"content-type": "text/html; charset=utf-8"},
        body=PRODUCT_HTML.encode("utf-8"),
    ))
    page.goto(task["url"])
    page.add_script_tag(path=str(SCRIPT))
    try:
        page.wait_for_function("JSON.parse(window.__store['a1688_image_downloader_tasks_v1'])[0].status === 'done'", timeout=20000)
    except Exception:
        print("state:", page.evaluate("window.__store"))
        print("downloads:", page.evaluate("window.__downloads"))
        print("status:", page.locator("#a1688-status").inner_text())
        print("images:", page.evaluate("[...document.images].map(i => ({src:i.getAttribute('src'), current:i.currentSrc, w:i.width, nw:i.naturalWidth}))"))
        raise
    saved = page.evaluate("JSON.parse(window.__store['a1688_image_downloader_tasks_v1'])[0]")
    downloads = page.evaluate("window.__downloads")

    assert saved["offerId"] == "123456789"
    assert saved["title"] == "测试珍珠项链"
    assert saved["price"] == "¥ 8.80 - 12.50"
    assert saved["moq"] == "2 件起批"
    assert saved["shopName"] == "义乌市测试饰品有限公司"
    assert len(downloads) == 4
    assert all("video-cover" not in item["url"] for item in downloads)
    assert downloads[0]["url"].endswith("/second.jpg")
    assert downloads[-1]["url"].endswith("/fifth.jpg")
    assert "123456789" in downloads[0]["name"]
    assert downloads[0]["name"].endswith("图2.jpg")
    assert downloads[-1]["name"].endswith("图5.jpg")
    page.evaluate("""() => {
      window.__exportBlob = null;
      URL.createObjectURL = blob => { window.__exportBlob = blob; return 'blob:test'; };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = () => {};
    }""")
    page.locator("#a1688-export").click()
    csv_text = page.evaluate("window.__exportBlob.text()")
    assert "商品ID,商品标题" not in csv_text  # CSV fields are intentionally quoted.
    assert '"商品ID","商品标题","价格"' in csv_text
    assert '"123456789","测试珍珠项链","¥ 8.80 - 12.50"' in csv_text
    context.close()


def run_direct_image_link_only_test(browser):
    context = browser.new_context()
    page = context.new_page()
    direct = "https://cbu01.alicdn.com/img/ibank/direct.png"
    storage = {
        "a1688_image_downloader_tasks_v1": json.dumps([{"url": direct, "type": "image", "status": "pending"}]),
        "a1688_image_downloader_run_v1": json.dumps({"active": True, "returnUrl": "https://www.1688.com/"}),
    }
    install_stubs(page, storage)
    page.route("https://www.1688.com/", lambda route: route.fulfill(status=200, content_type="text/html", body="<html><body></body></html>"))
    page.goto("https://www.1688.com/")
    page.add_script_tag(path=str(SCRIPT))
    page.wait_for_function("JSON.parse(window.__store['a1688_image_downloader_tasks_v1'])[0].status === 'done'", timeout=8000)
    downloads = page.evaluate("window.__downloads")
    saved = page.evaluate("JSON.parse(window.__store['a1688_image_downloader_tasks_v1'])[0]")
    assert downloads == []
    assert saved["images"] == [direct]
    assert saved["downloaded"] == 0
    context.close()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        )
        try:
            run_product_test(browser)
            run_direct_image_link_only_test(browser)
        finally:
            browser.close()
    print("2 end-to-end browser checks passed")


if __name__ == "__main__":
    main()
