import type {Response} from "express";
import {Router} from "express";
import {getRequiredEnv} from "../config/env.js";
import {
  backfillShelterInfoToSupabase,
} from "../jobs/backfillShelterInfoToSupabase.js";
import {cleanupPineconeEmbeddings} from "../jobs/cleanupPineconeEmbeddings.js";
import {syncShelterAnimalsStatus} from "../jobs/syncShelterAnimalsStatus.js";
import {verifySchedulerRequest} from "../middleware/schedulerAuth.js";
import {runSync} from "../shared/syncAnimalEmbeddingsCore.js";

// eslint-disable-next-line new-cap
export const syncRouter = Router();

syncRouter.use(verifySchedulerRequest);

syncRouter.post("/api/sync", async (_req, res) => {
  try {
    const result = await runSync(
      getRequiredEnv("ANIMALS_OPENAPI_KEY"),
      getRequiredEnv("PINECONE_API_KEY")
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(res, "동물 프로필 벡터화 동기화 실패", error);
  }
});

syncRouter.post("/api/backfill/pinecone", async (req, res) => {
  const pageStart = Number(req.query.pageStart ?? req.body?.pageStart ?? 1);
  const pageCount = Number(req.query.pageCount ?? req.body?.pageCount ?? 1);
  if (
    !Number.isInteger(pageStart) || pageStart < 1 ||
    !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 5
  ) {
    res.status(400).json({
      ok: false,
      error: "pageStart는 1 이상, pageCount는 1~5 정수여야 합니다.",
    });
    return;
  }

  try {
    const result = await runSync(
      getRequiredEnv("ANIMALS_OPENAPI_KEY"),
      getRequiredEnv("PINECONE_API_KEY"),
      {pageStart, pageCount, todayOnly: false, skipExisting: true}
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(res, "Pinecone 전체 백필 실패", error);
  }
});

syncRouter.post("/api/sync/status", async (req, res) => {
  const deleteStale = readBoolean(req.query.deleteStale, req.body?.deleteStale);
  const confirmDelete = readBoolean(
    req.query.confirmDelete,
    req.body?.confirmDelete
  );
  const allowLargeDelete = readBoolean(
    req.query.allowLargeDelete,
    req.body?.allowLargeDelete
  );

  try {
    const result = await syncShelterAnimalsStatus(
      getRequiredEnv("ANIMALS_OPENAPI_KEY"),
      {deleteStale: deleteStale && confirmDelete, allowLargeDelete}
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(res, "shelterAnimals 상태 동기화 실패", error);
  }
});

syncRouter.post("/api/sync/pinecone-cleanup", async (req, res) => {
  const requestedDelete =
    req.query.dryRun === "false" ||
    req.body?.dryRun === false ||
    req.body?.dryRun === "false";
  const confirmDelete = readBoolean(
    req.query.confirmDelete,
    req.body?.confirmDelete
  );
  const allowLargeDelete = readBoolean(
    req.query.allowLargeDelete,
    req.body?.allowLargeDelete
  );

  try {
    const result = await cleanupPineconeEmbeddings(
      getRequiredEnv("ANIMALS_OPENAPI_KEY"),
      getRequiredEnv("PINECONE_API_KEY"),
      {dryRun: !(requestedDelete && confirmDelete), allowLargeDelete}
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(res, "Pinecone stale vector 정리 실패", error);
  }
});

syncRouter.post("/api/backfill/shelters", async (_req, res) => {
  try {
    const result = await backfillShelterInfoToSupabase(
      getRequiredEnv("ANIMALS_OPENAPI_KEY")
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(res, "보호소 백필 실패", error);
  }
});

/**
 * 쿼리 또는 본문의 true 값을 읽습니다.
 * @param {unknown} queryValue 쿼리 값
 * @param {unknown} bodyValue 본문 값
 * @return {boolean} true 여부
 */
function readBoolean(queryValue: unknown, bodyValue: unknown): boolean {
  return queryValue === "true" || bodyValue === true || bodyValue === "true";
}

/**
 * 라우트 오류를 공통 응답 형식으로 반환합니다.
 * @param {Response} res Express 응답
 * @param {string} context 로그 문맥
 * @param {unknown} error 발생한 오류
 * @return {void}
 */
function handleError(res: Response, context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${context}:`, error);
  res.status(500).json({ok: false, error: message});
}
