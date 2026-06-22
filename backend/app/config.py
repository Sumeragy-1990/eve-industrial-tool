"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # FastAPI
    app_name: str = "EVE Industrial Tool"
    debug: bool = False

    # Database
    database_url: str = "postgresql+asyncpg://eve:eve_password@db:5432/eve_industrial"

    # EVE SSO
    eve_client_id: str = ""
    eve_secret_key: str = ""
    eve_callback_url: str = "http://192.168.178.24:8082/auth/callback"
    eve_useragent: str = "EVEIndustrialTool/1.0 (contact@example.com)"

    # Session / JWT
    jwt_secret_key: str = "change-me-to-a-random-secret"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440  # 24 hours

    # Sync
    asset_sync_interval_minutes: int = 30

    # SDE
    sde_download_url: str = (
        "https://eve-static-data-export.s3-eu-west-1.amazonaws.com/tranquility/"
        "sde.zip"
    )

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
