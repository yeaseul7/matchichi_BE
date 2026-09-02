import {createSupabaseServerClient} from "../shared/shelterAnimalSupabase.js";
import {embedTextQuery} from "../shared/textEmbedding.js";

const REGIONS = [
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
  "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
];

const BREED_ALIASES: ReadonlyArray<{
  canonical: string;
  aliases: readonly string[];
}> = [
  {canonical: "포메라니안", aliases: ["포메라니안", "포메"]},
  {canonical: "말티즈", aliases: ["말티즈", "말티"]},
  {canonical: "골든 리트리버", aliases: ["골든 리트리버", "골든리트리버", "골댕이"]},
  {canonical: "래브라도 리트리버", aliases: ["래브라도 리트리버", "래브라도"]},
  {canonical: "시베리안 허스키", aliases: ["시베리안 허스키", "허스키"]},
  {canonical: "보더 콜리", aliases: ["보더 콜리", "보더콜리", "보더"]},
  {canonical: "프렌치 불독", aliases: ["프렌치 불독", "프렌치불독", "프불"]},
  {canonical: "미니어처 푸들", aliases: ["미니어처 푸들", "미니푸들"]},
  {canonical: "푸들", aliases: ["푸들"]},
  {canonical: "치와와", aliases: ["치와와", "치와"]},
  {canonical: "시츄", aliases: ["시츄", "시추"]},
  {canonical: "웰시 코기", aliases: ["웰시 코기", "웰시코기", "코기"]},
  {canonical: "비숑 프리제", aliases: ["비숑 프리제", "비숑"]},
  {canonical: "닥스훈트", aliases: ["닥스훈트", "닥스"]},
  {canonical: "사모예드", aliases: ["사모예드", "사모"]},
  {canonical: "진도견", aliases: ["진도견", "진돗개", "진도"]},
  {canonical: "믹스견", aliases: ["믹스견", "믹스"]},
];

export interface TextSearchFilters {
  species: "개" | "고양이" | null;
  region: string | null;
  breed: string | null;
  minimumAge: number | null;
  maximumAge: number | null;
}

export interface TextAnimalSearchResult {
  ok: true;
  query: string;
  semanticQuery: string;
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
  const breedMatch = findBreed(query);
  const species = /고양이|냥이|고양잇과/.test(query) ? "고양이" :
    /강아지|강쥐|댕댕이|멍멍이|반려견|믹스견|견종/.test(query) ?
      "개" : breedMatch ? "개" : null;
  const region = REGIONS.find((candidate) => query.includes(candidate)) ?? null;
  const ages = extractAgeRange(query);
  return {
    species,
    region,
    breed: breedMatch?.canonical ?? null,
    minimumAge: ages.minimumAge,
    maximumAge: ages.maximumAge,
  };
}

/**
 * 검색어에서 구조화 필터 표현을 제거해 의미 검색 문장을 만듭니다.
 * @param {string} query 사용자 검색어
 * @return {string} 의미 검색에 사용할 문장
 */
export function buildSemanticQuery(query: string): string {
  let semanticQuery = query;
  const breed = findBreed(query);
  if (breed) semanticQuery = semanticQuery.replace(breed.alias, " ");

  semanticQuery = semanticQuery
    .replace(/\d{1,2}\s*(?:살|세)\s*(?:이하|미만|이상)?/g, " ")
    .replace(/애기|아기|어린|새끼|노령|노견|노묘/g, " ")
    .replace(/고양이|냥이|고양잇과|강아지|강쥐|댕댕이|멍멍이|반려견|견종/g, " ");

  for (const region of REGIONS) {
    semanticQuery = semanticQuery.replace(region, " ");
  }

  const stopWords = new Set(["에", "에서", "있는", "인", "의", "중", "아이"]);
  semanticQuery = semanticQuery.replace(/\s+/g, " ").trim();
  semanticQuery = semanticQuery.split(" ")
    .filter((word) => !stopWords.has(word))
    .join(" ");
  return semanticQuery || query;
}

/**
 * 검색어와 일치하는 정식 품종명 및 별칭을 찾습니다.
 * @param {string} query 사용자 검색어
 * @return {object | null} 품종 일치 결과
 */
function findBreed(query: string): {canonical: string; alias: string} | null {
  const matches = BREED_ALIASES.flatMap(({canonical, aliases}) =>
    aliases.map((alias) => ({canonical, alias}))
  ).sort((left, right) => right.alias.length - left.alias.length);
  return matches.find(({alias}) => query.includes(alias)) ?? null;
}

/**
 * 검색어에서 서비스 정책에 따른 나이 범위를 추출합니다.
 * @param {string} query 사용자 검색어
 * @return {object} 나이 범위
 */
function extractAgeRange(query: string): {
  minimumAge: number | null;
  maximumAge: number | null;
} {
  const explicit = query.match(/(\d{1,2})\s*(?:살|세)\s*(이하|미만|이상)?/);
  if (explicit) {
    const age = Number(explicit[1]);
    if (explicit[2] === "이하") return {minimumAge: null, maximumAge: age};
    if (explicit[2] === "미만") {
      return {minimumAge: null, maximumAge: Math.max(0, age - 1)};
    }
    if (explicit[2] === "이상") return {minimumAge: age, maximumAge: null};
    return {minimumAge: age, maximumAge: age};
  }
  if (/애기|아기|어린|새끼/.test(query)) {
    return {minimumAge: null, maximumAge: 2};
  }
  if (/노령|노견|노묘/.test(query)) {
    return {minimumAge: 8, maximumAge: null};
  }
  return {minimumAge: null, maximumAge: null};
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
  const semanticQuery = buildSemanticQuery(query);
  const embedding = await embedTextQuery(semanticQuery);
  const supabase = createSupabaseServerClient();
  const {data, error} = await supabase.rpc("search_animals_by_text", {
    query_embedding: embedding,
    match_count: limit,
    minimum_similarity: 0.25,
    species_filter: filters.species,
    region_filter: filters.region,
    breed_filter: filters.breed,
    minimum_age_filter: filters.minimumAge,
    maximum_age_filter: filters.maximumAge,
  } as never);

  if (error) {
    throw new Error(`Supabase 텍스트 검색 실패: ${error.message}`);
  }

  return {
    ok: true,
    query,
    semanticQuery,
    filters,
    limit,
    matches: (data ?? []) as Array<{
      animal: Record<string, unknown>;
      similarity: number;
    }>,
  };
}
