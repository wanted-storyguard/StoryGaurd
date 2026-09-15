from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.app.config import app_data_dir
from backend.app.services.gpt_connection import build_gpt_connection

router = APIRouter(prefix='/chatgpt', tags=['chatgpt'])
# ChatGPT device login (desktop) or OpenAI API key (web server), chosen by environment.
connection = build_gpt_connection(app_data_dir())


class CheckRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    effort: str | None = Field(default=None, min_length=1, max_length=40)


class ManuscriptAnalysisRequest(CheckRequest):
    force: bool = False
    consent: bool = False
    batch_limit: int | None = Field(default=None, ge=1, le=100)
    start_chapter: int | None = Field(default=None, ge=0)
    end_chapter: int | None = Field(default=None, ge=0)


def call(action, *args):
    try:
        return action(*args)
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get('/status')
def status():
    return connection.status()


@router.post('/login')
def login():
    return call(connection.login)


@router.post('/cancel')
def cancel():
    return call(connection.cancel)


@router.post('/logout')
def logout():
    return call(connection.logout)


@router.post('/open-verification')
def open_verification():
    return call(connection.open_verification)


@router.get('/models')
def models():
    return call(connection.models)


@router.post('/check')
def check(payload: CheckRequest):
    return call(connection.check, payload.model, payload.effort)
