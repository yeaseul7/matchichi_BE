import type {RequestHandler} from "express";
import {isProductionRuntime} from "../config/env.js";

export const verifySchedulerRequest: RequestHandler = (req, res, next) => {
  const expected = process.env.SCHEDULER_HTTP_TOKEN?.trim() ??
    process.env.SHELTER_BACKFILL_HTTP_TOKEN?.trim();

  if (!expected) {
    if (isProductionRuntime()) {
      console.error("Scheduler 인증 차단: 인증 토큰이 설정되지 않았습니다.");
      res.status(503).json({
        ok: false,
        error: "Scheduler authentication is not configured",
      });
      return;
    }
    next();
    return;
  }

  const auth = req.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ?
    auth.slice("bearer ".length) :
    "";
  const sent = req.get("x-scheduler-token") ??
    req.get("x-backfill-token") ??
    bearer;

  if (sent !== expected) {
    res.status(403).json({ok: false, error: "Forbidden"});
    return;
  }
  next();
};
