"""Where the pictures of analysed frames (and the analyses) are kept: a blob store.

Each item is a key (``frames/<video id>/<run>/<index>.jpg``, ``analyses/<video id>.json``)
and its bytes. Two stores implement the same interface, so the rest of the manager does
not know which one is used:

    DatabasePictureStore    a SQLite database (``<data>/pictures.sqlite3``): the default
    AzureBlobPictureStore   an Azure Blob Storage container, for the cloud

``MANAGER_PICTURE_STORE`` chooses one (``database`` or ``azure``). Moving to Azure is a
copy of every item, then a switch of that setting:

    python -m app.media.picture_store migrate --to azure      # copies database -> Azure
    MANAGER_PICTURE_STORE=azure                               # then use Azure

The Azure store needs ``pip install .[azure]`` and ``MANAGER_AZURE_STORAGE_CONNECTION_STRING``
(the storage account's connection string, from the Azure portal: Access keys).
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Protocol

JPEG = "image/jpeg"
JSON = "application/json"
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS pictures ("
    "key TEXT PRIMARY KEY, content_type TEXT NOT NULL, size INTEGER NOT NULL, created REAL NOT NULL, "
    "data BLOB NOT NULL)"
)
DATABASE_FILE = "pictures.sqlite3"
MIGRATION_REPORT_EVERY = 500


class PictureStoreError(RuntimeError):
    """The store is not configured or cannot be reached."""


class PictureStore(Protocol):
    """A key → bytes store (keys use ``/`` like folders)."""

    name: str

    def put(self, key: str, data: bytes, content_type: str = JPEG) -> None: ...
    def get(self, key: str) -> bytes | None: ...
    def content_type(self, key: str) -> str | None: ...
    def keys(self, prefix: str = "") -> Iterator[str]: ...
    def delete_prefix(self, prefix: str) -> int: ...


# --- SQLite ---------------------------------------------------------------------------
class DatabasePictureStore:
    """Pictures in a SQLite table (one row per picture, the bytes in a BLOB column)."""

    name = "database"

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")  # readers do not wait for the analysis writing
            connection.execute(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=30)

    def put(self, key: str, data: bytes, content_type: str = JPEG) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO pictures VALUES (?, ?, ?, ?, ?)",
                (key, content_type, len(data), time.time(), sqlite3.Binary(data)),
            )

    def get(self, key: str) -> bytes | None:
        with self._connect() as connection:
            row = connection.execute("SELECT data FROM pictures WHERE key = ?", (key,)).fetchone()
        return bytes(row[0]) if row else None

    def content_type(self, key: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute("SELECT content_type FROM pictures WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def keys(self, prefix: str = "") -> Iterator[str]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT key FROM pictures WHERE substr(key, 1, ?) = ? ORDER BY key", (len(prefix), prefix)
            ).fetchall()
        return (row[0] for row in rows)

    def delete_prefix(self, prefix: str) -> int:
        with self._connect() as connection:
            return connection.execute(
                "DELETE FROM pictures WHERE substr(key, 1, ?) = ?", (len(prefix), prefix)
            ).rowcount

    def size(self) -> tuple[int, int]:
        """How many items, and their total bytes."""
        with self._connect() as connection:
            count, total = connection.execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM pictures").fetchone()
        return count, total


# --- Azure Blob Storage -------------------------------------------------------------------
class AzureBlobPictureStore:
    """Pictures as blobs of one Azure Blob Storage container (the key is the blob name).

    ``container`` is an ``azure.storage.blob.ContainerClient``; ``from_connection_string``
    builds it (and creates the container if needed). ``content_settings`` and ``not_found``
    are the SDK's ``ContentSettings`` and ``ResourceNotFoundError`` (passed in, so this
    module loads without the Azure SDK).
    """

    name = "azure"

    def __init__(self, container, content_settings, not_found: type[Exception]) -> None:
        self.container = container
        self.content_settings = content_settings
        self.not_found = not_found

    @classmethod
    def from_connection_string(cls, connection_string: str | None, container_name: str) -> AzureBlobPictureStore:
        if not connection_string:
            raise PictureStoreError(
                "Azure is not connected: set MANAGER_AZURE_STORAGE_CONNECTION_STRING "
                "(storage account → Access keys → Connection string)"
            )
        try:
            from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
            from azure.storage.blob import BlobServiceClient, ContentSettings
        except ImportError as error:
            raise PictureStoreError("the Azure SDK is not installed: pip install .[azure]") from error
        container = BlobServiceClient.from_connection_string(connection_string).get_container_client(container_name)
        try:
            container.create_container()
        except ResourceExistsError:
            pass
        return cls(container, ContentSettings, ResourceNotFoundError)

    def put(self, key: str, data: bytes, content_type: str = JPEG) -> None:
        settings = self.content_settings(content_type=content_type)
        self.container.upload_blob(key, data, overwrite=True, content_settings=settings)

    def get(self, key: str) -> bytes | None:
        try:
            return self.container.download_blob(key).readall()
        except self.not_found:
            return None

    def content_type(self, key: str) -> str | None:
        try:
            return self.container.get_blob_client(key).get_blob_properties().content_settings.content_type
        except self.not_found:
            return None

    def keys(self, prefix: str = "") -> Iterator[str]:
        return (blob.name for blob in self.container.list_blobs(name_starts_with=prefix or None))

    def delete_prefix(self, prefix: str) -> int:
        names = list(self.keys(prefix))
        for name in names:
            self.container.delete_blob(name)
        return len(names)


# --- choosing and migrating ---------------------------------------------------------------
def create_picture_store(
    kind: str,
    data_dir: Path,
    database: str | None = None,
    azure_connection_string: str | None = None,
    azure_container: str = "multivision-pictures",
) -> PictureStore:
    if kind == "database":
        return DatabasePictureStore(Path(database) if database else data_dir / DATABASE_FILE)
    if kind == "azure":
        return AzureBlobPictureStore.from_connection_string(azure_connection_string, azure_container)
    raise PictureStoreError(f"unknown picture store {kind!r}: use 'database' or 'azure'")


def migrate(source: PictureStore, target: PictureStore, prefix: str = "", report=None) -> int:
    """Copy every item of ``source`` (under ``prefix``) to ``target``; returns how many."""
    copied = 0
    for key in source.keys(prefix):
        data = source.get(key)
        if data is None:
            continue
        target.put(key, data, source.content_type(key) or JPEG)
        copied += 1
        if report and copied % MIGRATION_REPORT_EVERY == 0:
            report(copied)
    return copied


def import_files(store: PictureStore, items: Iterable[tuple[str, Path, str]]) -> int:
    """Put files into the store: (key, file, content type)."""
    imported = 0
    for key, path, content_type in items:
        store.put(key, path.read_bytes(), content_type)
        imported += 1
    return imported


def main(argv: list[str] | None = None) -> int:
    from app.config import get_settings

    parser = argparse.ArgumentParser(prog="python -m app.media.picture_store", description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    move = commands.add_parser("migrate", help="copy every picture from one store to the other")
    move.add_argument("--from", dest="source", default="database", choices=["database", "azure"])
    move.add_argument("--to", dest="target", default="azure", choices=["database", "azure"])
    move.add_argument("--prefix", default="", help="only keys starting with this (e.g. frames/)")
    commands.add_parser("info", help="what the configured store holds")
    arguments = parser.parse_args(argv)

    settings = get_settings()

    def store(kind: str) -> PictureStore:
        return create_picture_store(
            kind, Path(settings.data_dir), settings.picture_database,
            settings.azure_storage_connection_string, settings.azure_storage_container,
        )  # fmt: skip

    try:
        if arguments.command == "info":
            configured = store(settings.picture_store)
            items = sum(1 for _ in configured.keys())
            print(f"{configured.name} store: {items} items")
            return 0
        if arguments.source == arguments.target:
            parser.error("--from and --to must differ")
        source, target = store(arguments.source), store(arguments.target)
        copied = migrate(source, target, arguments.prefix, report=lambda count: print(f"  {count} copied…"))
    except PictureStoreError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"{copied} items copied from {source.name} to {target.name}.")
    print(f"Then set MANAGER_PICTURE_STORE={target.name} and restart the manager.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
