import {Router} from "express";

// Express의 Router 팩토리는 생성자가 아니지만 이름이 대문자로 시작합니다.
// eslint-disable-next-line new-cap
export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({ok: true});
});
