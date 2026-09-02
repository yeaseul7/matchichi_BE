import {createSupabaseServerClient} from "../shared/shelterAnimalSupabase.js";
import {embedTextQuery} from "../shared/textEmbedding.js";

const REGIONS = [
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
  "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
];

export interface TextSearchFilters {
  species: "개" | "고양이" | null;
  region: string | null;
}

export interface TextAnimalSearchResult {
  ok: true;
  query: string;
  filters: TextSearchFilters;
  limit: number;
  matches: Array<{animal: Record<string, unknown>; similarity: number}>;
}

/**
 * 검색어에서 확실한 축종·지역 필터만 추출합니다.
 * @param {string} query 사용자 검색어
 * @return {TextSearchFilters} 추출된 필터
 */
export function extractTextSearchFilters(query: string): TextSearchFilters {
  const species = /고양이|냥이|고양잇과/.test(query) ? "고양이" :
    /강아지|강쥐|댕댕이|멍멍이|반려견|믹스견|견종/.test(query) ?
      "개" : null;
  const region = REGIONS.find((candidate) => query.includes(candidate)) ?? null;
  return {species, region};
}

/**
 * 자연어 검색어로 Supabase 동물을 검색합니다.
 * @param {string} query 사용자 검색어
 * @param {number} limit 결과 수
 * @return {Promise<TextAnimalSearchResult>} 검색 결과
 */
export async function searchAnimalsByText(
  query: string,
  limit: number
): Promise<TextAnimalSearchResult> {
  const filters = extractTextSearchFilters(query);
  const embedding = await embedTextQuery(query);
  const supabase = createSupabaseServerClient();
  const {data, error} = await supabase.rpc("search_animals_by_text", {
    query_embedding: embedding,
    match_count: limit,
    minimum_similarity: 0.25,
    species_filter: filters.species,
    region_filter: filters.region,
  } as never);

  if (error) {
    throw new Error(`Supabase 텍스트 검색 실패: ${error.message}`);
  }

  return {
    ok: true,
    query,
    filters,
    limit,
    matches: (data ?? []) as Array<{
      animal: Record<string, unknown>;
      similarity: number;
    }>,
  };
}
