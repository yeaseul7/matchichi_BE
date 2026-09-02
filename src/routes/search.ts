import {Router} from "express";
import multer from "multer";
import {getRequiredEnv} from "../config/env.js";
import {searchAnimalsByText} from "../jobs/searchAnimalsByText.js";
import {searchSimilarAnimals} from "../jobs/searchSimilarAnimals.js";
import {consumeTextSearchAllowance} from "../shared/searchUsage.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: 10 * 1024 * 1024, files: 1},
});

// eslint-disable-next-line new-cap
export const searchRouter = Router();

searchRouter.post("/api/search/animals", upload.single("file"), async (
  req,
  res
) => {
  const file = req.file;
  const imageUrl = typeof req.body?.imageUrl === "string" ?
    req.body.imageUrl.trim() : "";
  const requestedTopK = Number(req.body?.topK ?? 10);
  const topK = Math.min(50, Math.max(1, Math.floor(requestedTopK) || 10));

  if (!file && (!imageUrl || !imageUrl.startsWith("http"))) {
    res.status(400).json({
      ok: false,
      error: "검색할 file 또는 유효한 imageUrl이 필요합니다.",
    });
    return;
  }

  try {
    const image = file ?
      new Blob([new Uint8Array(file.buffer)], {
        type: file.mimetype || "application/octet-stream",
      }) : imageUrl;
    const result = await searchSimilarAnimals(
      image,
      getRequiredEnv("PINECONE_API_KEY"),
      topK
    );
    res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("유사 동물 이미지 검색 실패:", error);
    res.status(500).json({ok: false, error: message});
  }
});

searchRouter.post("/api/search/text", async (req, res) => {
  const query = typeof req.body?.query === "string" ?
    req.body.query.trim() : "";
  const requestedLimit = Number(req.body?.limit ?? 24);
  const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit) || 24));

  if (!query || query.length > 300) {
    res.status(400).json({
      ok: false,
      error: "query는 1~300자여야 합니다.",
    });
    return;
  }

  try {
    const allowance = await consumeTextSearchAllowance(req);
    if (!allowance.allowed) {
      res.status(429).json({
        ok: false,
        error: "오늘 사용할 수 있는 AI 검색 횟수를 모두 사용했습니다.",
        usage: allowance,
      });
      return;
    }

    const result = await searchAnimalsByText(query, limit);
    res.status(200).json({...result, usage: allowance});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("자연어 동물 검색 실패:", error);
    res.status(500).json({ok: false, error: message});
  }
});
