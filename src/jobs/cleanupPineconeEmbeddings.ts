import {Pinecone} from "@pinecone-database/pinecone";
import {
  fetchAbandonmentApiPage,
  parseShelterItemList,
  SHELTER_API_PAGE_SIZE,
} from "../shared/shelterAnimalApi.js";
import {getAnimalImages} from "../shared/animalImages.js";
import {PINECONE_INDEX_NAME} from "../shared/imageEmbedding.js";
import {
  observeStaleCandidates,
  withSyncLease,
} from "../shared/syncSafety.js";

const PINECONE_LIST_PAGE_SIZE = 99;
const PINECONE_DELETE_BATCH_SIZE = 1000;
const LOG_ID_SAMPLE_SIZE = 10;
const MAX_STALE_RATIO = 0.25;
const MAX_DELETE_COUNT = 500;
const CLEANUP_JOB_NAME = "pinecone-maintenance";

export interface CleanupPineconeEmbeddingsOptions {
  dryRun?: boolean;
  allowLargeDelete?: boolean;
}

export interface CleanupPineconeEmbeddingsResult {
  ok: true;
  dryRun: boolean;
  apiRows: number;
  apiIds: number;
  pineconeIds: number;
  staleIds: number;
  eligibleStaleIds: number;
  deleted: number;
}

/**
 * 공공데이터 API 전체 페이지를 순회해 현재 유효한 Pinecone record id 목록 생성
 * @param {string} serviceKey 공공데이터 API 키
 * @param {string} runId 실행 로그 추적 ID
 * @return {Promise<object>} API row 수와 현재 id set
 */
async function fetchCurrentAnimalIds(
  serviceKey: string,
  runId: string
): Promise<{apiRows: number; ids: Set<string>}> {
  const ids = new Set<string>();
  let apiRows = 0;
  let pageNo = 1;
  let totalPages = 1;

  while (pageNo <= totalPages) {
    const data = await fetchAbandonmentApiPage(
      serviceKey,
      pageNo,
      SHELTER_API_PAGE_SIZE
    );
    const {itemList, totalCount} = parseShelterItemList(data);
    const resultCode = data.response?.header?.resultCode ?? "unknown";
    const resultMsg = data.response?.header?.resultMsg ?? "unknown";
    apiRows += itemList.length;
    totalPages = Math.max(1, Math.ceil(totalCount / SHELTER_API_PAGE_SIZE));

    console.info(
      `[${runId}] Pinecone 정리 기준 API 응답: ` +
        `page ${pageNo}/${totalPages}, resultCode ${resultCode}, ` +
        `resultMsg ${resultMsg}, totalCount ${totalCount}, ` +
        `pageRows ${itemList.length}`
    );

    for (const item of itemList) {
      const desertionNo = String(item.desertionNo ?? "").trim();
      const careRegNo = String(item.careRegNo ?? "").trim();
      if (!desertionNo || !careRegNo) continue;
      ids.add(`${desertionNo}-${careRegNo}`);
      for (const image of getAnimalImages(item)) ids.add(image.docId);
    }

    console.info(
      `[${runId}] Pinecone 정리 기준 API 조회: page ${pageNo}/${totalPages}, ` +
        `누적 id ${ids.size}건`
    );
    pageNo++;
  }

  return {apiRows, ids};
}

/**
 * Pinecone 인덱스의 전체 record id 목록 조회
 * @param {string} pineconeApiKey Pinecone API 키
 * @param {string} runId 실행 로그 추적 ID
 * @return {Promise<string[]>} Pinecone record id 목록
 */
async function listPineconeIds(
  pineconeApiKey: string,
  runId: string
): Promise<string[]> {
  const pc = new Pinecone({apiKey: pineconeApiKey});
  const index = pc.index(PINECONE_INDEX_NAME);
  const ids: string[] = [];
  let paginationToken: string | undefined;

  do {
    const response = await index.listPaginated({
      limit: PINECONE_LIST_PAGE_SIZE,
      paginationToken,
    });
    for (const vector of response.vectors ?? []) {
      if (vector.id) ids.push(vector.id);
    }
    paginationToken = response.pagination?.next;
    console.info(`[${runId}] Pinecone id 조회 진행: 누적 ${ids.length}건`);
  } while (paginationToken);

  return ids;
}

/**
 * 공공데이터에 없는 Pinecone record 삭제
 * @param {string} serviceKey 공공데이터 API 키
 * @param {string} pineconeApiKey Pinecone API 키
 * @param {CleanupPineconeEmbeddingsOptions} options 실행 옵션
 * @return {Promise<CleanupPineconeEmbeddingsResult>} 정리 결과
 */
async function cleanupPineconeEmbeddingsCore(
  serviceKey: string,
  pineconeApiKey: string,
  options: CleanupPineconeEmbeddingsOptions = {}
): Promise<CleanupPineconeEmbeddingsResult> {
  const runId = `pinecone-cleanup-${Date.now()}`;
  const startedAt = Date.now();
  const dryRun = options.dryRun ?? true;
  const allowLargeDelete = options.allowLargeDelete ?? false;

  console.info(
    `[${runId}] Pinecone 정리 시작: index ${PINECONE_INDEX_NAME}, ` +
      `dryRun ${dryRun}`
  );

  const current = await fetchCurrentAnimalIds(serviceKey, runId);
  if (current.apiRows === 0 || current.ids.size === 0) {
    console.error(
      `[${runId}] Pinecone 정리 안전 차단: API rows ${current.apiRows}건, ` +
        `API ids ${current.ids.size}건. 삭제를 실행하지 않습니다.`
    );
    throw new Error(
      "공공데이터 API 유효 ID가 0건이므로 Pinecone 삭제를 중단했습니다."
    );
  }

  const pineconeIds = await listPineconeIds(pineconeApiKey, runId);
  const staleIds = pineconeIds.filter((id) => !current.ids.has(id));
  const eligibleStaleIds = await observeStaleCandidates(
    CLEANUP_JOB_NAME,
    runId,
    staleIds
  );
  const staleRatio = pineconeIds.length === 0 ?
    0 :
    eligibleStaleIds.length / pineconeIds.length;

  console.info(
    `[${runId}] Pinecone 삭제 대상 계산: API ids ${current.ids.size}건, ` +
      `Pinecone ids ${pineconeIds.length}건, stale ${staleIds.length}건, ` +
      `2회 연속 stale ${eligibleStaleIds.length}건, ` +
      `stale sample ${JSON.stringify(staleIds.slice(0, LOG_ID_SAMPLE_SIZE))}`
  );

  if (
    !dryRun &&
    (staleRatio > MAX_STALE_RATIO ||
      eligibleStaleIds.length > MAX_DELETE_COUNT) &&
    !allowLargeDelete
  ) {
    throw new Error(
      "Pinecone 대량 삭제 안전 차단: eligible " +
      `${eligibleStaleIds.length}/${pineconeIds.length} ` +
      `(${(staleRatio * 100).toFixed(1)}%). ` +
      `25% 또는 ${MAX_DELETE_COUNT}건 초과 삭제는 ` +
      "allowLargeDelete=true가 필요합니다."
    );
  }

  let deleted = 0;
  if (!dryRun && eligibleStaleIds.length > 0) {
    const pc = new Pinecone({apiKey: pineconeApiKey});
    const index = pc.index(PINECONE_INDEX_NAME);

    for (
      let i = 0;
      i < eligibleStaleIds.length;
      i += PINECONE_DELETE_BATCH_SIZE
    ) {
      const ids = eligibleStaleIds.slice(i, i + PINECONE_DELETE_BATCH_SIZE);
      await index.deleteMany({ids});
      deleted += ids.length;
      console.info(
        `[${runId}] Pinecone stale vector 삭제 진행: ` +
          `${deleted}/${eligibleStaleIds.length}`
      );
    }
  }

  console.info(
    `[${runId}] Pinecone 정리 완료: API ids ${current.ids.size}건, ` +
      `Pinecone ids ${pineconeIds.length}건, stale ${staleIds.length}건, ` +
      `eligible ${eligibleStaleIds.length}건, ` +
      `deleted ${deleted}건, dryRun ${dryRun}, ` +
      `durationMs ${Date.now() - startedAt}`
  );

  return {
    ok: true,
    dryRun,
    apiRows: current.apiRows,
    apiIds: current.ids.size,
    pineconeIds: pineconeIds.length,
    staleIds: staleIds.length,
    eligibleStaleIds: eligibleStaleIds.length,
    deleted,
  };
}

/**
 * 분산 잠금이 적용된 Pinecone stale vector 정리
 * @param {string} serviceKey 공공데이터 API 키
 * @param {string} pineconeApiKey Pinecone API 키
 * @param {CleanupPineconeEmbeddingsOptions} options 삭제 안전 옵션
 * @return {Promise<CleanupPineconeEmbeddingsResult>} 정리 결과
 */
export async function cleanupPineconeEmbeddings(
  serviceKey: string,
  pineconeApiKey: string,
  options: CleanupPineconeEmbeddingsOptions = {}
): Promise<CleanupPineconeEmbeddingsResult> {
  return withSyncLease(CLEANUP_JOB_NAME, () =>
    cleanupPineconeEmbeddingsCore(serviceKey, pineconeApiKey, options)
  );
}
