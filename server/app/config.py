from functools import cached_property

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """환경변수(MAKEBOARD_*) 또는 server/.env 에서 읽는 설정."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="MAKEBOARD_", extra="ignore")

    # CLI 용 관리자 토큰(Authorization: Bearer). 세션 쿠키 서명에도 쓴다. 설정하지 않으면 서버가 시작되지 않는다.
    admin_token: str
    # 처음 시작할 때(사용자가 아무도 없을 때) 만들 관리자 계정. 비밀번호를 비우면 admin_token 을 쓴다.
    admin_user: str = "admin"
    admin_password: str = ""
    # 에이전트별 토큰: "prod-app-01:토큰1,dev-01:토큰2"
    agent_tokens: str = ""
    database_url: str = "sqlite+aiosqlite:///./makeboard.db"
    # 세션 쿠키 서명용. 비워두면 admin_token 으로 서명한다.
    session_secret: str = ""
    # HTTPS 뒤에서 운영할 때 true
    cookie_secure: bool = False
    # 빌드된 웹(dist) 경로. 지정하면 같은 서버에서 화면도 제공한다.
    web_dist: str = ""
    # 에이전트가 접속할 이 서버의 주소 (예: http://192.168.0.4:8000). 비우면 브라우저 주소를 쓴다.
    public_url: str = ""
    # 설치 스크립트가 내려줄 에이전트 파일 위치. 비우면 저장소의 agent/ 를 찾는다.
    agent_dir: str = ""
    # 한 번의 make 실행 최대 시간(초)
    job_timeout: int = 3600
    # 서버 대시보드의 "Beszel" 버튼이 열 주소. {name} 은 서버 이름으로 바뀐다. 비우면 버튼을 숨긴다.
    # 이 값과 public_url 은 웹의 설정 창에서 바꿀 수 있고, 거기서 저장한 값이 우선한다 (prefs.py).
    # 예) https://beszel.example.com 또는 https://beszel.example.com/system/{name}
    beszel_url: str = ""

    @cached_property
    def agent_token_map(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for pair in self.agent_tokens.split(","):
            pair = pair.strip()
            if not pair:
                continue
            agent_id, _, token = pair.partition(":")
            if agent_id and token:
                out[agent_id.strip()] = token.strip()
        return out


settings = Settings()
