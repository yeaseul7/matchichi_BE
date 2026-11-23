import type {ErrorRequestHandler} from "express";
import {MulterError} from "multer";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  void _next;
  const message = error instanceof Error ? error.message : String(error);
  console.error("API 요청 처리 실패:", error);
  const status = error instanceof MulterError ?
    (error.code === "LIMIT_FILE_SIZE" ? 413 : 400) : 500;
  res.status(status).json({ok: false, error: message});
};
