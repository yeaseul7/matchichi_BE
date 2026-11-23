/* eslint-disable valid-jsdoc */
import {lookup} from "node:dns/promises";
import {request as httpRequest} from "node:http";
import {request as httpsRequest} from "node:https";
import {BlockList, isIP} from "node:net";
import sharp from "sharp";
import {ImageRequestError, imageLimit} from "./imageLimits.js";

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");

/** IPv4 사설망과 IPv6 로컬·변환·예약 주소를 차단합니다. */
export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  return isIP(address) === 6 && publicV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6");
}

/** DNS 검증 결과를 실제 연결에 고정하고 리다이렉트마다 다시 검증합니다. */
export async function downloadImage(urlString: string): Promise<Buffer> {
  const timeout = imageLimit("IMAGE_DOWNLOAD_TIMEOUT_MS", 10000, 60000);
  const deadline = Date.now() + timeout;
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new ImageRequestError("유효한 이미지 URL이 필요합니다.");
  }
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (!["http:", "https:"].includes(url.protocol) ||
        url.username || url.password ||
        (url.port && !["80", "443"].includes(url.port))) {
      throw new ImageRequestError("이미지 URL은 기본 HTTP(S) 포트만 허용합니다.");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ImageRequestError("이미지 다운로드 시간 초과.", 408);
    const addresses = await new Promise<Awaited<ReturnType<typeof lookup>>[]>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(
          new ImageRequestError("이미지 주소 조회 시간 초과.", 408)
        ), remaining);
        lookup(host, {all: true}).then(resolve, reject)
          .finally(() => clearTimeout(timer));
      }
    );
    if (!addresses.length || addresses.some(({address}) =>
      !isPublicImageAddress(address))) {
      throw new ImageRequestError("공개 인터넷 이미지 주소만 허용합니다.");
    }
    const address = addresses[0];
    const response = await new Promise<Buffer | URL>((resolve, reject) => {
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(url, {
        method: "GET",
        family: address.family,
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
        headers: {Accept: "image/jpeg,image/png,image/webp"},
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          try {
            if (!res.headers.location) throw new Error("리다이렉트 주소 없음");
            resolve(new URL(res.headers.location, url));
          } catch {
            reject(new ImageRequestError("이미지 리다이렉트가 잘못되었습니다."));
          }
          res.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          const status = res.statusCode === 429 ? 429 :
            (res.statusCode && res.statusCode >= 500 ? 502 : 400);
          reject(new ImageRequestError(
            `이미지 서버 HTTP ${res.statusCode}`, status
          ));
          res.destroy();
          return;
        }
        if (Number(res.headers["content-length"]) > IMAGE_MAX_BYTES) {
          reject(new ImageRequestError("이미지는 최대 10MB입니다.", 413));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > IMAGE_MAX_BYTES) {
            reject(new ImageRequestError("이미지는 최대 10MB입니다.", 413));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      const timer = setTimeout(() => req.destroy(
        new ImageRequestError("이미지 다운로드 시간 초과.", 408)
      ), Math.max(1, deadline - Date.now()));
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end();
    });
    if (Buffer.isBuffer(response)) return response;
    url = response;
  }
  throw new ImageRequestError("이미지 URL 리다이렉트가 너무 많습니다.");
}

/** 압축 해제 전 픽셀 수와 실제 파일 형식을 제한합니다. */
export async function validateImage(input: string | Blob): Promise<Blob> {
  if (typeof input !== "string" && input.size > IMAGE_MAX_BYTES) {
    throw new ImageRequestError("이미지는 최대 10MB입니다.", 413);
  }
  const buffer = typeof input === "string" ? await downloadImage(input) :
    Buffer.from(await input.arrayBuffer());
  if (!buffer.length) throw new ImageRequestError("빈 이미지입니다.");
  try {
    const metadata = await sharp(buffer, {
      limitInputPixels: imageLimit("IMAGE_MAX_PIXELS", 16000000, 40000000),
    }).metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
        !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw new Error("지원하지 않는 이미지");
    }
  } catch {
    throw new ImageRequestError("정적 JPEG·PNG·WebP와 허용 픽셀 수를 확인하세요.");
  }
  // 기존 저장 벡터와의 호환성을 위해 리사이즈·크롭·재인코딩하지 않습니다.
  return new Blob([new Uint8Array(buffer)]);
}
