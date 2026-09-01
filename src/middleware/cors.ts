import type {RequestHandler} from "express";

export const corsMiddleware: RequestHandler = (req, res, next) => {
  const origin = req.get("origin");
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).send();
    return;
  }
  next();
};
