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


def test_sign_out_and_show_specific_login_errors(page):
    login(page)
    page.get_by_role("button", name="Sign out").click()
    sign_in = page.get_by_role("button", name="Sign in")
    error = page.locator("#login-error")
    page.locator("#login-pass").fill("wrong-password")
    sign_in.click()
    expect(error).to_have_text("Invalid credentials")

    page.locator("#login-pass").fill("admin")
    login_route = "**/api/auth/login"
    page.route(login_route, lambda route: route.fulfill(status=500, body="Internal Server Error"), times=1)
    sign_in.click()
    expect(error).to_have_text("Could not sign in. Please try again.")
    page.route(login_route, lambda route: route.fulfill(status=429), times=1)
    sign_in.click()
    expect(error).to_have_text("Too many failed attempts. Try again later.")
    login(page)
    expect(error).to_be_hidden()


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


def select_collection(page, name):
    picker = page.locator("#filter-collection")
    picker.locator("summary").press("Enter")
    picker.get_by_role("searchbox").fill(name)
    picker.get_by_role("button", name=name, exact=True).click()


def test_search_page_and_csv_keep_click_time_filters(page):
    login(page)
    locator = page.locator
    locator("#search").fill("harbor")
    select_collection(page, "Harbor campaign")
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
    page.route("**/api/assets/export.csv?*", lambda route: route.fulfill(status=500), times=1)
    locator("#export-csv").click()
    expect(locator("#toast")).to_have_text("CSV export failed. Try again.")
    expect(locator("#export-csv")).to_be_enabled()


def test_library_reset_stale_response_and_retry(page):
    login(page)
    locator = page.locator
    search = locator("#search")
    search.fill("harbor")
    select_collection(page, "Harbor campaign")
    loc_grid = locator("#grid .card")
    expect(loc_grid).to_have_count(12)
    expect(locator("#page-prev")).to_be_disabled()
    first_page = loc_grid.first.get_attribute("data-uuid")
    locator("#page-next").click()
    expect(locator("#page-summary")).to_contain_text("13–")
    expect(locator("#page-next")).to_be_disabled()
    oldest = loc_grid.last.get_attribute("data-uuid")
    locator("#page-prev").click()
    expect(loc_grid.first).to_have_attribute("data-uuid", first_page)
    locator("#page-next").click()
    expect(loc_grid.last).to_have_attribute("data-uuid", oldest)
    locator("#sort").select_option("oldest")
    expect(locator("#page-summary")).to_contain_text("1–12")
    expect(loc_grid.first).to_have_attribute("data-uuid", oldest)
    locator("#page-next").click()
    expect(locator("#page-summary")).to_contain_text("13–")

    held = []
    pattern = "**/api/assets?*"
    page.route("**/api/assets?q=harbor+view&*", lambda route: held.append(route), times=1)
    with page.expect_request(lambda request: "/api/assets?q=harbor+view&" in request.url) as first_search:
        search.fill("harbor view")
    assert first_search.value.url.endswith("&offset=0")
    search.fill("no such asset")
    expect(locator("#result-title")).to_have_text("Results (0)")
    stale = held[0].fetch()
    assert stale.ok and stale.json()["total"] > 0
    with page.expect_response(lambda response: "/api/assets?q=harbor+view&" in response.url):
        held[0].fulfill(response=stale)
    page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    expect(locator("#result-title")).to_have_text("Results (0)")

    page.route(pattern, lambda route: route.fulfill(status=500), times=1)
    search.fill("harbor")
    expect(locator("#library-error")).to_be_visible()
    expect(loc_grid).to_have_count(0)
    expect(locator("#export-csv")).to_be_disabled()
    locator("#library-retry").click()
    expect(loc_grid).to_have_count(12)
    expect(locator("#library-error")).to_be_hidden()


def test_collections_and_one_save_edit_round_trip(page):
    login(page)
    locator = page.locator
    locator("[data-view=collections]").click()
    locator("#btn-new-collection").click()
    locator("#collection-new-name").fill("Browser review")
    page.get_by_role("button", name="Create empty collection").click()
    card = locator(".collection-card", has_text="Browser review")
    expect(card).to_contain_text("0 assets")
    locator("[data-view=library]").click()
    select_collection(page, "Browser review")
    expect(locator("#result-title")).to_have_text("Library (0)")
    locator("[data-view=collections]").click()
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
    locator("[data-view=library]").click()
    expect(locator("#filter-collection summary")).to_have_text("Browser review")
    expect(locator("#result-title")).to_have_text("Library (13)")
    assert len(export_rows(page, locator("#export-csv").click)) == 13
    locator("[data-view=collections]").click()
    card.click()
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
    locator("[data-view=library]").click()
    expect(locator("#result-title")).to_have_text("Library (12)")
    assert uuid not in {row["uuid"] for row in export_rows(page, locator("#export-csv").click)}
    locator("[data-view=collections]").click()
    page.once("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="Delete collection: Browser review").click()
    expect(card).to_have_count(0)
    locator("[data-view=library]").click()
    expect(locator("#filter-collection summary")).to_have_text("All collections")
    expect(locator("#active-filters [data-kind=collection]")).to_have_count(0)
    picker = locator("#filter-collection")
    picker.locator("summary").press("Enter")
    picker.get_by_role("searchbox").fill("Browser review")
    expect(picker.locator(".tag-options")).to_have_text("No collection names found.")
    picker.get_by_role("searchbox").press("Escape")
    locator("#search").fill(title)
    select_collection(page, "Harbor campaign")
    expect(locator("#result-title")).to_have_text("Results (1)")
    row, = export_rows(page, locator("#export-csv").click)
    assert row["uuid"] == uuid and row["description"] == description
    assert 'team/brand, "中文"' in json.loads(row["tags"])


def test_collection_description_is_optional_editable_and_above_assets(page):
    login(page)
    locator = page.locator
    locator("[data-view=collections]").click()
    locator("#btn-new-collection").click()
    locator("#collection-new-name").fill("Harbor selects")
    initial = "港口活动\nReview selects for the fall campaign."
    locator("#collection-new-description").fill(initial)
    page.get_by_role("button", name="Create empty collection").click()
    card = locator(".collection-card", has_text="Harbor selects")
    expect(card).to_contain_text("港口活动")
    card.click()
    description = locator("#collection-description")
    expect(description).to_be_visible()
    assert description.text_content() == initial

    edit = locator("#collection-edit-description")
    dialog = locator("#collection-description-dialog")
    field = locator("#collection-description-input")
    save = dialog.get_by_role("button", name="Save changes")
    edit.click()
    expect(field).to_have_value(initial)
    field.fill("Unsaved draft")
    dialog.get_by_role("button", name="Cancel").click()
    assert description.text_content() == initial
    edit.click()
    field.fill("  ")
    save.click()
    expect(description).to_be_hidden()
    expect(edit).to_have_text("Add description")

    edit.click()
    updated = '港口活动, "精选"\nFall campaign photography for the editorial team.'
    field.fill(updated)
    page.route("**/api/collections/*", lambda route: route.fulfill(status=500), times=1)
    save.click()
    expect(dialog.get_by_role("alert")).to_contain_text("Your changes are still here")
    expect(field).to_have_value(updated)
    save.click()
    expect(dialog).to_be_hidden()

    locator("#collection-add-assets").click()
    locator("#collection-picker-grid input").first.check()
    locator("#collection-picker-add").click()
    expect(locator("#collection-count")).to_have_text("1 asset")
    page.reload()
    locator("[data-view=collections]").click()
    expect(card).to_contain_text('港口活动, "精选"')
    card.click()
    image = locator("#collection-grid img").first
    expect(image).to_be_visible()
    assert description.text_content() == updated
    assert description.bounding_box()["y"] < image.bounding_box()["y"]


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
    expect(locator("#collection-description")).to_have_text("Posters, banners, notices for public outreach")
    expect(locator("#collection-edit-description")).to_be_hidden()
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
    locator("#btn-upload").click()
    held = []
    page.route("**/api/assets", lambda route: held.append(route), times=1)
    with page.expect_request(lambda req: req.method == "POST" and req.url.endswith("/api/assets")):
        locator("#file-input").set_input_files([
            {"name": "interrupted.csv", "mimeType": "text/csv", "buffer": b"name,ok\ninterrupted,true"},
            {"name": "next.csv", "mimeType": "text/csv", "buffer": b"name,ok\nnext,true"},
        ])
    expect(locator(".upload-status").first).to_have_text("Uploading…")
    expect(locator(".upload-status").last).to_have_text("Queued")
    held[0].abort("internetdisconnected")
    expect(locator("#upload-summary")).to_have_text("1 uploaded · 0 already exists · 1 failed")
    expect(locator(".upload-item.err")).to_contain_text("Failed")
    page.get_by_role("button", name="Retry interrupted.csv").click()
    expect(locator("#upload-summary")).to_have_text("2 uploaded · 0 already exists · 0 failed")
    expect(locator("#upload-list")).not_to_contain_text("created.csv")


def test_library_collection_picker_pages_and_clears_selection(page, base_url):
    login(page)
    token = page.evaluate("localStorage.getItem('keepstack_token')")
    for number in range(10):
        result = page.request.post(base_url + "/api/collections",
                                   headers={"Authorization": "Bearer " + token},
                                   data={"name": f"Picker review {number:02}"})
        assert result.ok
    page.locator("[data-view=library]").click()
    page.set_viewport_size({"width": 360, "height": 800})
    picker = page.locator("#filter-collection")
    picker.locator("summary").press("Enter")
    expect(picker.locator(".tag-page")).to_have_text("1 / 2")
    popup = picker.locator(".tag-picker").bounding_box()
    assert popup["x"] >= 0 and popup["x"] + popup["width"] <= 360
    picker.get_by_role("button", name="Next", exact=True).click()
    expect(picker.locator(".tag-page")).to_have_text("2 / 2")
    picker.get_by_role("searchbox").fill("REVIEW 09")
    expect(picker.locator(".tag-page")).to_have_text("1 / 1")
    picker.get_by_role("button", name="Picker review 09", exact=True).click()
    expect(picker.locator("summary")).to_have_text("Picker review 09")
    expect(page.locator("#result-title")).to_have_text("Library (0)")
    picker.locator("summary").press("Enter")
    picker.get_by_role("searchbox").fill("Harbor")
    picker.get_by_role("button", name="Harbor campaign", exact=True).click()
    expect(page.locator("#active-filters [data-kind=collection]")).to_have_count(1)
    page.get_by_role("button", name="Remove Collection: Harbor campaign").click()
    expect(picker.locator("summary")).to_have_text("All collections")
    select_collection(page, "Harbor campaign")
    select_collection(page, "All collections")
    expect(page.locator("#active-filters [data-kind=collection]")).to_have_count(0)


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
