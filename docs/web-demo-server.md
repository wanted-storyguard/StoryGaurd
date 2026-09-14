# 웹 데모 서버 실행 (공개 제출용)

원티드 AI 챔피언십 제출은 설치 파일 대신 **공개 웹 데모 URL**로 한다. 같은 코드베이스를 Tauri 없이 서버에 올린다.

- 프론트: `npm run build` 결과(`dist/`)를 정적 호스팅에 배포한다. 빌드 시 `VITE_STORY_GUARD_API=https://<백엔드 주소>`를 준다.
- 백엔드: FastAPI를 서버에서 실행하되 아래 환경변수로 **웹 모드**를 켠다. 웹 모드는 데스크톱 전용 기능을 막고, 샘플 작품을 읽기 전용으로 제공한다.

## 백엔드 환경변수

| 변수 | 값 | 설명 |
|---|---|---|
| `STORY_GUARD_WEB_MODE` | `1` | 공개 웹 데모 가드를 켠다. `/shutdown`, `/setup/*`, `/chatgpt/*`, `/documents/import`, `/documents/replace`, `/health/local-ai`는 403. 읽기(GET)만 허용하고 쓰기는 아래 허용 목록에 맞는 경로만 통과한다. |
| `STORY_GUARD_WEB_WRITE_PATHS` | 정규식 | 웹 모드에서 허용할 쓰기 경로. 데모 전용 라이브 검토 엔드포인트를 만들면 여기에 등록한다. 비어 있으면 읽기 전용. |
| `STORY_GUARD_WEB_ORIGINS` | `https://demo.example.com,https://...` | CORS 허용 origin. 데스크톱은 비워 두면 기존 loopback 정책만 유지된다. |
| `STORY_GUARD_BIND_HOST` | `0.0.0.0` | 컨테이너·PaaS에서 외부 바인딩. 기본값은 `127.0.0.1`. |
| `STORY_GUARD_BACKEND_PORT` | `8765` | 포트. PaaS가 주는 `PORT`를 그대로 넣는다. |
| `STORY_GUARD_DATA_DIR` | `/data/story-guard` | SQLite·Chroma·모델 폴더. 미리 계산한 샘플 데이터 폴더를 이 위치에 둔다. |
| `STORY_GUARD_API_TOKEN` | (비움) | 공개 데모에서는 비운다. 브라우저에 비밀을 둘 수 없다. |

## 로컬에서 웹 모드 확인

```powershell
$env:STORY_GUARD_WEB_MODE = "1"
$env:STORY_GUARD_WEB_ORIGINS = "http://localhost:5173"
$env:STORY_GUARD_DATA_DIR = "C:\storyguard-demo-data"
.\.venv\Scripts\python.exe -m backend.app.main
```

다른 창에서 `npm run dev`를 띄우고 브라우저로 `http://localhost:5173`을 연다. 쓰기 요청은 403이 나야 정상이다.

## 샘플 데이터 준비 원칙

- 샘플 원고의 청킹·임베딩·GPT 분석은 **서버가 아니라 로컬(Mac)에서** 미리 돌린다. 결과는 `STORY_GUARD_DATA_DIR`의 SQLite와 Chroma 폴더 그 자체다. 별도 JSON 변환기를 만들지 않는다.
- 돌리기 전에 시연할 규칙을 `POST /projects/{id}/settings`에 `certainty: confirmed`로 등록한다. 등록된 확정 설정은 모든 GPT 검토 구간에 자동으로 들어가므로, 1화 규칙과 7화 행동을 비교할 근거가 빠지지 않는다.
- 서버에는 임베딩 모델이 없다. 라이브 검토는 미리 찾아둔 근거 + 사용자가 고친 장면을 GPT에 보내는 방식으로 설계한다.

## 아직 없는 것 (다음 작업)

1. 서버에서 OpenAI API 키로 GPT를 부르는 연결 클래스. 현재는 ChatGPT 장치 로그인(Codex app-server) 경로만 있어 서버에서 쓸 수 없다.
2. 데모 전용 라이브 검토 엔드포인트와 사용 제한(세션·IP당 횟수, 동시 2건, 일일·전체 예산의 원자적 예약).
3. 웹 빌드에서 데스크톱 전용 UI(파일 가져오기, LLM 설치, ChatGPT 로그인) 숨김과 "미리 분석된 예시 / 방금 실행한 검토" 구분 표시.

## 알아둘 것

- `npx vitest run`이 로컬에서 실행 중인 백엔드(127.0.0.1:8765)에 실제 `/shutdown` 요청을 보내 죽일 수 있다. 개발 백엔드를 띄운 채로 프론트 테스트를 돌리지 않는다.
- Windows에서 `test_revision_flow.py::test_replace_api_rejects_empty_and_missing_file`은 main에서도 인코딩 문제로 실패한다(UnicodeDecodeError). 웹 모드 변경과 무관하다.
