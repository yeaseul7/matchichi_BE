import {Pinecone} from "@pinecone-database/pinecone";
import {
  PINECONE_INDEX_NAME,
  embedImage,
} from "../shared/imageEmbedding.js";
import {
  createSupabaseServerClient,
  SUPABASE_ANIMALS_TABLE,
} from "../shared/shelterAnimalSupabase.js";

export interface SimilarAnimalMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchSimilarAnimalsResult {
  ok: true;
  topK: number;
  matches: SimilarAnimalMatch[];
}

/**
 * 업로드 이미지와 유사한 Pinecone item 검색
 * @param {string | Blob} image 이미지 URL 또는 Blob
 * @param {string} pineconeApiKey Pinecone API 키
 * @param {number} topK 반환할 최대 결과 수
 * @return {Promise<SearchSimilarAnimalsResult>} 유사도 검색 결과
 */
export async function searchSimilarAnimals(
  image: string | Blob,
  pineconeApiKey: string,
  topK: number
): Promise<SearchSimilarAnimalsResult> {
  const vector = await embedImage(image);
  if (!vector) {
    throw new Error("이미지 임베딩 생성에 실패했습니다.");
  }

  const pc = new Pinecone({apiKey: pineconeApiKey});
  const index = pc.index(PINECONE_INDEX_NAME);
  const supabase = createSupabaseServerClient();
  let matches: SimilarAnimalMatch[] = [];
  // 종료 공고·중복 사진을 제거한 뒤에도 결과를 채우도록 후보 수를 늘립니다.
  for (const candidateCount of [Math.min(200, topK * 3), 500]) {
    const result = await index.query({
      vector,
      topK: candidateCount,
      filter: {upKindCd: {$eq: "417000"}},
      includeMetadata: true,
    });
    const candidates = result.matches ?? [];
    const numbers = [...new Set(candidates.map((match) =>
      String(match.metadata?.desertionNo ?? "")
    ).filter(Boolean))];
    if (!numbers.length) break;
    const rows: Array<{
      id: string; desertion_no: string; care_reg_no: string | null;
      process_state: string | null;
    }> = [];
    // URL 길이가 과도해지지 않도록 공고 번호를 나누어 조회합니다.
    for (let offset = 0; offset < numbers.length; offset += 100) {
      const {data, error} = await supabase.from(SUPABASE_ANIMALS_TABLE)
        .select("id, desertion_no, care_reg_no, process_state")
        .in("desertion_no", numbers.slice(offset, offset + 100))
        .eq("up_kind_cd", "417000");
      if (error) throw new Error(`검색 공고 상태 확인 실패: ${error.message}`);
      rows.push(...(data ?? []) as typeof rows);
    }
    const current = new Map(rows
      .filter((animal) => typeof animal.process_state === "string" &&
        (animal.process_state.trim() === "protect" ||
          animal.process_state.trim().startsWith("보호")))
      .map((animal) => [String(animal.desertion_no), animal]));
    const seen = new Set<string>();
    matches = [];
    for (const match of candidates) {
      const number = String(match.metadata?.desertionNo ?? "");
      const animal = current.get(number);
      if (!animal || seen.has(number) ||
          (animal.care_reg_no !== null &&
          String(animal.care_reg_no) !==
          String(match.metadata?.careRegNo ?? ""))) continue;
      seen.add(number);
      matches.push({
        id: match.id,
        score: match.score,
        metadata: {...match.metadata, animalId: animal.id},
      });
      if (matches.length === topK) break;
    }
    if (matches.length === topK || candidates.length < candidateCount) break;
  }

  return {
    ok: true,
    topK,
    matches,
  };
}
