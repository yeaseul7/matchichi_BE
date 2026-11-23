import {Pinecone} from "@pinecone-database/pinecone";
import {
  fetchAbandonmentApiPage,
  normalizeHappenYyyyMmDd,
  parseShelterItemList,
  SHELTER_API_PAGE_SIZE,
  todayYyyyMmDdSeoul,
} from "./shelterAnimalApi.js";
import {
  PINECONE_INDEX_NAME,
  embedImage,
} from "./imageEmbedding.js";
import {ShelterAnimalItem} from "./types.js";
import {withSyncLease} from "./syncSafety.js";
import {getAnimalImages} from "./animalImages.js";
import {ImageRequestError} from "./imageLimits.js";

const UPSERT_BATCH_SIZE = 100;
const FETCH_BATCH_SIZE = 50;
/** 청크 단위: 한 번에 벡터화할 개수 (공공 API·메모리 부담 완화) */
const CHUNK_SIZE = 1;
/** 5장 처리 후 휴식 시간(ms). 공공기관 서버·메모리 안정용 */
const DELAY_BETWEEN_CHUNKS_MS = 500;
const EMBED_MAX_ATTEMPTS = 3;
const PINECONE_JOB_NAME = "pinecone-maintenance";

export interface SyncAnimalEmbeddingsOptions {
  pageStart?: number;
  pageCount?: number;
  todayOnly?: boolean;
  skipExisting?: boolean;
}

export interface SyncAnimalEmbeddingsResult {
  ok: true;
  pageStart: number;
  pageEnd: number;
  totalPages: number;
  apiRows: number;
  candidates: number;
  skippedExisting: number;
  embedded: number;
  embedFailed: number;
}

/**
 * @param {number} ms 대기 시간(ms)
 * @return {Promise<void>} ms 후 resolve
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 일시적인 이미지 서버 오류를 재시도하며 이미지 임베딩
 * @param {string} imageUrl 이미지 URL
 * @param {string} docId 로그용 record id
 * @return {Promise<number[] | null>} 임베딩 또는 영구 실패 시 null
 */
async function embedImageWithRetry(
  imageUrl: string,
  docId: string
): Promise<number[] | null> {
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt++) {
    try {
      return await embedImage(imageUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanentFailure =
        (error instanceof ImageRequestError &&
          [400, 413].includes(error.status)) ||
        message.includes("404") ||
        message.includes("400") ||
        message.includes("Invalid image");
      if (permanentFailure || attempt === EMBED_MAX_ATTEMPTS) {
        console.warn(
          `이미지 임베딩 실패: id ${docId}, attempt ${attempt}, ${message}`
        );
        return null;
      }
      await delay(1000 * attempt);
    }
  }

  return null;
}

/**
 * 공공데이터 지정 페이지를 조회해 이미지 벡터를 Pinecone에 upsert
 * @param {string} serviceKey 공공데이터 API 인증키
 * @param {string} pineconeApiKey Pinecone API 키
 * @param {SyncAnimalEmbeddingsOptions} options 페이지 및 날짜 필터 옵션
 * @return {Promise<SyncAnimalEmbeddingsResult>} 동기화 결과
 */
async function runSyncCore(
  serviceKey: string,
  pineconeApiKey: string,
  options: SyncAnimalEmbeddingsOptions = {}
): Promise<SyncAnimalEmbeddingsResult> {
  const pc = new Pinecone({apiKey: pineconeApiKey});
  const index = pc.index(PINECONE_INDEX_NAME);

  const pageStart = Math.max(1, Math.floor(options.pageStart ?? 1));
  const pageCount = Math.max(1, Math.floor(options.pageCount ?? 1));
  const todayOnly = options.todayOnly ?? true;
  const skipExisting = options.skipExisting ?? false;
  const todayYmd = todayYyyyMmDdSeoul();

  type Candidate =
    { docId: string; item: ShelterAnimalItem; imageUrl: string };
  const candidates: Candidate[] = [];
  let apiRows = 0;
  let totalPages = pageStart;
  let pageEnd = pageStart - 1;

  for (let pageNo = pageStart; pageNo < pageStart + pageCount; pageNo++) {
    const data = await fetchAbandonmentApiPage(
      serviceKey,
      pageNo,
      SHELTER_API_PAGE_SIZE
    );
    const {itemList, totalCount} = parseShelterItemList(data);
    totalPages = Math.max(1, Math.ceil(totalCount / SHELTER_API_PAGE_SIZE));
    if (pageNo > totalPages) break;

    apiRows += itemList.length;
    pageEnd = pageNo;

    for (const item of itemList) {
      if (
        todayOnly &&
        normalizeHappenYyyyMmDd(item.happenDt) !== todayYmd
      ) {
        continue;
      }
      const desertionNo = String(item.desertionNo ?? "").trim();
      const careRegNo = String(item.careRegNo ?? "").trim();
      if (!desertionNo || !careRegNo) continue;
      for (const image of getAnimalImages(item)) {
        candidates.push({...image, item});
      }
    }

    console.info(
      `Pinecone 동기화 API 조회: page ${pageNo}/${totalPages}, ` +
        `pageRows ${itemList.length}건, 누적 후보 ${candidates.length}건`
    );

    if (pageNo >= totalPages) break;
  }

  let toEmbed = candidates;
  let skippedExisting = 0;
  if (skipExisting && candidates.length > 0) {
    const existingIds = new Set<string>();
    for (let i = 0; i < candidates.length; i += FETCH_BATCH_SIZE) {
      const ids = candidates
        .slice(i, i + FETCH_BATCH_SIZE)
        .map(({docId}) => docId);
      const response = await index.fetch({ids});
      for (const candidate of candidates.slice(i, i + FETCH_BATCH_SIZE)) {
        const metadata = response.records[candidate.docId]?.metadata;
        if (metadata?.imageUrl === candidate.imageUrl &&
            metadata?.sourceUpdatedAt === String(candidate.item.updTm ?? "") &&
            metadata?.upKindCd === String(candidate.item.upKindCd ?? "")) {
          existingIds.add(candidate.docId);
        }
      }
    }
    toEmbed = candidates.filter(({docId}) => !existingIds.has(docId));
    skippedExisting = candidates.length - toEmbed.length;
  }

  let embedded = 0;
  let embedFailed = 0;

  const recordsToUpsert: Array<{
    id: string;
    values: number[];
    metadata: {
      desertionNo: string;
      careRegNo: string;
      imageUrl: string;
      upKindCd: string;
      orgNm: string;
      sourceUpdatedAt: string;
    };
  }> = [];

  for (let i = 0; i < toEmbed.length; i += CHUNK_SIZE) {
    const chunk = toEmbed.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(async ({docId, item, imageUrl}) => {
        const embedding = await embedImageWithRetry(imageUrl, docId);
        if (!embedding) return null;
        return {
          id: docId,
          values: embedding,
          metadata: {
            desertionNo: String(item.desertionNo ?? ""),
            careRegNo: String(item.careRegNo ?? ""),
            imageUrl,
            sourceUpdatedAt: String(item.updTm ?? ""),
            upKindCd: String(item.upKindCd ?? ""),
            orgNm: String(item.orgNm ?? ""),
          },
        };
      })
    );

    for (const rec of chunkResults) {
      if (!rec) {
        embedFailed++;
        continue;
      }
      recordsToUpsert.push(rec);
      embedded++;
    }

    if (recordsToUpsert.length >= UPSERT_BATCH_SIZE) {
      await index.upsert({records: recordsToUpsert});
      console.info(
        `배치 저장: ${recordsToUpsert.length}건 ` +
          `(누적 임베딩 성공 ${embedded}건)`
      );
      recordsToUpsert.length = 0;
    }

    if ((i + 1) % 5 === 0 && i + CHUNK_SIZE < toEmbed.length) {
      await delay(DELAY_BETWEEN_CHUNKS_MS);
    }
  }

  if (recordsToUpsert.length > 0) {
    await index.upsert({records: recordsToUpsert});
    console.info(`배치 저장: ${recordsToUpsert.length}건 (누적 임베딩 성공 ${embedded}건)`);
  }

  console.info(
    `동기화 완료: page ${pageStart}-${pageEnd}/${totalPages}, ` +
    `API rows ${apiRows}건, todayOnly ${todayOnly}, ` +
    `${todayOnly ? `유기일 ${todayYmd}·` : ""}` +
    `이미지 있음 후보 ${candidates.length}건, ` +
    `기존 벡터 건너뜀 ${skippedExisting}건, ` +
    `Pinecone 임베딩 성공 ${embedded}건, 이미지 실패 ${embedFailed}건`
  );

  return {
    ok: true,
    pageStart,
    pageEnd,
    totalPages,
    apiRows,
    candidates: candidates.length,
    skippedExisting,
    embedded,
    embedFailed,
  };
}

/**
 * cleanup과 겹치지 않도록 분산 잠금이 적용된 Pinecone 동기화
 * @param {string} serviceKey 공공데이터 API 인증키
 * @param {string} pineconeApiKey Pinecone API 키
 * @param {SyncAnimalEmbeddingsOptions} options 페이지 및 날짜 필터 옵션
 * @return {Promise<SyncAnimalEmbeddingsResult>} 동기화 결과
 */
export async function runSync(
  serviceKey: string,
  pineconeApiKey: string,
  options: SyncAnimalEmbeddingsOptions = {}
): Promise<SyncAnimalEmbeddingsResult> {
  return withSyncLease(PINECONE_JOB_NAME, () =>
    runSyncCore(serviceKey, pineconeApiKey, options)
  );
}
