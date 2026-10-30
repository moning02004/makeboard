import os
import sqlite3
import subprocess
import sys


def test_manage_create_admin(tmp_path):
    """python -m app.manage create_admin 을 별도 프로세스로 실행한다 (실제로 쓰는 방법 그대로)."""
    env = {**os.environ, "MAKEBOARD_DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path}/m.db"}
    run = lambda *a: subprocess.run([sys.executable, "-m", "app.manage", "create_admin", *a],  # noqa: E731
                                    capture_output=True, text=True, env=env, cwd=os.path.dirname(os.path.dirname(__file__)))
    r = run("--username", "jeonghoon", "--name", "유정훈", "--password", "first-password")
    assert r.returncode == 0 and "만들었습니다" in r.stdout
    r = run("--username", "jeonghoon", "--password", "second-password")
    assert r.returncode == 0 and "새로 정했습니다" in r.stdout
    r = run("--username", "x", "--password", "short")
    assert r.returncode == 1 and "아이디" in r.stderr

    row = sqlite3.connect(f"{tmp_path}/m.db").execute("select username, name, is_admin, session_ver from users").fetchall()
    assert row == [("jeonghoon", "유정훈", 1, 2)]


def test_adds_missing_column_to_existing_table(tmp_path):
    """name 칸이 없던 예전 users 테이블이 있어도 create_admin 이 칸을 더하고 성공한다."""
    db = tmp_path / "old.db"
    con = sqlite3.connect(db)
    con.execute("create table users (id integer primary key, username varchar(64) unique, password_hash varchar(255),"
                " is_admin boolean, session_ver integer, created_at datetime)")
    con.execute("insert into users (username, password_hash, is_admin, session_ver) values ('old', 'x', 0, 1)")
    con.commit()
    con.close()
    env = {**os.environ, "MAKEBOARD_DATABASE_URL": f"sqlite+aiosqlite:///{db}"}
    r = subprocess.run([sys.executable, "-m", "app.manage", "create_admin", "-u", "jeonghoon", "-n", "유정훈", "-p", "first-password"],
                       capture_output=True, text=True, env=env, cwd=os.path.dirname(os.path.dirname(__file__)))
    assert r.returncode == 0, r.stderr
    rows = sqlite3.connect(db).execute("select username, name from users order by id").fetchall()
    assert rows == [("old", ""), ("jeonghoon", "유정훈")]
