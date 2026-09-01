import express, {type Express} from "express";
import {corsMiddleware} from "./middleware/cors.js";
import {errorHandler} from "./middleware/errorHandler.js";
import {healthRouter} from "./routes/health.js";
import {imagesRouter} from "./routes/images.js";
import {searchRouter} from "./routes/search.js";
import {syncRouter} from "./routes/sync.js";

/**
 * Express 애플리케이션을 생성합니다.
 * @return {Express} Express 애플리케이션
 */
export function createApp(): Express {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());
  app.use(healthRouter);
  app.use(syncRouter);
  app.use(imagesRouter);
  app.use(searchRouter);
  app.use(errorHandler);
  return app;
}
