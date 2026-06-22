import "dotenv/config";
import {migrateBoardsToSupabase} from "../jobs/migrateBoardsToSupabase.js";

/**
 * boards 마이그레이션 CLI 진입점
 * @return {Promise<void>} 완료 시 resolve
 */
async function main(): Promise<void> {
  const result = await migrateBoardsToSupabase();
  console.info(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error("boards 마이그레이션 실패:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  } else {
    console.error("boards 마이그레이션 실패:", String(error));
  }
  process.exitCode = 1;
});
