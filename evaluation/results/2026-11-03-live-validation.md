# 실제 GCP·Pinecone·Supabase 검증

2026-11-03 제공받은 환경설정과 그 설정이 참조하는 서비스 계정으로 검증했다.
인증정보는 저장소에 복사하지 않았고, 데이터와 벡터는 수정하지 않았다.
이 기록은 이전 로컬 검증 기록의 미확인 항목을 보완한다.

## 운영 설정

| 항목 | 조회 결과 |
| --- | --- |
| GCP 프로젝트 | `dog-velog` / `258374777454` |
| 리전·서비스 | `asia-northeast3` / `kkosunnae-backend` |
| 메모리·CPU | `4Gi` / `2000m` |
| Cloud Run 요청 동시성 | `80` |
| 운영 리비전 | `kkosunnae-backend-00034-zw5` |
| Pinecone | `embeded-animal`, 384차원, cosine, 8,073개 |
| Supabase | 동물 33,398건, `protect` 상태 개 11,055건 |

Cloud Run API가 반환한 서비스 주소는
https://kkosunnae-backend-zah352j55q-du.a.run.app 이다.
최근 24시간의 CPU·메모리 모니터링 API 조회는 403으로 거부되어 실제 사용량은
확인하지 못했다. 설정된 메모리와 실제 사용량을 구분해야 한다.

## 운영 데이터로 발견한 수정 사항

Supabase의 실제 보호 상태는 `protect`이다. 초기 구현의 한글 `보호` 조건만으로는
결과가 모두 제외되는 것을 발견해 `protect`와 한글 보호 상태를 모두 처리했다.
Node 24에서 빌드·린트·단위 검증 10개를 다시 통과했다.

외부 `/healthz` 요청은 Google의 404를 반환했고, 기본 `/`는 Express의
`Cannot GET /`를 반환했다. Cloud Run은 일부 `z`로 끝나는 경로를 예약한다.
[공식 알려진 문제](https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths)를
근거로 외부 확인용 `/health`를 추가하고 `/healthz`는 로컬 호환용으로 유지했다.
새 경로는 아직 운영에 배포되지 않았다.

## 실제 이미지 검색

보호 중인 공고 500건에서 기존 Pinecone 벡터가 있는 사례를 찾고, 같은 공고에
등록된 다른 사진을 질의 이미지로 사용했다. 등록 사진과 질의 이미지가 바이트까지
같은 경우는 제외했다. 최종 5건은 같은 지역의 자료이므로 표본 편향이 있다.

| 항목 | 결과 |
| --- | ---: |
| 실행 성공 | 5/5 |
| 정답이 상위 1개에 포함 | 4/5 |
| 정답이 상위 5개에 포함 | 5/5 |
| 정답이 상위 10개에 포함 | 5/5 |
| 준비 후 검색 p50 | 432.8ms |
| 준비 후 검색 p95 | 467.9ms |
| 평가 프로세스 최대 표본 RSS | 405.9MiB |

실제 로컬 모델·Pinecone·Supabase를 사용했고, 지연에는 추론과 원격 조회가 포함된다.
Cloud Run에서 처리한 지연이 아니며 5건의 결과를 서비스 전체 정확도로 일반화하면
안 된다. 여러 지역·품종·조명·촬영 각도로 평가셋을 늘려야 한다.

## 배포 상태

기존 자원·환경변수를 유지하고 운영 트래픽 없이 새 리비전을 배포하려 했으나,
GCP가 `iam.serviceAccounts.actAs` 권한 부족으로 거부했다. 이후 조회로 운영
리비전 `00034-zw5`와 트래픽 100%가 그대로임을 확인했다.
프로젝트 권한 조회에서 `cloudbuild.builds.create`도 허용되지 않았다.

현재 계정: `firebase-adminsdk-fbsvc@dog-velog.iam.gserviceaccount.com`

배포를 이어가려면 소스 배포 권한이 있는 계정이 필요하다. 현재 계정을 사용할
경우 최소한 다음 권한을 관리자가 검토해야 한다.

- 프로젝트의 소스 빌드 생성 권한: `cloudbuild.builds.create`
- 런타임 계정 `258374777454-compute@developer.gserviceaccount.com` 사용 권한:
  `iam.serviceAccounts.actAs`

권한을 임의로 추가하지 않았다. 권한 확보 후 트래픽 없는 리비전을 빌드하고,
`/health`와 실제 검색을 검증한 뒤 운영 트래픽을 전환한다.
원본 요약 수치는 [JSON 기록](2026-11-03-live-validation.json)에 있다.
