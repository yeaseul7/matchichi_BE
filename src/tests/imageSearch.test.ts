/* eslint-disable valid-jsdoc */
import assert from "node:assert/strict";
import {afterEach, mock, test} from "node:test";
import dns from "node:dns/promises";
import https from "node:https";
import type {IncomingMessage, RequestOptions} from "node:http";
import {EventEmitter} from "node:events";
import sharp from "sharp";
import {Pinecone} from "@pinecone-database/pinecone";
import * as embeddings from "../shared/imageEmbedding.js";
import * as animals from "../shared/shelterAnimalSupabase.js";
import {getAnimalImages} from "../shared/animalImages.js";
import {
  downloadImage, isPublicImageAddress, validateImage,
} from "../shared/imageInput.js";
import {ImageRequestError, ImageWorkLimiter} from "../shared/imageLimits.js";
import {searchSimilarAnimals} from "../jobs/searchSimilarAnimals.js";

const originalEnv = {...process.env};
afterEach(() => {
  mock.restoreAll();
  process.env = {...originalEnv};
});

test("추론이 순차 실행되고 대기 한도 초과는 429, 실패 후에도 재사용", async () => {
  const limiter = new ImageWorkLimiter(1, 1);
  let release: () => void = () => undefined;
  const order: number[] = [];
  const first = limiter.run(async () => {
    order.push(1);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new Error("추론 실패");
  });
  const failed = assert.rejects(first, /추론 실패/);
  const second = limiter.run(async () => order.push(2));
  await assert.rejects(limiter.run(async () => 3),
    (error: unknown) =>
      error instanceof ImageRequestError && error.status === 429);
  assert.deepEqual(order, [1]);
  release();
  await Promise.all([failed, second]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(await limiter.run(async () => 4), 4);
});

test("사설망·메타데이터·IPv4 변환 IPv6 주소 차단", () => {
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1",
    "100.64.0.1", "192.168.1.1", "::1", "fc00::1", "fe80::1",
    "::ffff:127.0.0.1", "2002:7f00:1::", "2001:db8::1"]) {
    assert.equal(isPublicImageAddress(address), false, address);
  }
  assert.equal(isPublicImageAddress("8.8.8.8"), true);
  assert.equal(isPublicImageAddress("2606:4700:4700::1111"), true);
});

test("리다이렉트 주소 재검증과 실제 접속 DNS 고정", async () => {
  mock.method(dns, "lookup", async (host: string) => [{
    address: host === "public.example" ? "8.8.8.8" : "127.0.0.1", family: 4,
  }]);
  let requests = 0;
  mock.method(https, "request", ((
    _url: string | URL, options: RequestOptions,
    callback?: (res: IncomingMessage) => void
  ) => {
    requests++;
    assert.equal(options.family, 4);
    assert.ok(options.lookup);
    options.lookup("public.example", {},
      (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, "8.8.8.8");
        assert.equal(family, 4);
      });
    const req = new EventEmitter();
    Object.assign(req, {
      end: () => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 302,
          headers: {location: "https://internal.example/photo.jpg"},
          destroy: () => req.emit("close"),
        });
        assert.ok(callback);
        callback(res as unknown as IncomingMessage);
      },
      destroy: () => req.emit("close"),
    });
    return req;
  }) as unknown as typeof https.request);
  await assert.rejects(downloadImage("https://public.example/photo.jpg"),
    /공개 인터넷/);
  assert.equal(requests, 1);
});

test("이미지 실제 형식·바이트·픽셀 제한 및 원본 바이트 유지", async () => {
  const buffer = await sharp({create: {
    width: 100, height: 100, channels: 3, background: "white",
  }}).png().toBuffer();
  const validated = await validateImage(new Blob([new Uint8Array(buffer)]));
  assert.deepEqual(Buffer.from(await validated.arrayBuffer()), buffer);
  await assert.rejects(validateImage(new Blob(["not an image"])), /정적 JPEG/);
  await assert.rejects(validateImage(new Blob([
    new Uint8Array(10 * 1024 * 1024 + 1),
  ])), (error: unknown) =>
    error instanceof ImageRequestError && error.status === 413);
  process.env.IMAGE_MAX_PIXELS = "9999";
  await assert.rejects(validateImage(new Blob([new Uint8Array(buffer)])),
    /정적 JPEG/);
});

test("Content-Length 없는 외부 응답도 10MB를 넘으면 중단", async () => {
  mock.method(dns, "lookup", async () => [{address: "8.8.8.8", family: 4}]);
  let destroyed = false;
  mock.method(https, "request", ((
    _url: string | URL, _options: RequestOptions,
    callback?: (res: IncomingMessage) => void
  ) => {
    const req = new EventEmitter();
    Object.assign(req, {end: () => {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200, headers: {},
        destroy: () => {
          destroyed = true;
          req.emit("close");
        },
      });
      assert.ok(callback);
      callback(res as unknown as IncomingMessage);
      res.emit("data", Buffer.alloc(10 * 1024 * 1024 + 1));
    }});
    return req;
  }) as unknown as typeof https.request);
  await assert.rejects(downloadImage("https://public.example/photo.jpg"),
    (error: unknown) =>
      error instanceof ImageRequestError && error.status === 413);
  assert.equal(destroyed, true);
});

test("외부 서버가 응답하지 않아도 다운로드 시간 제한 적용", async () => {
  process.env.IMAGE_DOWNLOAD_TIMEOUT_MS = "10";
  mock.method(dns, "lookup", async () => [{address: "8.8.8.8", family: 4}]);
  mock.method(https, "request", (() => {
    const req = new EventEmitter();
    Object.assign(req, {
      end: () => undefined,
      destroy: (error: Error) => {
        req.emit("error", error);
        req.emit("close");
      },
    });
    return req;
  }) as unknown as typeof https.request);
  await assert.rejects(downloadImage("https://public.example/photo.jpg"),
    (error: unknown) =>
      error instanceof ImageRequestError && error.status === 408);
});

test("CLS 차원·비정상 값 검증과 정규화", () => {
  const data = new Float32Array(384 * 2);
  data[0] = 3;
  data[1] = 4;
  data[384] = 100;
  const result = embeddings.getImageEmbeddingFromResult({
    data, dims: [1, 2, 384],
  });
  assert.equal(result?.length, 384);
  assert.equal(result?.[0], 0.6);
  assert.equal(result?.[1], 0.8);
  assert.equal(embeddings.getImageEmbeddingFromResult({
    data: new Float32Array(768), dims: [1, 1, 768],
  }), null);
  data[0] = NaN;
  assert.equal(embeddings.getImageEmbeddingFromResult({
    data, dims: [1, 2, 384],
  }), null);
});

test("여러 사진은 기본 1장, 설정 상한·중복 제거·첫 벡터 ID 호환", () => {
  delete process.env.IMAGE_MAX_PHOTOS_PER_ANIMAL;
  const item = {
    desertionNo: "123", careRegNo: "456", popfile: "",
    popfile1: "https://example.com/1.jpg",
    popfile2: "https://example.com/1.jpg",
    popfile3: "https://example.com/2.jpg",
    popfile4: "https://example.com/3.jpg",
  };
  assert.deepEqual(getAnimalImages(item), [{
    docId: "123-456", imageUrl: item.popfile1,
  }]);
  process.env.IMAGE_MAX_PHOTOS_PER_ANIMAL = "2";
  assert.deepEqual(getAnimalImages(item).map(({docId}) => docId),
    ["123-456", "123-456::photo2"]);
});

test("강아지 필터·종료 공고 제거·중복 제거·후보 보충", async () => {
  mock.method(embeddings, "embedImage", async () => [1]);
  const candidate = (number: string) => ({
    id: number, score: 0.9,
    metadata: {desertionNo: number, careRegNo: "s"},
  });
  const queries: number[] = [];
  mock.method(Pinecone.prototype, "index", () => ({
    query: async (query: {topK: number; filter: unknown}) => {
      queries.push(query.topK);
      assert.deepEqual(query.filter, {upKindCd: {$eq: "417000"}});
      return {matches: query.topK === 6 ?
        Array.from({length: 6}, () => candidate("closed")) :
        [candidate("closed"), candidate("a"), candidate("a"), candidate("b")]};
    },
  }));
  mock.method(animals, "createSupabaseServerClient", () => ({
    from: () => ({select: () => ({in: () => ({eq: async () => ({
      data: [
        {id: "uuid-closed", desertion_no: "closed", care_reg_no: "s",
          process_state: "종료(입양)"},
        ...["a", "b"].map((number) => ({
          id: `uuid-${number}`, desertion_no: number,
          care_reg_no: number === "b" ? null : "s",
          process_state: number === "a" ? "protect" : "보호중",
        })),
      ], error: null,
    })})})}),
  }));
  const result = await searchSimilarAnimals(new Blob(), "test-key", 2);
  assert.deepEqual(queries, [6, 500]);
  assert.deepEqual(result.matches.map(({id}) => id), ["a", "b"]);
  assert.equal(result.matches[0].metadata?.animalId, "uuid-a");
});

test("공고 상태 확인 실패 시 후보를 그대로 노출하지 않음", async () => {
  mock.method(embeddings, "embedImage", async () => [1]);
  mock.method(Pinecone.prototype, "index", () => ({
    query: async () => ({matches: [{id: "a", metadata: {desertionNo: "a"}}]}),
  }));
  mock.method(animals, "createSupabaseServerClient", () => ({
    from: () => ({select: () => ({in: () => ({eq: async () => ({
      data: null, error: {message: "연결 실패"},
    })})})}),
  }));
  await assert.rejects(searchSimilarAnimals(new Blob(), "test-key", 1),
    /검색 공고 상태 확인 실패/);
});
