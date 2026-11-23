# 이미지 검색 평가

DINOv2-small과 기존 Pinecone 인덱스를 유지하면서 실제 검색 품질을 비교합니다.
정답을 임의로 만들어 넣지 않았으므로 실제 사진과 공고 번호를 준비해야 합니다.

Node 24 실제 추론·메모리·HTTP 검증 결과는
[2026-11-03 검증 기록](results/2026-11-03-local-validation.md)에 정리했습니다.
실제 GCP 자원·등록 사진 검색·배포 권한 확인 결과는
[운영 연결 검증 기록](results/2026-11-03-live-validation.md)에 있습니다.

## 평가셋 준비

`image-search-cases.example.json`을 저장소 밖으로 복사하고 실제 값으로 채웁니다.
사진 경로는 JSON 파일 위치를 기준으로 해석합니다. 공고 번호는 Pinecone 벡터 ID나
Supabase UUID가 아닌 `desertionNo` 문자열입니다.

- 정면/측면, 조명 차이, 작은 피사체, 배경이 복잡한 사례를 포함합니다.
- 등록 사진과 바이트가 같은 사진만으로 평가하지 않습니다.
- 같은 품종·털색의 다른 개체를 후보에 포함합니다.
- 동일 개체 검색과 외형 유사 검색의 정답을 구분해 별도 평가셋으로 관리합니다.
- 개발용/검증용은 동물 단위로 분리합니다.
- 현재 Supabase에 `protect` 또는 `보호중` 상태로 남아 있고 Pinecone에 등록된 개만 정답으로 넣습니다.
- 전후 비교 시 같은 공고 데이터와 평가셋을 사용합니다.

```bash
npm run build
npm run evaluate:image-search -- /absolute/path/image-search-cases.json
```

`.env`에 `PINECONE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`가 필요합니다.
평가는 벡터를 쓰거나 삭제하지 않고 실제 서비스와 같은 검색을 순차 실행합니다.
Pinecone/Supabase 조회 비용과 로컬 추론 자원을 사용합니다.

## 출력

- `hitAt1/5/10`: 상위 K개에 정답이 하나 이상 포함된 사례 비율
- `recallAt10`: 사례별 정답 중 상위 10개에 포함된 비율의 평균
- `failures`: 실행 실패 사례 수. 검색 품질 지표의 분모에도 포함합니다.
- `coldStartMs`: 첫 검색 시간. 모델 준비와 외부 조회를 포함합니다.
- `warmP50Ms/warmP95Ms`: 준비 이후 검색 지연. 파일 읽기 제외, 추론·외부 조회 포함
- `peakRssMiB`: 평가 프로세스 RSS 표본 최대값. Cloud Run 전체 메모리와 다릅니다.

성공률 기준과 최소 유사도는 실제 결과를 보고 결정합니다. 현재는 유사도 기준에
따른 결과 거절이나 강아지 검출을 하지 않으므로, 비강아지 입력의 오탐은 별도로
수집해야 합니다. 결과 점수는 동일 개체일 확률이 아닙니다.

## Cloud Run 자원 확인

저장소에 배포된 서비스의 메모리·CPU·동시 요청 설정은 없습니다.
인증된 gcloud 환경에서 다음과 같이 조회합니다.

```bash
gcloud run services describe SERVICE --project PROJECT --region REGION \
  --format='yaml(spec.template.spec.containerConcurrency,spec.template.spec.containers.resources,spec.template.metadata.annotations)'
```

메모리 사용량과 p95 지연을 먼저 확인한 뒤 실행 동시성을 조정합니다.
프로세스 내부 동시성 제한은 Cloud Run의 인스턴스 수나 전체 비용을 제한하지 않습니다.
배포 전 staging에서 동시 요청, cold start, OOM 여부를 확인해야 합니다.
