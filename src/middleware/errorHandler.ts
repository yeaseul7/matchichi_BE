import type {ErrorRequestHandler} from "express";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  void _next;
  const message = error instanceof Error ? error.message : String(error);
  console.error("API 요청 처리 실패:", error);
  res.status(500).json({ok: false, error: message});
};
