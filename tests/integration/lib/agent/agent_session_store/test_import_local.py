"""Startup hook: migrate local SDK jsonl transcripts into store."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from claude_agent_sdk import project_key_for_directory

from lib.agent.agent_session_store.store import DbSessionStore
from lib.infra.data_root_layout import DataRootLayout


def _windows_long_paths_enabled() -> bool:
    """Windows 未开 LongPathsEnabled（默认关）时超长路径不可创建；其余平台恒 True。"""
    if sys.platform != "win32":
        return True
    try:
        import winreg

        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\FileSystem")
        value, _ = winreg.QueryValueEx(key, "LongPathsEnabled")
        return value == 1
    except OSError:
        return False


def _write_fake_local_transcript(project_cwd: Path, session_id: str, sdk_root: Path):
    """Mimic the SDK on-disk layout: <CLAUDE_CONFIG_DIR>/projects/<sanitized>/<session_id>.jsonl."""
    sanitized = project_key_for_directory(str(project_cwd))
    sdk_dir = sdk_root / "projects" / sanitized
    sdk_dir.mkdir(parents=True, exist_ok=True)
    jsonl = sdk_dir / f"{session_id}.jsonl"
    jsonl.write_text(
        "\n".join(
            json.dumps(e)
            for e in [
                {
                    "type": "user",
                    "uuid": f"{session_id}-u1",
                    "timestamp": "2026-05-01T00:00:00Z",
                    "message": {"content": "hi"},
                },
                {
                    "type": "assistant",
                    "uuid": f"{session_id}-u2",
                    "timestamp": "2026-05-01T00:00:01Z",
                    "message": {"content": "hello"},
                },
            ]
        )
        + "\n",
        encoding="utf-8",
    )


@pytest.fixture
def fake_sdk_home(tmp_path: Path, monkeypatch):
    """Redirect SDK to a tmp config dir for the duration of one test."""
    sdk_home = tmp_path / "claude_home"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(sdk_home))
    return sdk_home


@pytest.mark.skipif(
    not _windows_long_paths_enabled(),
    reason="SDK 转录目录把项目路径编进单段目录名，Windows 未开 LongPathsEnabled 时超出 MAX_PATH",
)
@pytest.mark.asyncio
async def test_migrate_imports_local_jsonl(tmp_path, fake_sdk_home, session_factory):
    from lib.agent.agent_session_store.import_local import migrate_local_transcripts_to_store

    data_root = tmp_path / "data"
    proj = DataRootLayout(data_root).projects_dir / "demo"
    proj.mkdir(parents=True)
    (proj / "project.json").write_text("{}")
    sid = "00000000-0000-0000-0000-0000000000aa"
    _write_fake_local_transcript(proj, sid, fake_sdk_home)

    store = DbSessionStore(session_factory, user_id="u1")

    stats = await migrate_local_transcripts_to_store(store, data_root=data_root)

    assert stats["imported"] == 1
    assert stats["skipped"] == 0
    assert stats["failed"] == 0

    loaded = await store.load({"project_key": project_key_for_directory(str(proj)), "session_id": sid})
    assert loaded is not None
    assert len(loaded) == 2
    assert DataRootLayout(data_root).session_import_marker_path.exists()


@pytest.mark.skipif(
    not _windows_long_paths_enabled(),
    reason="SDK 转录目录把项目路径编进单段目录名，Windows 未开 LongPathsEnabled 时超出 MAX_PATH",
)
@pytest.mark.asyncio
async def test_migrate_is_idempotent_via_marker(tmp_path, fake_sdk_home, session_factory):
    from lib.agent.agent_session_store.import_local import migrate_local_transcripts_to_store

    data_root = tmp_path / "data"
    proj = DataRootLayout(data_root).projects_dir / "demo"
    proj.mkdir(parents=True)
    (proj / "project.json").write_text("{}")
    sid = "00000000-0000-0000-0000-0000000000bb"
    _write_fake_local_transcript(proj, sid, fake_sdk_home)
    store = DbSessionStore(session_factory, user_id="u1")

    s1 = await migrate_local_transcripts_to_store(store, data_root=data_root)
    s2 = await migrate_local_transcripts_to_store(store, data_root=data_root)

    assert s1["imported"] == 1
    assert s2["imported"] == 0
    assert s2.get("skipped_via_marker") is True


@pytest.mark.skipif(
    not _windows_long_paths_enabled(),
    reason="SDK 转录目录把项目路径编进单段目录名，Windows 未开 LongPathsEnabled 时超出 MAX_PATH",
)
@pytest.mark.asyncio
async def test_migrate_skips_already_in_store_when_marker_missing(
    tmp_path,
    fake_sdk_home,
    session_factory,
):
    """Marker误删后重启应通过 store.load 探测跳过已迁会话。"""
    from lib.agent.agent_session_store.import_local import migrate_local_transcripts_to_store

    data_root = tmp_path / "data"
    proj = DataRootLayout(data_root).projects_dir / "demo"
    proj.mkdir(parents=True)
    (proj / "project.json").write_text("{}")
    sid = "00000000-0000-0000-0000-0000000000cc"
    _write_fake_local_transcript(proj, sid, fake_sdk_home)
    store = DbSessionStore(session_factory, user_id="u1")

    await migrate_local_transcripts_to_store(store, data_root=data_root)
    DataRootLayout(data_root).session_import_marker_path.unlink()

    s2 = await migrate_local_transcripts_to_store(store, data_root=data_root)
    assert s2["imported"] == 0
    assert s2["skipped"] == 1
    assert s2["failed"] == 0


@pytest.mark.skipif(
    not _windows_long_paths_enabled(),
    reason="SDK 转录目录把项目路径编进单段目录名，Windows 未开 LongPathsEnabled 时超出 MAX_PATH",
)
@pytest.mark.asyncio
async def test_migrate_zero_data_user(tmp_path, fake_sdk_home, session_factory):
    """No projects + no SDK dir → marker still written, migration succeeds."""
    from lib.agent.agent_session_store.import_local import migrate_local_transcripts_to_store

    data_root = tmp_path / "data"
    data_root.mkdir()
    store = DbSessionStore(session_factory, user_id="u1")

    stats = await migrate_local_transcripts_to_store(store, data_root=data_root)
    assert stats == {"imported": 0, "skipped": 0, "failed": 0}
    assert DataRootLayout(data_root).session_import_marker_path.exists()
