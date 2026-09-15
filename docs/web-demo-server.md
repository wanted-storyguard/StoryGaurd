# 웹 데모 서버 실행 (공개 제출용)

원티드 AI 챔피언십 제출은 설치 파일 대신 **공개 웹 데모 URL**로 한다. 같은 코드베이스를 Tauri 없이 서버에 올린다.

- 프론트: `npm run build` 결과(`dist/`)를 정적 호스팅에 배포한다. 빌드 시 `VITE_STORY_GUARD_API=https://<백엔드 주소>`를 준다.
- 백엔드: FastAPI를 서버에서 실행하되 아래 환경변수로 **웹 모드**를 켠다. 웹 모드는 데스크톱 전용 기능을 막고, 샘플 작품을 읽기 전용으로 제공한다.

## 백엔드 환경변수

| 변수 | 값 | 설명 |
|---|---|---|
| `STORY_GUARD_WEB_MODE` | `1` | 공개 웹 데모 가드를 켠다. `/shutdown`, `/setup/*`, `/documents/import`, `/documents/replace`, `/health/local-ai`, `/chatgpt/login·logout·cancel·open-verification·check`는 403. 읽기(GET)만 허용하고 쓰기는 아래 허용 목록에 맞는 경로만 통과한다. `/chatgpt/status`·`/chatgpt/models`는 열려 있어 UI가 모델을 고를 수 있다. |
| `STORY_GUARD_WEB_WRITE_PATHS` | 정규식 | 웹 모드에서 허용할 추가 쓰기 경로. 비어 있으면 읽기 전용. |
| `STORY_GUARD_WEB_ALLOW_GPT_ANALYZE` | `1` | 공개 서버에서 `POST /projects/{id}/analyze/gpt`와 `analysis/cancel`을 연다. 기본은 닫힘. |
| `STORY_GUARD_WEB_GPT_RUNS_PER_CLIENT` | `3` | 접속(IP 또는 `X-Forwarded-For` 첫 값)당 하루 GPT 분석 실행 횟수. 초과 시 429. |
| `STORY_GUARD_WEB_GPT_RUNS_PER_DAY` | `200` | 서버 전체 하루 GPT 분석 실행 횟수. 프로세스가 재시작되면 초기화되므로 OpenAI 프로젝트의 지출 한도를 마지막 안전장치로 둔다. |
| `OPENAI_API_KEY` | `sk-...` | 서버가 GPT를 호출할 키. 있으면 API 키 연결이 자동 선택된다(`STORY_GUARD_GPT_PROVIDER=openai_api`로 강제 가능, `chatgpt`로 데스크톱 로그인 강제). |
| `STORY_GUARD_OPENAI_MODELS` | `gpt-5.6-luna,gpt-5.4-mini` | UI에 보여줄 모델을 이 순서로 고정한다. 비우면 `/models` 결과에서 채팅용 모델만 골라 보여준다. |
| `STORY_GUARD_OPENAI_MAX_OUTPUT_TOKENS` | `12000` | 검토 응답의 출력 토큰 상한(추론 토큰 포함). 너무 작으면 JSON이 잘린다. |
| `STORY_GUARD_GPT_CONCURRENCY` | `2` | 동시에 진행할 GPT 요청 수. 초과 요청은 30초까지 대기 후 일시 오류로 재시도된다. |
| `OPENAI_BASE_URL` | (비움) | 호환 프록시를 쓸 때만 지정. |
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
$env:OPENAI_API_KEY = "sk-..."
$env:STORY_GUARD_WEB_ALLOW_GPT_ANALYZE = "1"
.\.venv\Scripts\python.exe -m backend.app.main
```

다른 창에서 `npm run dev`를 띄우고 브라우저로 `http://localhost:5173`을 연다. 쓰기 요청은 403이 나야 정상이고, 앱 설정의 AI 연결 패널이 "연결됨 · OpenAI API 키"를 보여야 한다. 키 없이 띄우면 같은 패널이 키 미설정 안내를 보여준다.

개발 중(웹 모드 없이)에는 `OPENAI_API_KEY`만 주면 되고, 작품 생성·원고 등록·GPT 분석이 모두 열린다.

## 샘플 데이터 준비 원칙

- 샘플 원고의 청킹·임베딩·GPT 분석은 **서버가 아니라 로컬(Mac)에서** 미리 돌린다. 결과는 `STORY_GUARD_DATA_DIR`의 SQLite와 Chroma 폴더 그 자체다. 별도 JSON 변환기를 만들지 않는다.
- 돌리기 전에 시연할 규칙을 `POST /projects/{id}/settings`에 `certainty: confirmed`로 등록한다. 등록된 확정 설정은 모든 GPT 검토 구간에 자동으로 들어가므로, 1화 규칙과 7화 행동을 비교할 근거가 빠지지 않는다.
- 서버에는 임베딩 모델이 없다. 라이브 검토는 미리 찾아둔 근거 + 사용자가 고친 장면을 GPT에 보내는 방식으로 설계한다.

## 테스트 방법

### A. API 키로 GPT 분석 테스트 (임베딩 모델 없어도 됨)

임베딩 모델이 없으면 검색 색인 단계는 건너뛰고 SQLite 청크에 대한 BM25 검색으로 근거를 찾는다. 분석 자체는 그대로 돌아가므로 키만 있으면 이 PC에서 바로 확인할 수 있다. 단, 회차를 넘나드는 근거 회수는 임베딩이 있는 환경보다 약하다.

1. 백엔드를 개발 모드(웹 모드 아님)로 띄운다. `OPENAI_API_KEY=sk-... npm run backend` (Windows는 `npm run backend:win`).
2. 스크립트로 연결만 먼저 확인한다. 실제 요청은 샘플 1회다.

   ```bash
   python -m scripts.api_smoke --model gpt-5.6-luna --effort low
   ```

   모델 목록에 원하는 모델이 없으면 `STORY_GUARD_OPENAI_MODELS`로 고정한다. 추론 강도를 지원하지 않는 모델은 `--effort`를 빼고 실행한다.
3. 작품을 만들고 원고를 넣은 뒤 짧은 범위로 분석한다. 검토 구간 수만큼 요청이 나가므로 `--yes`가 필요하다.

   ```bash
   python -m scripts.api_smoke --model gpt-5.6-luna --effort low --analyze --project 1 --start 0 --end 1 --yes
   ```

   엔티티·관계·검토 후보 수, 실패 구간, 첫 이슈의 근거 인용이 출력된다. 같은 내용을 UI에서 하려면 앱 설정 → AI 연결 패널에서 "샘플로 연결 검증" → 분석 화면에서 회차 범위를 잡고 "이 작품 GPT 분석"이다.
4. 확인할 것: 응답이 JSON으로 파싱되는지(실패하면 `invalid_request`나 "JSON 객체를 찾지 못했습니다"로 보임), 추론 강도 파라미터를 모델이 받아주는지, 한 구간 응답 시간이 60초 안에 드는지. 여기서 걸리면 `backend/app/services/openai_api.py`의 요청 본문(`reasoning_effort`, `response_format`)만 손보면 된다.

### B. 임베딩 테스트

- **Mac(권장).** 이미 Qwen3-Embedding·EmbeddingGemma 실측이 끝난 환경이다. 사전 계산 데이터는 여기서 만든다.
- **이 PC(Windows).** Qwen GGUF 경로는 `llama-cpp-python` 컴파일(cmake·MSVC)이 필요해 막혀 있다. EmbeddingGemma 경로는 가능하다.
  1. Hugging Face에서 `google/embeddinggemma-300m` 이용 조건에 동의하고 `hf auth login`(또는 `HF_TOKEN`)으로 로그인한다.
  2. 개발 모드 백엔드에 준비 요청을 보낸다. 이 브랜치의 웹 UI에는 설치 화면이 없으므로 API로 호출한다. 첫 실행은 `gemma-runtime` 가상환경 생성, torch·sentence-transformers 설치, 모델 약 1.2GB 다운로드로 수 분이 걸린다.

     ```bash
     curl -X POST http://127.0.0.1:8765/setup/run -H "Content-Type: application/json" \
       -d '{"install_runtime":false,"prepare_embedding_model":true,"prepare_generation_model":false,"embedding_model":"embeddinggemma-300m","generation_model":"qwen2.5-1.5b-instruct-q4_k_m.gguf"}'
     curl http://127.0.0.1:8765/setup/progress     # running=false, error=null 이면 완료
     curl http://127.0.0.1:8765/setup/status       # embedding_model_ready=true 확인
     ```
  3. 원고를 등록한 뒤 GPT 분석을 한 번 돌리면 `gpt_index` 단계에서 실제 임베딩이 계산된다(진행률 5~30%). 이후 `/projects/{id}/analysis/plan`이 임베딩 예상 시간을 함께 돌려준다.
  4. 검색 품질 비교는 `scripts/validate_long_retrieval.py`, `scripts/embedding_benchmark/validate_hybrid.py`를 쓰되 `output/validation/` 데이터셋이 필요하다(저장소에 없음, Mac에 있음).

## GPT 연결 구조

- `backend/app/services/gpt_connection.py`가 환경에 따라 연결을 고른다. `OPENAI_API_KEY`가 있으면 `openai_api.OpenAiApiConnection`(chat completions), 없으면 데스크톱용 `chatgpt.ChatGptConnection`(Codex 장치 로그인).
- 두 클래스는 같은 모양(`status`/`models`/`check`/`complete`)이라 분석기(`gpt_analyzer.py`)와 `/chatgpt/*` 라우트는 그대로다. API 키 연결의 `status()`는 `method: "api_key"`를 추가로 돌려주고, 프론트 패널은 이 값으로 로그인 버튼을 숨긴다.
- 오류는 `gpt_errors.error_for_code`로 기존 범주(authentication, rate_limit, usage_limit, context_length, provider_unavailable …)에 매핑되어 재시도·구간 분할 규칙이 동일하게 적용된다. 응답 대기 시간은 추론 강도별 60/90/120초다.

## 아직 없는 것 (다음 작업)

1. 데모 전용 "이 장면 검토" 엔드포인트(수정한 장면 + 미리 찾아둔 근거만 GPT에 전송). 지금은 기존 `analyze/gpt`(회차 범위 분석)를 한도 안에서 여는 방식이다.
2. 방문자별 판단 저장. 공개 서버에서 `PATCH /issues/{id}/status`는 공유 DB를 바꾸므로 닫혀 있다.
3. "미리 분석된 예시 / 방금 실행한 검토" 구분 표시.

## 알아둘 것

- 이 브랜치는 Tauri 셸과 sidecar·DMG·Windows 릴리스 스크립트를 제거했다. 프론트는 브라우저 전용이며 `/shutdown`을 호출하지 않는다.
- Windows에서 `test_revision_flow.py::test_replace_api_rejects_empty_and_missing_file`은 main에서도 인코딩 문제로 실패한다(UnicodeDecodeError). 웹 모드 변경과 무관하다. llama.cpp 미설치로 실패하는 테스트 2개도 같은 이유로 기존 것이다.
