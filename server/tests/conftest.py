import os
import tempfile

# app 모듈을 불러오기 전에 설정해야 한다 (설정은 import 할 때 읽는다)
os.environ.setdefault("MAKEBOARD_ADMIN_TOKEN", "test-token-test-token")
os.environ.setdefault("MAKEBOARD_DATABASE_URL", f"sqlite+aiosqlite:///{tempfile.mkdtemp()}/test.db")
