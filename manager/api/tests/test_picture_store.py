"""The picture store: a database now, Azure Blob Storage later, and moving between them."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from app.media import picture_store
from app.media.picture_store import (
    JSON,
    AzureBlobPictureStore,
    DatabasePictureStore,
    PictureStoreError,
    create_picture_store,
    migrate,
)
from app.media.video_analysis import VideoAnalyses


class NotFound(Exception):
    pass


@dataclass
class Settings:  # stands in for azure.storage.blob.ContentSettings
    content_type: str


class FakeContainer:
    """The few ContainerClient calls the store uses, in memory."""

    def __init__(self):
        self.blobs: dict[str, tuple[bytes, str]] = {}

    def upload_blob(self, name, data, overwrite, content_settings):
        assert overwrite
        self.blobs[name] = (data, content_settings.content_type)

    def download_blob(self, name):
        if name not in self.blobs:
            raise NotFound(name)
        data = self.blobs[name][0]
        return type("Download", (), {"readall": lambda self: data})()

    def get_blob_client(self, name):
        if name not in self.blobs:
            raise NotFound(name)
        content_type = self.blobs[name][1]
        properties = type("Properties", (), {"content_settings": Settings(content_type)})()
        return type("Blob", (), {"get_blob_properties": lambda self: properties})()

    def list_blobs(self, name_starts_with=None):
        return [
            type("Item", (), {"name": name})() for name in sorted(self.blobs) if name.startswith(name_starts_with or "")
        ]

    def delete_blob(self, name):
        del self.blobs[name]


def check_store(store):
    store.put("frames/v1/r1/0.jpg", b"\xff\xd8zero")
    store.put("frames/v1/r1/1.jpg", b"\xff\xd8one")
    store.put("frames/v2/r1/0.jpg", b"\xff\xd8other")
    store.put("analyses/v1.json", b"{}", JSON)
    assert store.get("frames/v1/r1/1.jpg") == b"\xff\xd8one" and store.get("missing") is None
    assert store.content_type("analyses/v1.json") == JSON and store.content_type("frames/v1/r1/0.jpg") == "image/jpeg"
    assert list(store.keys("frames/v1/")) == ["frames/v1/r1/0.jpg", "frames/v1/r1/1.jpg"]
    store.put("frames/v1/r1/1.jpg", b"\xff\xd8new")  # replaced
    assert store.get("frames/v1/r1/1.jpg") == b"\xff\xd8new"
    assert store.delete_prefix("frames/v1/") == 2 and list(store.keys("frames/")) == ["frames/v2/r1/0.jpg"]


def test_database_store(tmp_path):
    store = DatabasePictureStore(tmp_path / "pictures.sqlite3")
    check_store(store)
    assert store.size() == (2, len(b"\xff\xd8other") + 2)
    assert list(store.keys("frames/v1_")) == []  # a prefix is not a LIKE pattern


def test_azure_store_against_a_fake_container():
    check_store(AzureBlobPictureStore(FakeContainer(), Settings, NotFound))


def test_azure_is_not_connected_yet(tmp_path):
    with pytest.raises(PictureStoreError, match="not connected"):
        create_picture_store("azure", tmp_path)
    with pytest.raises(PictureStoreError, match="unknown"):
        create_picture_store("s3", tmp_path)
    assert create_picture_store("database", tmp_path).path == tmp_path / "pictures.sqlite3"


def test_migration_from_the_database_to_azure(tmp_path):
    database = DatabasePictureStore(tmp_path / "pictures.sqlite3")
    for index in range(7):
        database.put(f"frames/v1/r1/{index}.jpg", bytes([0xFF, 0xD8, index]))
    database.put("analyses/v1.json", b'{"run": "r1"}', JSON)
    container = FakeContainer()
    azure = AzureBlobPictureStore(container, Settings, NotFound)
    reported = []
    assert migrate(database, azure, report=reported.append) == 8
    assert container.blobs["frames/v1/r1/6.jpg"] == (bytes([0xFF, 0xD8, 6]), "image/jpeg")
    assert container.blobs["analyses/v1.json"][1] == JSON
    assert migrate(database, azure, prefix="analyses/") == 1  # again: same keys, overwritten


def test_command_line(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("MANAGER_DATA_DIR", str(tmp_path))
    from app.config import get_settings

    get_settings.cache_clear()
    DatabasePictureStore(tmp_path / "pictures.sqlite3").put("frames/v/r/0.jpg", b"x")
    assert picture_store.main(["info"]) == 0 and "database store: 1 items" in capsys.readouterr().out
    assert picture_store.main(["migrate", "--to", "azure"]) == 1  # Azure not connected yet
    assert "not connected" in capsys.readouterr().err
    get_settings.cache_clear()


def test_analyses_saved_as_files_move_into_the_store(tmp_path):
    folder = tmp_path / "analyses" / "v1"
    (folder / "frames").mkdir(parents=True)
    (folder / "frames" / "0.jpg").write_bytes(b"\xff\xd8a")
    (folder / "frames" / "1.jpg").write_bytes(b"\xff\xd8b")
    (folder / "analysis.json").write_text(json.dumps({"frames": [{"index": 0}, {"index": 1}]}))
    (tmp_path / "analyses" / "v2.partial").mkdir()  # an interrupted analysis: dropped
    store = DatabasePictureStore(tmp_path / "pictures.sqlite3")
    analyses = VideoAnalyses.__new__(VideoAnalyses)  # only the store parts are used here
    analyses.legacy_folder, analyses.pictures = tmp_path / "analyses", store
    assert analyses.import_legacy_folders() == 1
    assert json.loads(store.get("analyses/v1.json"))["run"] == "imported"
    assert store.get("frames/v1/imported/1.jpg") == b"\xff\xd8b"
    assert not (tmp_path / "analyses").exists()
