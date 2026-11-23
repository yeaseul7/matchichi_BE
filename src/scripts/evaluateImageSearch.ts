/* eslint-disable valid-jsdoc */
import "dotenv/config";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {performance} from "node:perf_hooks";
import {searchSimilarAnimals} from "../jobs/searchSimilarAnimals.js";
import {getRequiredEnv} from "../config/env.js";
import {IMAGE_MODEL_ID} from "../shared/imageEmbedding.js";

interface EvaluationCase {
  name: string;
  imagePath: string;
  expectedDesertionNos: string[];
}

/** 실제 사진과 공고 ID로 준비한 평가셋을 순차 실행합니다. */
async function main(): Promise<void> {
  if (!process.argv[2]) {
    throw new Error("평가 JSON 경로가 필요합니다. evaluation/README.md를 확인하세요.");
  }
  const path = resolve(process.argv[2]);
  const cases: EvaluationCase[] = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(cases) || !cases.length || cases.some((item) =>
    typeof item.name !== "string" || typeof item.imagePath !== "string" ||
    !Array.isArray(item.expectedDesertionNos) ||
    !item.expectedDesertionNos.length ||
    item.expectedDesertionNos.some((id) => typeof id !== "string" || !id))) {
    throw new Error("각 사례에 name, imagePath, 정답 공고 번호 배열이 필요합니다.");
  }
  const key = getRequiredEnv("PINECONE_API_KEY");
  const durations: number[] = [];
  const hits = {1: 0, 5: 0, 10: 0};
  let recallSum = 0;
  let failures = 0;
  let coldStartMs = 0;
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  try {
    // 첫 사례로 모델을 준비하고 cold start를 별도로 기록합니다.
    const warmup = new Blob([new Uint8Array(
      await readFile(resolve(dirname(path), cases[0].imagePath))
    )]);
    const coldStart = performance.now();
    await searchSimilarAnimals(warmup, key, 10);
    coldStartMs = performance.now() - coldStart;
    for (const item of cases) {
      try {
        const image = new Blob([new Uint8Array(
          await readFile(resolve(dirname(path), item.imagePath))
        )]);
        const start = performance.now();
        const result = await searchSimilarAnimals(image, key, 10);
        durations.push(performance.now() - start);
        const expected = new Set(item.expectedDesertionNos);
        const ids = result.matches.map((match) =>
          String(match.metadata?.desertionNo ?? ""));
        for (const k of [1, 5, 10] as const) {
          if (ids.slice(0, k).some((id) => expected.has(id))) hits[k]++;
        }
        recallSum += new Set(ids.filter((id) => expected.has(id))).size /
          expected.size;
      } catch (error) {
        failures++;
        console.error(`${item.name}: ${String(error)}`);
      }
    }
  } finally {
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  durations.sort((a, b) => a - b);
  const percentile = (p: number) => durations.length ?
    durations[Math.ceil(durations.length * p) - 1] : null;
  console.info(JSON.stringify({
    model: IMAGE_MODEL_ID,
    cases: cases.length,
    failures,
    hitAt1: hits[1] / cases.length,
    hitAt5: hits[5] / cases.length,
    hitAt10: hits[10] / cases.length,
    recallAt10: recallSum / cases.length,
    coldStartMs,
    warmP50Ms: percentile(0.5),
    warmP95Ms: percentile(0.95),
    peakRssMiB: peakRss / 1024 / 1024,
  }, null, 2));
  if (failures) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
