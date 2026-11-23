import {imageLimit} from "./imageLimits.js";
import type {ShelterAnimalItem} from "./types.js";

/**
 * 첫 사진의 기존 벡터 ID를 유지하고 추가 사진에 슬롯 ID를 부여합니다.
 * @param {ShelterAnimalItem} item 공공데이터 동물
 * @return {object[]} 최대 설정 장수의 사진
 */
export function getAnimalImages(item: ShelterAnimalItem): Array<{
  docId: string; imageUrl: string;
}> {
  const number = String(item.desertionNo ?? "").trim();
  const shelter = String(item.careRegNo ?? "").trim();
  if (!number || !shelter) return [];
  const urls = [item.popfile, item.popfile1,
    ...Array.from({length: 7}, (_, i) => item[`popfile${i + 2}`])];
  const unique = [...new Set(urls.map((url) => url?.trim())
    .filter((url): url is string =>
      Boolean(url && /^https?:\/\//i.test(url))))];
  return unique.slice(0, imageLimit("IMAGE_MAX_PHOTOS_PER_ANIMAL", 1, 8))
    .map((imageUrl, slot) => ({
      docId: `${number}-${shelter}${slot ? `::photo${slot + 1}` : ""}`,
      imageUrl,
    }));
}
