# kkosunnae-backend

유기동물 공공데이터를 Supabase와 Pinecone에 동기화하고, 이미지 기반 유사 동물 검색과 게시판 이미지 업로드를 제공하는 Node.js 백엔드입니다. Express 서버로 실행되며 Google Cloud Run 배포를 기준으로 구성되어 있습니다.

## 주요 기능

- 농림축산식품부 유기동물 공공데이터 조회
- 보호소 및 유기동물 데이터를 Supabase에 upsert
- 공공데이터에서 사라진 유기동물 데이터 정리
- DINOv2 이미지 임베딩 생성 및 Pinecone 저장
- 업로드 이미지 또는 이미지 URL 기반 유사 동물 검색
- 다국어 E5 임베딩과 pgvector 기반 자연어 동물 검색
- Supabase Storage 이미지 업로드
- Firestore 게시판 데이터를 Supabase로 마이그레이션
- Cloud Scheduler 호출용 토큰 인증

## 기술 스택

- Node.js 24
- TypeScript
- Express
- Supabase
- Pinecone
- Hugging Face Transformers (`Xenova/dinov2-small`)
- Firebase Admin SDK
- Docker / Google Cloud Run

## 프로젝트 구조

```text
.
├── src
│   ├── api/server.ts                  # 프로세스 진입점
│   ├── app.ts                         # Express 앱 구성
│   ├── config/env.ts                  # 환경변수 접근 및 검증
│   ├── middleware                     # 인증, CORS, 오류 처리
│   ├── routes                         # HTTP API 라우트
│   ├── jobs
│   │   ├── backfillShelterInfoToSupabase.ts
│   │   ├── cleanupPineconeEmbeddings.ts
│   │   ├── migrateBoardsToSupabase.ts
│   │   ├── searchSimilarAnimals.ts
│   │   └── syncShelterAnimalsStatus.ts
│   ├── scripts
│   │   └── runMigrateBoardsToSupabase.ts
│   └── shared
│       ├── imageEmbedding.ts
│       ├── shelterAnimalApi.ts
│       ├── shelterAnimalSupabase.ts
│       ├── supabaseImageUpload.ts
│       └── syncAnimalEmbeddingsCore.ts
├── sql
│   └── create_comment_likes.sql
├── Dockerfile
├── package.json
└── tsconfig.json
```

## 사전 준비

- Node.js 24
- npm
- Supabase 프로젝트 및 Service Role Key
- Pinecone 인덱스
- 공공데이터포털 유기동물 API 인증키
- 게시판 마이그레이션 실행 시 Firebase 서비스 계정

Pinecone에는 다음 설정의 인덱스가 필요합니다.

| 항목 | 값 |
| --- | --- |
| 인덱스 이름 | `embeded-animal` |
| 벡터 차원 | `384` |
| 임베딩 모델 | `Xenova/dinov2-small` |

텍스트 검색은 `Xenova/multilingual-e5-small`의 384차원 임베딩을
Supabase `animals.text_embedding`에 저장합니다. 최초 배포 전
`sql/create_text_search.sql`을 Supabase SQL Editor에서 실행해야 합니다.

## 환경변수

`.env.example`을 복사해 루트에 `.env` 파일을 생성합니다.

```bash
cp .env.example .env
```

```dotenv
# 서버
PORT=8080
SCHEDULER_HTTP_TOKEN=

# 공공데이터 / Pinecone
ANIMALS_OPENAPI_KEY=
PINECONE_API_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANIMALS_TABLE=animals
SUPABASE_ANIMALS_CONFLICT_COLUMN=id
SUPABASE_IMAGE_BUCKET=board-images

# Firestore -> Supabase 게시판 마이그레이션
FIREBASE_SERVICE_ACCOUNT_PATH=
FIRESTORE_BOARDS_COLLECTION=boards
SUPABASE_USERS_TABLE=users
SUPABASE_POSTS_TABLE=posts
SUPABASE_POST_LIKES_TABLE=post_likes
SUPABASE_COMMENTS_TABLE=comments
SUPABASE_COMMENT_LIKES_TABLE=comment_likes
```

`SCHEDULER_HTTP_TOKEN`이 설정되면 동기화·백필·정리 API 호출 시 아래 중 하나로 같은 값을 전달해야 합니다.

```http
Authorization: Bearer <token>
X-Scheduler-Token: <token>
```

하위 호환용으로 `SHELTER_BACKFILL_HTTP_TOKEN`, `X-Backfill-Token`도 지원합니다. `.env`, Supabase Service Role Key, Firebase 서비스 계정 JSON은 저장소에 커밋하지 않습니다.

## 설치 및 실행

```bash
npm ci
npm run build
npm start
```

개발 중 TypeScript 변경을 감시하려면:

```bash
npm run build:watch
```

기본 포트는 `8080`이며 서버는 `0.0.0.0`에 바인딩됩니다.

## npm 스크립트

| 명령어 | 설명 |
| --- | --- |
| `npm run lint` | ESLint 검사 |
| `npm run build` | TypeScript를 `lib/`로 컴파일 |
| `npm run build:watch` | TypeScript 감시 빌드 |
| `npm start` | 컴파일된 API 서버 실행 |
| `npm run start:cloudrun` | Cloud Run용 서버 실행 |
| `npm run migrate:boards` | Firestore 게시판을 Supabase로 마이그레이션 |

## API

### 상태 확인

```http
GET /health
```

Cloud Run 외부 확인에는 `/health`를 사용합니다. `/healthz`도 로컬 호환용으로
제공하지만 Cloud Run 예약 경로와 충돌할 수 있습니다.

```json
{"ok": true}
```

### 당일 동물 이미지 임베딩 동기화

```http
POST /api/sync
```

서울 시간 기준 당일 발생 데이터 중 첫 번째 이미지가 있는 동물을 임베딩하여 Pinecone에 저장합니다.

```bash
curl -X POST http://localhost:8080/api/sync \
  -H "Authorization: Bearer ${SCHEDULER_HTTP_TOKEN}"
```

### Pinecone 이미지 임베딩 백필

```http
POST /api/backfill/pinecone
Content-Type: application/json
```

```json
{
  "pageStart": 1,
  "pageCount": 1
}
```

- `pageStart`: 1 이상의 정수
- `pageCount`: 1~5
- 기존 Pinecone 레코드는 건너뜀
- 날짜 제한 없이 지정 페이지 처리

### 유기동물 상태 동기화

```http
POST /api/sync/status
```

공공데이터 전체 목록을 기준으로 Supabase `animals` 테이블을 upsert합니다. 기본값은 stale 행을 조회만 하고 삭제하지 않습니다. 보호소 FK가 없는 `care_reg_no`는 `null`로 저장됩니다.

실제 stale 행 삭제는 다음 세 값을 명시해야 합니다.

```json
{
  "deleteStale": true,
  "confirmDelete": true,
  "allowLargeDelete": false
}
```

서로 다른 2회 실행에서 연속으로 stale인 행만 삭제 대상이 됩니다. 기존 행의 25% 또는 500건을 초과하는 삭제에는 추가로 `allowLargeDelete=true`가 필요합니다.

### Pinecone stale vector 정리

```http
POST /api/sync/pinecone-cleanup
Content-Type: application/json
```

기본값은 실제 삭제를 하지 않는 dry run입니다.

```json
{
  "dryRun": false,
  "confirmDelete": true,
  "allowLargeDelete": false
}
```

실제 삭제에는 `dryRun=false`와 `confirmDelete=true`가 모두 필요합니다. 서로 다른 2회 실행에서 연속으로 stale인 레코드만 삭제 대상이 됩니다. 전체 Pinecone 레코드의 25% 또는 500건을 초과하는 삭제에는 추가로 `allowLargeDelete=true`가 필요합니다.

### 보호소 정보 백필

```http
POST /api/backfill/shelters
```

공공데이터의 보호소 정보를 최대 20페이지, 페이지당 500건 조회하여 Supabase `shelters` 테이블에 `care_reg_no` 기준으로 upsert합니다.

### 이미지 업로드

```http
POST /api/images/upload
Content-Type: multipart/form-data
```

파일 업로드:

```bash
curl -X POST http://localhost:8080/api/images/upload \
  -F "file=@./image.jpg" \
  -F "folder=posts" \
  -F "publicId=example-image"
```

외부 URL 업로드:

```bash
curl -X POST http://localhost:8080/api/images/upload \
  -F "imageUrl=https://example.com/image.jpg" \
  -F "folder=posts"
```

- `file` 또는 HTTP(S) `imageUrl` 중 하나 필수
- 파일 최대 크기: 10MB
- 파일 개수: 1개
- 기본 Supabase Storage 버킷: `board-images`
- 버킷은 공개 URL 접근이 가능하도록 설정 필요

### 유사 동물 이미지 검색

```http
POST /api/search/animals
Content-Type: multipart/form-data
```

```bash
curl -X POST http://localhost:8080/api/search/animals \
  -F "file=@./animal.jpg" \
  -F "topK=10"
```

파일 대신 `imageUrl`을 전달할 수 있습니다. `topK`는 1~50 범위이며 기본값은 10입니다.

#### GCP 자원과 이미지 검색 제한

모델은 기존 DINOv2-small(384차원)을 유지합니다. 기존 벡터와의 호환성을 위해
크롭·리사이즈·재인코딩을 추가하지 않습니다. JPEG·PNG·WebP 정적 이미지의
실제 형식과 크기를 검사하며, 최대 10MB·기본 1,600만 픽셀만 허용합니다.
이미지 URL은 공개 HTTP(S) 주소와 기본 포트만 허용하고, DNS 검증 결과를 실제
연결에 고정합니다. 리다이렉트는 최대 3회, DNS·다운로드는 합계 기본 10초입니다.

| 환경변수 | 기본값 | 범위 / 의미 |
| --- | --- | --- |
| `IMAGE_EMBED_CONCURRENCY` | `1` | 프로세스당 동시 이미지 처리 수, 1~4 |
| `IMAGE_EMBED_MAX_WAITING` | `5` | 추론 대기 수, 1~20 |
| `IMAGE_SEARCH_MAX_INFLIGHT` | `2` | 업로드 파싱 전 동시 검색 요청 수, 1~10 |
| `IMAGE_MAX_PIXELS` | `16000000` | 입력 픽셀 상한, 최대 40000000 |
| `IMAGE_DOWNLOAD_TIMEOUT_MS` | `10000` | DNS·다운로드 시간 제한, 최대 60000ms |
| `IMAGE_MAX_PHOTOS_PER_ANIMAL` | `1` | 동물별 등록 사진 상한, 1~8 |

한도 초과 요청은 `429`, 파일 용량 초과는 `413`, 입력 오류는 `400`을 반환합니다.
이미지 다운로드 시간 초과는 `408`입니다. 동시성 제한은 동기화와 이미지 검색이
공유하며, Cloud Run 다중 인스턴스 전체에 대한 요청 할당량 제한은 아닙니다.
Supabase 상태 확인이 실패하면 오래된 결과를 대신 반환하지 않고 검색이 실패합니다.

검색은 `upKindCd=417000`인 개만 대상으로 하고, Supabase의 현재 `process_state`가
`protect`이거나 `보호`로 시작하는 공고만 반환합니다. 상태 불명·Supabase 미등록 공고는 제외합니다.
보호소 코드가 있는 행은 코드도 대조하고, 동일 동물은 최고 순위 사진 하나로 묶습니다.
최대 500개 후보까지 보충하므로 조건에 맞는 결과가 적으면 `topK`보다 적게 반환합니다.
응답 형태와 기존 벡터 ID는 유지하며 메타데이터에 Supabase `animalId`를 추가합니다.

여러 사진 검색을 사용하려면 `IMAGE_MAX_PHOTOS_PER_ANIMAL=3`처럼 설정하고 기존
백필 API를 페이지별로 실행합니다. 사진은 순차 처리하며 첫 사진 ID는 유지하고,
추가 사진은 `기존ID::photo2` 형태로 저장합니다. 저장량은 사진 수에 따라 증가합니다.
기본값 1에서는 기존과 같은 저장 장수를 유지합니다. 백필은 URL·원본 `updTm`·축종이
같은 벡터만 건너뜁니다. 이전 메타데이터에 `sourceUpdatedAt`이 없으면 최초 백필에서
한 번 재임베딩합니다. 같은 URL의 내용이 바뀌고 `updTm`도 그대로인 경우는 감지하지
못하므로 별도 재처리가 필요합니다. 당일 동기화만으로 과거 공고 변경이 갱신되지는
않으므로 과거 페이지도 주기적으로 백필해야 합니다.

사진 수 감소·삭제로 남은 추가 벡터는 기존 cleanup의 dry run과 2회 stale 확인을
거쳐 정리합니다. 동기화/정리 프로세스는 같은 사진 상한 설정을 사용해야 합니다.
이미지 검색 정확도 평가 방법은 [evaluation/README.md](evaluation/README.md)를
참고하세요. 실제 정확도 검증 전까지 점수를 동일 개체일 확률로 해석하지 않습니다.

### 텍스트 임베딩 동기화

```http
POST /api/sync/text-embeddings
Authorization: Bearer <SCHEDULER_HTTP_TOKEN>
Content-Type: application/json
```

```json
{"batchSize": 50}
```

임베딩이 없거나 원문 변경으로 무효화된 동물을 최대 100건씩 처리합니다.
`remaining`이 0이 될 때까지 재호출하면 기존 데이터 백필이 완료됩니다.

### 자연어 동물 검색

```http
POST /api/search/text
Content-Type: application/json
```

```json
{
  "query": "서울에서 사람을 잘 따르는 어린 흰색 강아지",
  "limit": 24
}
```

검색어는 최대 300자, 결과는 최대 50건입니다. Supabase JWT가 있는 사용자는
하루 30회, 비로그인 사용자는 IP 기준 하루 2회로 제한합니다.

지역·축종·품종·나이는 구조화 필터로 적용하고, 색상은 우선순위 점수로
반영하며, 나머지 표현은 의미 검색에
사용합니다. 예를 들어 `서울의 어린 포메 중 사람을 좋아하는 아이`는 서울·개·
포메라니안·2세 이하로 후보를 제한한 뒤 `사람을 좋아하는 아이`로 정렬합니다.
나이는 공공데이터의 출생연도를 기준으로 계산합니다.

`착하고 하얀 고양이`처럼 흰색 선호가 있으면 순수 흰색, 흰색 우선 혼합색,
흰색 포함 혼합색, 크림·아이보리 순으로 색상 점수를 적용하고 성격 의미 점수와
합산합니다. 응답의 `semantic_similarity`와 `color_score`에서 점수 근거를
확인할 수 있습니다.

50개 기준 검색 문장 평가는 백필 후 실행합니다.

```bash
npm run build
npm run evaluate:text-search
```

## Firestore 게시판 마이그레이션

Firestore의 아래 구조를 Supabase로 이전합니다.

```text
boards
├── {board}
│   ├── likeList
│   └── comments
│       └── {comment}
│           └── likeList
```

대상 테이블은 `posts`, `post_likes`, `comments`, `comment_likes`입니다. 대상 `users` 테이블에 없는 작성자 ID는 `null` 처리하고, 존재하지 않는 사용자의 좋아요는 건너뜁니다.

```bash
npm run build
npm run migrate:boards
```

`comment_likes` 테이블이 없다면 먼저 실행합니다.

```bash
# Supabase SQL Editor에서 실행
cat sql/create_comment_likes.sql
```

마이그레이션은 결정적 UUID와 upsert를 사용하므로 같은 원본 문서에 대해 재실행할 수 있습니다. 게시글·댓글의 기존 좋아요 행은 대상 게시글/댓글 단위로 교체됩니다.

## Docker / Cloud Run

배포는 맥에서 Docker로 빌드하고 Artifact Registry에 업로드한 뒤 Cloud Run에
이미지를 지정하는 방식입니다. Cloud Build는 호출하지 않습니다.
기존 `main` 자동 빌드 트리거는 사용 중지합니다.

Docker Desktop과 Google Cloud CLI를 설치하고, 배포 권한이 있는 계정으로 로그인합니다.

```bash
gcloud auth login --project dog-velog
npm run deploy:local
```

CLI가 PATH에 없으면 `~/google-cloud-sdk/bin/gcloud`도 확인합니다.
다른 위치의 CLI는 `GCLOUD_BIN`으로 지정할 수 있습니다.

배포 명령은 자동 트리거가 꺼져 있는지 확인한 뒤 `linux/amd64` 이미지 빌드,
로컬 `/health` 검증, Registry 업로드를 순서대로 실행합니다. 트래픽 없는 새 리비전을
만들어 `/health`를 확인한 후 운영 트래픽을 전환합니다. 기존 자원·환경변수는
유지합니다. 빌드 안에서 Node 24 린트·테스트를 실행하며, CPU 서버에 필요 없는
ONNX CUDA 파일 다운로드는 제외합니다.

이미지 빌드만 확인하려면:

```bash
docker buildx build --platform linux/amd64 --load -t kkosunnae-backend .
docker run --platform linux/amd64 --rm -p 8080:8080 --env-file .env kkosunnae-backend
```

Cloud Build 빌드 비용은 발생하지 않지만 Artifact Registry 저장·전송 및
Cloud Run 실행 비용은 별도입니다.

Docker 빌드 과정에서 DINOv2와 양자화된 multilingual-e5-small 모델을 미리
내려받아 Cloud Run cold start 시 다운로드를 줄입니다. 런타임 이미지는
non-root `node` 사용자로 실행됩니다.

Cloud Scheduler에서는 보호할 엔드포인트에 `POST` 요청을 보내고 `Authorization: Bearer <SCHEDULER_HTTP_TOKEN>` 헤더를 설정합니다. Cloud Run 또는 production 환경에서 인증 토큰이 누락되면 Scheduler용 API는 `503`으로 차단됩니다.

동기화 기능을 배포하기 전에 Supabase SQL Editor에서 다음 스키마를 먼저 적용해야 합니다.

```text
sql/create_sync_safety.sql
```

이 스키마는 Cloud Run 다중 인스턴스 간 실행 lease와 2회 연속 stale 후보를 저장합니다. Pinecone sync/backfill/cleanup은 같은 lease를 사용하므로 동시에 실행되지 않습니다. 스키마 또는 RPC가 없으면 작업은 안전하게 실패합니다.

## 데이터 흐름

```text
공공데이터 API ──> Supabase shelters / animals
       │
       └──> DINOv2 이미지 임베딩 ──> Pinecone
                                          │
사용자 이미지 ──> DINOv2 이미지 임베딩 ──┘ 유사도 검색

공공데이터 ──> multilingual-e5-small ──> Supabase pgvector
사용자 문장 ──> multilingual-e5-small ──┘ 의미 검색

사용자/외부 이미지 ──> Supabase Storage
Firestore boards ──> Supabase posts / comments / likes
```

## 주의사항

- `/api/sync/status`는 기본적으로 stale Supabase 동물 행을 삭제하지 않습니다.
- Pinecone 정리는 기본 dry run 결과를 검토한 뒤 실제 삭제를 실행해야 합니다.
- Supabase와 Pinecone 모두 2회 연속 stale인 항목만 삭제하며, 25% 또는 500건 초과 삭제를 기본 차단합니다.
- `SUPABASE_SERVICE_ROLE_KEY`를 사용하는 API는 신뢰된 서버 환경에서만 노출해야 합니다.
- 현재 이미지 업로드와 유사 검색 API에는 사용자 인증이 없으므로 공개 배포 시 API Gateway, IAM 또는 별도 인증 계층이 필요합니다.
