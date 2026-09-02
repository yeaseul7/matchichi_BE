import {createHash} from "node:crypto";
import {pipeline} from "@huggingface/transformers";

export const TEXT_MODEL_ID = "Xenova/multilingual-e5-small";
export const TEXT_EMBED_DIM = 384;

export interface TextSearchAnimal {
  up_kind_nm?: string | null;
  kind_nm?: string | null;
  kind_full_nm?: string | null;
  color_cd?: string | null;
  age?: string | null;
  sex_cd?: string | null;
  neuter_yn?: string | null;
  weight?: string | null;
  org_nm?: string | null;
  happen_place?: string | null;
  care_addr?: string | null;
  special_mark?: string | null;
  sfe_soci?: string | null;
  sfe_health?: string | null;
  health_chk?: string | null;
  vaccination_chk?: string | null;
  etc_bigo?: string | null;
}

type TextExtractor = (
  inputs: string | string[],
  options: {pooling: "mean"; normalize: boolean}
) => Promise<{data: Float32Array; dims?: number[]}>;

let cachedExtractor: TextExtractor | null = null;
let extractorPromise: Promise<TextExtractor> | null = null;

/**
 * 동물 행을 검색용 문장으로 변환합니다.
 * @param {TextSearchAnimal} animal 동물 행
 * @return {string} 검색용 문장
 */
export function buildAnimalSearchText(animal: TextSearchAnimal): string {
  const fields: Array<[string, string | null | undefined]> = [
    ["축종", animal.up_kind_nm],
    ["품종", animal.kind_nm || animal.kind_full_nm],
    ["색상", animal.color_cd],
    ["나이", animal.age],
    ["성별", normalizeSex(animal.sex_cd)],
    ["중성화", normalizeYesNo(animal.neuter_yn)],
    ["체중", animal.weight],
    ["지역", animal.org_nm],
    ["발견 장소", animal.happen_place],
    ["보호소 주소", animal.care_addr],
    ["특징", animal.special_mark],
    ["사회성", animal.sfe_soci],
    ["건강", animal.sfe_health || animal.health_chk],
    ["예방접종", animal.vaccination_chk],
    ["기타", animal.etc_bigo],
  ];

  return fields
    .map(([label, value]) => [label, cleanText(value)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join(". ")
    .slice(0, 2000);
}

/**
 * 문자열의 SHA-256 해시를 생성합니다.
 * @param {string} value 원문
 * @return {string} 16진수 해시
 */
export function hashSearchText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 동물 검색 문장을 passage 임베딩으로 변환합니다.
 * @param {string[]} texts 검색 문장 목록
 * @return {Promise<Array<number[]>>} 384차원 임베딩 목록
 */
export async function embedAnimalTexts(texts: string[]): Promise<number[][]> {
  return embedTexts(texts.map((text) => `passage: ${text}`));
}

/**
 * 사용자 검색어를 query 임베딩으로 변환합니다.
 * @param {string} query 사용자 검색어
 * @return {Promise<number[]>} 384차원 임베딩
 */
export async function embedTextQuery(query: string): Promise<number[]> {
  const [embedding] = await embedTexts([`query: ${query}`]);
  return embedding;
}

/**
 * 텍스트 임베딩 모델을 싱글톤으로 로드합니다.
 * @return {Promise<TextExtractor>} 텍스트 feature extractor
 */
async function loadTextExtractor(): Promise<TextExtractor> {
  if (cachedExtractor) return cachedExtractor;
  if (extractorPromise) return extractorPromise;

  extractorPromise = (async () => {
    const extractor = await pipeline("feature-extraction", TEXT_MODEL_ID, {
      dtype: "q8",
    });
    cachedExtractor = extractor as unknown as TextExtractor;
    return cachedExtractor;
  })();
  return extractorPromise;
}

/**
 * 입력 목록을 정규화된 임베딩으로 변환합니다.
 * @param {string[]} inputs E5 접두어가 포함된 입력 목록
 * @return {Promise<Array<number[]>>} 임베딩 목록
 */
async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const extractor = await loadTextExtractor();
  const output = await extractor(inputs, {pooling: "mean", normalize: true});
  const data = Array.from(output.data);
  const rows = output.dims?.[0] ?? inputs.length;
  const dimension = output.dims?.at(-1) ?? data.length / rows;
  if (dimension !== TEXT_EMBED_DIM || rows !== inputs.length) {
    throw new Error(
      `텍스트 임베딩 크기 오류: rows=${rows}, dimension=${dimension}`
    );
  }
  return Array.from({length: rows}, (_, index) =>
    data.slice(index * dimension, (index + 1) * dimension)
  );
}

/**
 * 검색 문장에 들어갈 문자열을 정규화합니다.
 * @param {string | null | undefined} value 원본 문자열
 * @return {string} 정규화된 문자열
 */
function cleanText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 성별 코드를 한글로 정규화합니다.
 * @param {string | null | undefined} value 성별 코드
 * @return {string} 한글 성별
 */
function normalizeSex(value: string | null | undefined): string {
  const normalized = cleanText(value).toUpperCase();
  if (normalized === "M") return "수컷";
  if (normalized === "F") return "암컷";
  if (normalized === "Q") return "미상";
  return normalized;
}

/**
 * Y/N 코드를 한글로 정규화합니다.
 * @param {string | null | undefined} value Y/N/U 코드
 * @return {string} 한글 상태
 */
function normalizeYesNo(value: string | null | undefined): string {
  const normalized = cleanText(value).toUpperCase();
  if (normalized === "Y") return "완료";
  if (normalized === "N") return "미완료";
  if (normalized === "U") return "미상";
  return normalized;
}
