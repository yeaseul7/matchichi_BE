# Node 24 실제 실행 검증

측정일: 2026-11-03, 14:12~14:13 KST.

## 검증 환경

- 공식 Node.js 배포본 v24.22.2, 공식 SHA-256 대조 완료
- macOS ARM64, 논리 CPU 10개
- 실제 서비스의 `embedImage`와 `embedTextQuery`를 그대로 호출
- DINOv2-small: CPU 기본 정밀도 fp32, E5-small: 기존 설정 q8
- 공개 강아지 사진 1장(661,378 bytes), 이미지 추론 동시성 1
- 모델과 실행 파일은 `/private/tmp/kkosunnae-validation`에 저장
- 원본 측정값: [2026-11-03-node24-profile.json](2026-11-03-node24-profile.json)

예제 사진 출처: https://raw.githubusercontent.com/pytorch/hub/master/images/dog.jpg

## 결과

| 항목 | 모델 다운로드 포함 실행 | 모델 캐시가 준비된 새 프로세스 |
| --- | ---: | ---: |
| 이미지 모델 준비 | 15,472.5ms | 83.8ms |
| 첫 이미지 추론 | 76.7ms | 77.2ms |
| 이후 10회 추론 p50 | 58.9ms | 62.3ms |
| 이후 10회 추론 p95 | 62.7ms | 104.7ms |
| 동시 요청 2개 완료 시간 | 117.4ms | 119.6ms |
| 모델 준비 전 RSS | 102.5MiB | 103.2MiB |
| 이미지 처리 후 RSS | 488.8MiB | 477.5MiB |
| E5 로딩·첫 추론 | 22,376.3ms | 352.6ms |
| 이미지·텍스트 처리 후 RSS | 885.4MiB | 892.3MiB |
| 프로세스 최대 RSS | 885.4MiB | 892.3MiB |

생성된 이미지 벡터는 384차원이고 L2 norm은 1이었다. 동일 사진에 대한 반복
호출과 동시 요청 2개가 완료됐으며, 서로 다른 사진의 검색 정확도를 의미하지 않는다.

## 호환성과 HTTP 검증

Node 24에서 TypeScript 빌드, ESLint, 단위 검증 10개를 통과했다.
실제 Express 서버를 localhost에서 실행한 검증 결과는 다음과 같다.

| 요청 | HTTP 상태 |
| --- | ---: |
| `/healthz` | 200 |
| 검색 입력 누락 | 400 |
| JPEG MIME으로 위장한 일반 텍스트 업로드 | 400 |
| 10MB 초과 파일 업로드 | 413 |

새 공개 URL 다운로드 경로도 실제 HTTPS 주소에서 661,378 bytes를 정상 수신했다.
HTTP 오류 검증에는 로컬 임시 키를 사용했으며 Pinecone·Supabase에 연결하지 않았다.

## 해석과 남은 검증

small 모델이어도 두 모델을 같은 프로세스에 올리면 로컬 RSS가 약 0.87GiB였다.
따라서 small이라는 이유만으로 512MiB 환경에서 충분하다고 가정하면 안 된다.
이 측정은 macOS의 네이티브 런타임 결과이며, Linux Cloud Run의 메모리·CPU,
전체 서비스 RSS, 업로드 해상도별 피크, OOM 여부를 대신하지 않는다.
10개 샘플의 p95는 지연 분포를 충분히 대표하지 않는다.

실제 Cloud Run 메모리·CPU·동시성은 확인하지 못했다. 로컬에 gcloud와 GCP 인증
설정이 없고 프로젝트 ID·리전·서비스명도 제공되지 않았다. Docker CLI는 있지만
daemon은 실행 중이 아니므로 Linux 컨테이너 빌드는 수행하지 않았다.

프로젝트 `.env`와 관련 API 환경변수, 평가용 사진·정답 공고 번호가 없어
실제 Pinecone/Supabase 검색 정확도 평가와 배포는 수행하지 않았다.
프로젝트·서비스 식별자와 인증 경로를 확인한 뒤 자원 설정 조회, 컨테이너 검증,
실제 사진 평가, 새 리비전 검증 순으로 이어가야 한다.
