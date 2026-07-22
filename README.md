# kkosunnae-backend

유기동물 공공데이터를 Supabase와 Pinecone에 동기화하고, 이미지 기반 유사 동물 검색과 게시판 이미지 업로드를 제공하는 Node.js 백엔드입니다. Express 서버로 실행되며 Google Cloud Run 배포를 기준으로 구성되어 있습니다.

## 주요 기능

- 농림축산식품부 유기동물 공공데이터 조회
- 보호소 및 유기동물 데이터를 Supabase에 upsert
- 공공데이터에서 사라진 유기동물 데이터 정리
- DINOv2 이미지 임베딩 생성 및 Pinecone 저장
- 업로드 이미지 또는 이미지 URL 기반 유사 동물 검색
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
- Cloudinary SDK
- Docker / Google Cloud Run

## 프로젝트 구조

```text
.
├── src
│   ├── api
│   │   └── server.ts                  # HTTP API 서버
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

## 환경변수

루트에 `.env` 파일을 생성합니다.

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
GET /healthz
```

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

이미지 빌드:

```bash
docker build -t kkosunnae-backend .
docker run --rm -p 8080:8080 --env-file .env kkosunnae-backend
```

Docker 빌드 과정에서 DINOv2 모델을 미리 내려받아 Cloud Run cold start 시 모델 다운로드를 줄입니다. 런타임 이미지는 non-root `node` 사용자로 실행됩니다.

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

사용자/외부 이미지 ──> Supabase Storage
Firestore boards ──> Supabase posts / comments / likes
```

## 주의사항

- `/api/sync/status`는 기본적으로 stale Supabase 동물 행을 삭제하지 않습니다.
- Pinecone 정리는 기본 dry run 결과를 검토한 뒤 실제 삭제를 실행해야 합니다.
- Supabase와 Pinecone 모두 2회 연속 stale인 항목만 삭제하며, 25% 또는 500건 초과 삭제를 기본 차단합니다.
- `SUPABASE_SERVICE_ROLE_KEY`를 사용하는 API는 신뢰된 서버 환경에서만 노출해야 합니다.
- 현재 이미지 업로드와 유사 검색 API에는 사용자 인증이 없으므로 공개 배포 시 API Gateway, IAM 또는 별도 인증 계층이 필요합니다.
- `CLOUDINARY_URL` 관련 유틸리티는 포함되어 있지만 현재 HTTP API의 이미지 업로드는 Supabase Storage를 사용합니다.
