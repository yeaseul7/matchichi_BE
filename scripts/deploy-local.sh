#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

gcloud="${GCLOUD_BIN:-gcloud}"
if ! command -v "$gcloud" >/dev/null 2>&1; then
  gcloud="$HOME/google-cloud-sdk/bin/gcloud"
fi
command -v "$gcloud" >/dev/null || {
  echo "Google Cloud CLI를 설치하고 gcloud auth login을 실행하세요." >&2
  exit 1
}
# Docker 인증 도우미도 동일한 gcloud 설치 경로에서 찾습니다.
export PATH="$(dirname "$gcloud"):$PATH"
docker info >/dev/null

project=dog-velog
region=asia-northeast3
service=kkosunnae-backend
trigger=4f9b562f-83cc-4f8b-a0eb-380e3fc43770
disabled=$("$gcloud" builds triggers describe "$trigger" \
  --region=global --project="$project" --format='value(disabled)')
if [[ "$disabled" != "True" && "$disabled" != "true" ]]; then
  echo "Cloud Build 자동 트리거를 먼저 사용 중지하세요: $trigger" >&2
  exit 1
fi

image="$region-docker.pkg.dev/$project/cloud-run-source-deploy/$service/$service"
image="$image:local-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)"
docker buildx build --platform linux/amd64 --load --tag "$image" .

container=$(docker run --platform linux/amd64 --detach --rm "$image")
cleanup() { docker stop "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker exec "$container" node -e '
  (async () => {
    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch("http://127.0.0.1:8080/health");
        if (response.ok && (await response.json()).ok === true) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("로컬 컨테이너 상태 확인 실패");
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
'

"$gcloud" auth configure-docker "$region-docker.pkg.dev" --quiet
docker push "$image"
revision=$("$gcloud" run deploy "$service" --image="$image" \
  --region="$region" --project="$project" --no-traffic --tag=local-check \
  --quiet --format='value(status.latestReadyRevisionName)')
[[ -n "$revision" ]] || { echo "새 리비전 확인 실패" >&2; exit 1; }
url=$("$gcloud" run services describe "$service" \
  --region="$region" --project="$project" --format='value(status.url)')
check_url="https://local-check---${url#https://}"
curl --fail --silent --show-error --retry 5 --retry-delay 2 \
  --max-time 30 "$check_url/health" | node -e '
  let body = "";
  process.stdin.on("data", chunk => body += chunk);
  process.stdin.on("end", () => {
    if (JSON.parse(body).ok !== true) process.exitCode = 1;
  });
'
"$gcloud" run services update-traffic "$service" \
  --to-revisions="$revision=100" --region="$region" --project="$project" --quiet
echo "배포 완료: $revision ($image)"
