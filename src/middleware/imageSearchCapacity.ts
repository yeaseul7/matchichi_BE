import type {RequestHandler} from "express";
import {imageLimit} from "../shared/imageLimits.js";

let active = 0;

// multer가 버퍼를 할당하기 전에 동시 검색 수를 제한합니다.
export const imageSearchCapacity: RequestHandler = (_req, res, next) => {
  if (active >= imageLimit("IMAGE_SEARCH_MAX_INFLIGHT", 2, 10)) {
    res.setHeader("Retry-After", "5");
    res.status(429).json({ok: false, error: "이미지 검색이 혼잡합니다. 재시도하세요."});
    return;
  }
  active++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active--;
  };
  res.once("finish", release);
  res.once("close", release);
  next();
};
