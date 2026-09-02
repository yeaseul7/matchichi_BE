import {
  createSupabaseServerClient,
  SUPABASE_ANIMALS_TABLE,
} from "../shared/shelterAnimalSupabase.js";
import {
  buildAnimalSearchText,
  embedAnimalTexts,
  hashSearchText,
  TextSearchAnimal,
} from "../shared/textEmbedding.js";

const TEXT_SELECT_FIELDS = [
  "id", "up_kind_nm", "kind_nm", "kind_full_nm", "color_cd", "age",
  "sex_cd", "neuter_yn", "weight", "org_nm", "happen_place", "care_addr",
  "special_mark", "sfe_soci", "sfe_health", "health_chk",
  "vaccination_chk", "etc_bigo", "search_text", "text_embedding_hash",
].join(",");

interface PendingAnimalRow extends TextSearchAnimal {
  id: string;
  search_text: string | null;
  text_embedding_hash: string | null;
}

export interface TextEmbeddingSyncResult {
  ok: true;
  requested: number;
  processed: number;
  skipped: number;
  remaining: number | null;
}

/**
 * 임베딩이 없거나 무효화된 동물을 배치 처리합니다.
 * @param {number} batchSize 한 번에 처리할 행 수
 * @return {Promise<TextEmbeddingSyncResult>} 처리 결과
 */
export async function syncAnimalTextEmbeddings(
  batchSize: number
): Promise<TextEmbeddingSyncResult> {
  const supabase = createSupabaseServerClient();
  const {data, error, count} = await supabase
    .from(SUPABASE_ANIMALS_TABLE)
    .select(TEXT_SELECT_FIELDS, {count: "exact"})
    .or("text_embedding.is.null,text_embedding_hash.is.null")
    .order("id", {ascending: true})
    .limit(batchSize);

  if (error) {
    throw new Error(`텍스트 임베딩 대상 조회 실패: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PendingAnimalRow[];
  const prepared = rows
    .map((row) => {
      const searchText = buildAnimalSearchText(row);
      return {row, searchText};
    })
    .filter(({searchText}) => Boolean(searchText));

  const embeddings = await embedAnimalTexts(
    prepared.map(({searchText}) => searchText)
  );
  const now = new Date().toISOString();
  const updates = prepared.map(({row, searchText}, index) => ({
    id: row.id,
    search_text: searchText,
    embedding: embeddings[index],
    embedding_hash: hashSearchText(searchText),
    embedded_at: now,
  }));

  if (updates.length > 0) {
    const {data: updatedCount, error: updateError} = await supabase.rpc(
      "save_animal_text_embeddings",
      {p_rows: updates} as never
    );
    if (updateError) {
      throw new Error(`텍스트 임베딩 저장 실패: ${updateError.message}`);
    }
    if (Number(updatedCount) !== updates.length) {
      throw new Error(
        "텍스트 임베딩 저장 건수 불일치: " +
        `expected=${updates.length}, actual=${updatedCount}`
      );
    }
  }

  return {
    ok: true,
    requested: batchSize,
    processed: updates.length,
    skipped: rows.length - updates.length,
    remaining: count === null ? null : Math.max(0, count - updates.length),
  };
}
