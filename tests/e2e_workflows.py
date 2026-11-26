"""Opt-in Chromium regressions. Run: python -m pytest -q tests/e2e_workflows.py."""
import csv
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import pytest
from playwright.sync_api import Error, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def seed(tmp_path_factory):
    data = tmp_path_factory.mktemp("seed")
    env = {**os.environ, "KEEPSTACK_DATA_DIR": str(data), "KEEPSTACK_AI_ENABLED": "false",
           "KEEPSTACK_OCR_ENABLED": "false", "KEEPSTACK_ADMIN_USER": "admin",
           "KEEPSTACK_ADMIN_PASSWORD": "admin", "KEEPSTACK_SECRET_KEY": "e2e-only"}
    for command in (["keepstack", "seed"], ["keepstack.seed_search"]):
        subprocess.run([sys.executable, "-m", *command], env=env, cwd=ROOT, check=True, timeout=30)
    return data, env


@pytest.fixture
def base_url(tmp_path, seed):
    source, env = seed
    data = tmp_path / "data"
    shutil.copytree(source, data)
    with socket.socket() as address:
        address.bind(("127.0.0.1", 0))
        port = address.getsockname()[1]
    url = f"http://127.0.0.1:{port}"
    runtime = {**env, "KEEPSTACK_DATA_DIR": str(data), "KEEPSTACK_HOST": "127.0.0.1",
               "KEEPSTACK_PORT": str(port), "KEEPSTACK_BASE_URL": url}
    with (tmp_path / "server.log").open("w+") as output:
        server = subprocess.Popen([sys.executable, "-m", "keepstack"], env=runtime, cwd=ROOT,
                                  stdout=output, stderr=subprocess.STDOUT)
        try:
            for attempt in range(60):
                try:
                    with urlopen(url, timeout=0.25) as response:
                        if response.status == 200:
                            break
                except (URLError, TimeoutError):
                    if server.poll() is not None:
                        output.seek(0)
                        pytest.fail(output.read())
                    time.sleep(0.1)
            else:
                pytest.fail("Keepstack did not start")
            yield url
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            shutil.rmtree(data)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        yield browser
        browser.close()


@pytest.fixture
def page(browser, base_url, request):
    context = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    output = os.environ.get("KEEPSTACK_E2E_OUTPUT")
    if output:
        evidence = Path(output) / request.node.name
        evidence.mkdir(parents=True, exist_ok=True)
        context.tracing.start(screenshots=True, snapshots=True)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url)
    try:
        yield page
        assert not errors, errors
    finally:
        if output:
            try:
                page.screenshot(path=evidence / "final.jpg", quality=82, timeout=3000)
            except Error:
                pass
            context.tracing.stop(path=evidence / "trace.zip")
        context.close()


def login(page, user="admin", password="admin"):
    page.locator("#login-user").fill(user)
    page.locator("#login-pass").fill(password)
    page.get_by_role("button", name="Sign in").click()
    expect(page.locator("#user-label")).to_contain_text(user)


def export_rows(page, click):
    with page.expect_download() as pending:
        click()
    with pending.value.path().open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == ["uuid", "title", "description", "filename", "media_type", "tags", "created_at"]
        return list(reader)


def select_tag(page, group, name):
    picker = page.locator(f"#{group}-tags")
    if picker.get_attribute("open") is None:
        picker.locator("summary").press("Enter")
    picker.locator("input").fill(name)
    picker.get_by_role("button", name=name, exact=True).click()


def test_search_page_and_csv_keep_click_time_filters(page):
    login(page)
    locator = page.locator
    locator("#search").fill("harbor")
    locator("#filter-collection").select_option(label="Harbor campaign")
    locator("#filter-media").select_option("image")
    select_tag(page, "include", "approved")
    select_tag(page, "include", "campaign")
    select_tag(page, "exclude", "internal")
    select_tag(page, "exclude", "restricted")
    locator("#exclude-tags input").press("Escape")
    expect(locator("#page-summary")).to_have_text("1–12 of 15")
    card_ids = lambda: locator("#grid .card").evaluate_all("cards => cards.map(card => card.dataset.uuid)")
    first = card_ids()
    locator("#page-next").click()
    expect(locator("#page-summary")).to_have_text("13–15 of 15")
    last = card_ids()
    held = []
    page.route("**/api/assets/export.csv?*", lambda route: held.append(route), times=1)
    with page.expect_request(lambda request: "/export.csv?" in request.url):
        locator("#export-csv").click()
    locator("#search").fill("missing asset")
    expect(locator("#result-title")).to_have_text("Results (0)")
    assert [row["uuid"] for row in export_rows(page, held[0].continue_)] == first + last
    assert export_rows(page, locator("#export-csv").click) == []


def test_collections_and_one_save_edit_round_trip(page):
    login(page)
    locator = page.locator
    locator("[data-view=collections]").click()
    locator("#btn-new-collection").click()
    locator("#collection-new-name").fill("Browser review")
    page.get_by_role("button", name="Create empty collection").click()
    card = locator(".collection-card", has_text="Browser review")
    expect(card).to_contain_text("0 assets")
    card.click()
    expect(locator("#collection-name")).to_have_text("Browser review")
    expect(locator("#export-csv")).to_be_hidden()
    locator("#collection-add-assets").click()
    choices = locator("#collection-picker-grid input")
    expect(choices).to_have_count(12)
    for option in choices.all():
        option.check()
    locator("#collection-picker-next").click()
    expect(locator("#collection-picker-page")).to_contain_text("13–24")
    uuid = choices.first.get_attribute("value")
    choices.first.check()
    locator("#collection-picker-add").click()
    expect(locator("#collection-count")).to_have_text("13 assets")
    locator("#collection-next").click()
    expect(locator("#collection-grid .card")).to_have_count(1)
    locator(f'#collection-grid [data-uuid="{uuid}"]').click()
    title = "Browser edited harbor 港口"
    locator("#e-title").fill(title)
    description = '图注, "新版"\n第二行'
    locator("#e-description").fill(description)
    tags = locator("#edit-tag-picker")
    tags.locator("summary").click()
    tags.locator("input").fill('team/brand, "中文"')
    tags.get_by_role("button", name="Create").click()
    locator("#asset-collection-row").get_by_role("button", name="Remove from collection: Browser review").click()
    collections = locator("#edit-collection-picker")
    collections.locator("summary").click()
    collections.locator("input").fill("Harbor")
    collections.get_by_role("button", name="Harbor campaign", exact=True).click()
    collections.get_by_role("button", name="Add selected (1)", exact=True).click()
    expect(locator("#collection-count")).to_have_text("13 assets")
    page.route(f"**/api/assets/{uuid}", lambda route: route.fulfill(status=409, body="test-stale-collection"), times=1)
    locator("#d-save").click()
    expect(locator("#edit-message")).to_contain_text("Your changes are still here")
    expect(locator("#e-title")).to_have_value(title)
    expect(locator("#asset-collection-row")).to_contain_text("Harbor campaign")
    expect(locator("#collection-count")).to_have_text("13 assets")
    with page.expect_request(lambda request: request.method == "PATCH" and request.url.endswith(uuid)) as result:
        locator("#d-save").click()
    assert {"title", "tags", "collection_ids"} <= result.value.post_data_json.keys()
    expect(locator("#edit-message")).to_have_text("Saved")
    locator("#drawer-close").click()
    expect(locator("#collection-count")).to_have_text("12 assets")
    expect(locator("#collection-grid .card")).to_have_count(12)
    locator("#collection-back").click()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="Delete collection: Browser review").click()
    expect(card).to_have_count(0)
    locator("[data-view=library]").click()
    locator("#search").fill(title)
    locator("#filter-collection").select_option(label="Harbor campaign")
    expect(locator("#result-title")).to_have_text("Results (1)")
    row, = export_rows(page, locator("#export-csv").click)
    assert row["uuid"] == uuid and row["description"] == description
    assert 'team/brand, "中文"' in json.loads(row["tags"])


def test_viewer_session_and_filter_directory_failure(page):
    login(page)
    locator = page.locator
    locator("[data-view=audit]").click()
    expect(locator("#audit-rows tr").first).to_be_visible()
    locator("#btn-logout").click()
    login(page, "viewer", "demo1234")
    expect(locator("#audit-rows tr")).to_have_count(0)
    expect(locator("#btn-upload")).to_be_hidden()
    locator("[data-view=collections]").click()
    expect(locator("#btn-new-collection")).to_be_hidden()
    expect(locator(".collection-delete")).to_have_count(0)
    locator(".collection-card", has_text="Civic Communications").click()
    expect(locator("#collection-add-assets")).to_be_hidden()
    locator("#collection-grid .card").first.click()
    expect(locator("#d-download")).to_be_visible()
    expect(locator("#d-save")).to_have_count(0)
    expect(locator(".edit-picker")).to_have_count(0)
    locator("#drawer-close").click()
    page.set_viewport_size({"width": 360, "height": 800})
    page.route("**/api/tags", lambda route: route.fulfill(status=500, body="test-failure"), times=1)
    locator("[data-view=library]").click()
    expect(locator("#filter-error")).to_be_visible()
    locator("[data-view=library]").click()
    expect(locator("#filter-error")).to_be_hidden()
    locator("#include-tags summary").press("Enter")
    expect(locator("#include-tags input")).to_be_visible()
    viewport = page.evaluate("""() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
    })""")
    assert viewport["scrollWidth"] <= viewport["width"] + 1, viewport
    popup = locator("#include-tags .tag-picker").bounding_box()
    assert popup["x"] >= 0 and popup["x"] + popup["width"] <= viewport["width"], (popup, viewport)
    locator("#include-tags input").press("Escape")
    expect(locator("#include-tags input")).to_be_hidden()
    page.route("**/api/assets/export.csv?*", lambda route: route.fulfill(status=401, body="test-expiry"), times=1)
    locator("#export-csv").click()
    expect(locator("#login-error")).to_have_text("Session expired. Sign in again.")
    expect(locator("#grid .card")).to_have_count(0)


def test_upload_feedback_and_open_audit_refresh(page):
    login(page)
    locator = page.locator
    locator("[data-view=audit]").click()
    locator("#btn-upload").click()
    files = [
        {"name": "created.csv", "mimeType": "text/csv", "buffer": b"name,ok\nsample,true"},
        {"name": "renamed.csv", "mimeType": "text/csv", "buffer": b"name,ok\nsample,true"},
        {"name": "corrupt.png", "mimeType": "image/png", "buffer": b"not an image"},
    ]
    locator("#file-input").set_input_files(files)
    expect(locator("#upload-summary")).to_have_text("1 uploaded · 1 already exists · 1 failed")
    expect(locator(".upload-item.err")).to_contain_text("Invalid or unsupported image")
    expect(page.get_by_role("button", name="Retry corrupt.png")).to_be_visible()
    locator("#upload-cancel").click()
    expect(locator("#audit-rows")).to_contain_text("created.csv")
    expect(locator("#audit-rows")).not_to_contain_text("renamed.csv")


def test_matching_asset_pickers_keep_draft_until_save(page, base_url):
    login(page)
    locator = page.locator
    token = page.evaluate("localStorage.getItem('keepstack_token')")
    headers = {"Authorization": "Bearer " + token}
    for number in range(10):
        created = page.request.post(base_url + "/api/collections", headers=headers, data={"name": f"Picker test {number:02}"})
        assert created.ok
    card = locator("#grid .card", has_text="Library reading room (alt)")
    uuid = card.get_attribute("data-uuid")
    card.click()
    tags = locator("#edit-tag-picker")
    collections = locator("#edit-collection-picker")
    tags.locator("summary").press("Enter")
    expect(tags.locator(".tag-page")).to_contain_text("1 /")
    expect(tags.locator(".tag-options button")).to_have_count(8)
    expect(tags.get_by_role("button", name="Previous", exact=True)).to_be_disabled()
    tags.get_by_role("button", name="Next", exact=True).click()
    expect(tags.locator(".tag-page")).to_contain_text("2 /")
    tags.locator("input").fill("library")
    expect(tags.get_by_role("button", name="library · Already added", exact=True)).to_be_disabled()
    tags.locator("input").fill("approved")
    tags.get_by_role("button", name="approved", exact=True).click()
    tags.locator("input").fill("campaign")
    tags.get_by_role("button", name="campaign", exact=True).click()
    expect(locator("#tag-row")).not_to_contain_text("approved")
    tags.get_by_role("button", name="Add selected (2)", exact=True).click()
    expect(locator("#tag-row")).to_contain_text("approved")
    expect(locator("#tag-row")).to_contain_text("campaign")
    collections.locator("summary").click()
    expect(collections.locator(".tag-options button")).to_have_count(8)
    collections.get_by_role("button", name="Next", exact=True).click()
    expect(collections.locator(".tag-page")).to_contain_text("2 /")
    collections.locator("input").fill("Picker test 09")
    collections.get_by_role("button", name="Picker test 09", exact=True).click()
    expect(locator("#asset-collection-row")).not_to_contain_text("Picker test")
    collections.get_by_role("button", name="Add selected (1)", exact=True).click()
    expect(locator("#asset-collection-row")).to_contain_text("Picker test 09")
    detail = base_url + "/api/assets/" + uuid
    before = page.request.get(detail, headers=headers).json()
    assert "approved" not in {tag["name"] for tag in before["tags"]}
    assert "Picker test 09" not in {item["name"] for item in before["collections"]}
    locator("#d-save").click()
    expect(locator("#edit-message")).to_have_text("Saved")
    after = page.request.get(detail, headers=headers).json()
    assert {"approved", "campaign"} <= {tag["name"] for tag in after["tags"]}
    assert "Picker test 09" in {item["name"] for item in after["collections"]}
