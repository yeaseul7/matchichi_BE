import {Router} from "express";
import multer from "multer";
import {getRequiredEnv} from "../config/env.js";
import {searchSimilarAnimals} from "../jobs/searchSimilarAnimals.js";

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
