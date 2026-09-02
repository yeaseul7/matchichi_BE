import "dotenv/config";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {searchAnimalsByText} from "../jobs/searchAnimalsByText.js";

interface EvaluationCase {
  query: string;
  expectedTerms: string[];
}

/**
 * 검색 결과 텍스트를 평탄화합니다.
 * @param {Record<string, unknown>} animal 동물 검색 결과
 * @return {string} 비교용 문자열
 */
function flattenAnimal(animal: Record<string, unknown>): string {
  return Object.values(animal)
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * 평가 데이터 50개를 순차 실행합니다.
 * @return {Promise<void>}
 */
async function main(): Promise<void> {
  const filePath = resolve("evaluation/text-search-cases.json");
  const cases = JSON.parse(
    await readFile(filePath, "utf8")
  ) as EvaluationCase[];
  let top5Successes = 0;

  for (const testCase of cases) {
    const result = await searchAnimalsByText(testCase.query, 10);
    const top5 = result.matches.slice(0, 5);
    const success = top5.some(({animal}) => {
      const text = flattenAnimal(animal ?? {});
      return testCase.expectedTerms.every((term) =>
        text.includes(term.toLowerCase())
      );
    });
    if (success) top5Successes++;
    console.info(`${success ? "PASS" : "FAIL"} ${testCase.query}`);
  }

  const rate = cases.length === 0 ? 0 : top5Successes / cases.length;
  console.info(
    `Top-5 성공률: ${(rate * 100).toFixed(1)}% ` +
    `(${top5Successes}/${cases.length})`
  );
  if (rate < 0.8) process.exitCode = 1;
}

void main();
