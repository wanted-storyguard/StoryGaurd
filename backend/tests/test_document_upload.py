"""Browser uploads: the client sends file bytes, the server stores and imports them."""
import base64
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import main as main_module
from backend.app.main import app


def encode(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def make_project(client: TestClient, title: str) -> int:
    response = client.post("/projects", json={"title": title})
    assert response.status_code == 200
    return response.json()["id"]


def test_upload_imports_text_and_assigns_chapters(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(main_module, "app_data_dir", lambda: tmp_path)
    client = TestClient(app)
    project_id = make_project(client, "업로드 검증")

    first = client.post("/documents/upload", json={
        "project_id": project_id, "filename": "episode-01.md", "content_base64": encode("# 1화\n\n유나는 계약을 거절했다."),
    })
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["title"] == "episode-01"
    assert body["format"] == "md"
    assert body["chapter_index"] == 0
    assert "유나는 계약을 거절했다." in body["content"]
    assert (tmp_path / "uploads" / str(project_id) / "episode-01.md").is_file()

    second = client.post("/documents/upload", json={
        "project_id": project_id, "filename": "C:\\Users\\writer\\episode-02.txt", "content_base64": encode("2화. 유나는 봉인검을 들어 올렸다."),
    })
    assert second.status_code == 200, second.text
    assert second.json()["chapter_index"] == 1
    assert second.json()["title"] == "episode-02"

    documents = client.get(f"/projects/{project_id}/documents").json()
    assert [document["title"] for document in documents] == ["episode-01", "episode-02"]


def test_upload_rejects_bad_input(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(main_module, "app_data_dir", lambda: tmp_path)
    client = TestClient(app)
    project_id = make_project(client, "업로드 거부")

    unsupported = client.post("/documents/upload", json={
        "project_id": project_id, "filename": "story.pdf", "content_base64": encode("본문"),
    })
    assert unsupported.status_code == 400
    assert "txt, md, docx" in unsupported.json()["detail"]

    garbage = client.post("/documents/upload", json={
        "project_id": project_id, "filename": "story.txt", "content_base64": "not*base64!",
    })
    assert garbage.status_code == 400

    hidden = client.post("/documents/upload", json={
        "project_id": project_id, "filename": ".env", "content_base64": encode("x"),
    })
    assert hidden.status_code == 400

    monkeypatch.setattr(main_module, "UPLOAD_MAX_BYTES", 8)
    too_big = client.post("/documents/upload", json={
        "project_id": project_id, "filename": "long.txt", "content_base64": encode("아주 긴 원고 본문입니다."),
    })
    assert too_big.status_code == 413

    non_utf8 = client.post("/documents/upload", json={
        "project_id": project_id, "filename": "cp949.txt",
        "content_base64": base64.b64encode("한글".encode("cp949")).decode("ascii"),
    })
    assert non_utf8.status_code == 400
    assert "UTF-8" in non_utf8.json()["detail"]


def test_upload_replaces_existing_episode(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(main_module, "app_data_dir", lambda: tmp_path)
    client = TestClient(app)
    project_id = make_project(client, "교체 검증")
    created = client.post("/documents/upload", json={
        "project_id": project_id, "filename": "episode-01.txt", "content_base64": encode("유나는 계약을 거절했다."),
    }).json()

    replaced = client.put(f"/documents/{created['id']}/upload", json={
        "filename": "episode-01-v2.txt", "content_base64": encode("유나는 스승과 정식으로 계약을 맺었다."),
    })
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["id"] == created["id"]
    assert replaced.json()["chapter_index"] == created["chapter_index"]
    assert replaced.json()["content_hash"] != created["content_hash"]
    assert "정식으로 계약" in replaced.json()["content"]

    missing = client.put("/documents/999999/upload", json={"filename": "x.txt", "content_base64": encode("본문")})
    assert missing.status_code == 404
