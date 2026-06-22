import fs from "node:fs";
import path from "node:path";
import {
  App,
  cert,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import {
  Firestore,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";
import {createSupabaseServerClient} from "../shared/shelterAnimalSupabase.js";

const FIRESTORE_BOARDS_COLLECTION =
  process.env.FIRESTORE_BOARDS_COLLECTION?.trim() || "boards";
const SUPABASE_POSTS_TABLE =
  process.env.SUPABASE_POSTS_TABLE?.trim() || "posts";
const SUPABASE_POST_LIKES_TABLE =
  process.env.SUPABASE_POST_LIKES_TABLE?.trim() || "post_likes";
const SUPABASE_COMMENTS_TABLE =
  process.env.SUPABASE_COMMENTS_TABLE?.trim() || "comments";
const SUPABASE_COMMENT_LIKES_TABLE =
  process.env.SUPABASE_COMMENT_LIKES_TABLE?.trim() || "comment_likes";
const SUPABASE_USERS_TABLE =
  process.env.SUPABASE_USERS_TABLE?.trim() || "users";
const SUPABASE_BATCH_SIZE = 200;

type JsonRecord = Record<string, unknown>;

interface FirestoreBoardData extends JsonRecord {
  authorId?: unknown;
  category?: unknown;
  content?: unknown;
  createdAt?: unknown;
  likes?: unknown;
  tags?: unknown;
  title?: unknown;
  updatedAt?: unknown;
}

interface FirestoreCommentData extends JsonRecord {
  authorId?: unknown;
  content?: unknown;
  createdAt?: unknown;
  likes?: unknown;
  updatedAt?: unknown;
}

interface SupabasePostRow {
  id: string;
  author_id: string | null;
  title: string;
  content: string | null;
  likes_count: number;
  created_at: string | null;
  updated_at: string | null;
  main_image_url: string | null;
  category: string | null;
  tags: string[] | null;
  view_count: number;
}

interface SupabasePostLikeRow {
  post_id: string;
  user_id: string;
  created_at: string | null;
}

interface SupabaseCommentRow {
  id: string;
  post_id: string;
  author_id: string | null;
  content: string;
  parent_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SupabaseCommentLikeRow {
  comment_id: string;
  user_id: string;
  created_at: string | null;
}

interface SupabaseLikeError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface MigrateBoardsToSupabaseResult {
  ok: true;
  sourceCollection: string;
  targetPostsTable: string;
  targetPostLikesTable: string;
  targetCommentsTable: string;
  targetCommentLikesTable: string | null;
  boards: number;
  postsUpserted: number;
  postLikesInserted: number;
  commentsUpserted: number;
  commentLikesInserted: number;
  skippedCommentLikes: number;
  skippedPostLikes: number;
  nulledPostAuthors: number;
  nulledCommentAuthors: number;
}

/**
 * Firebase 서비스 계정 JSON 경로 결정
 * @return {string} JSON 절대경로
 */
function resolveFirebaseServiceAccountPath(): string {
  const configured =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (configured) return path.resolve(configured);

  return path.resolve(process.cwd(), "dog-velog-a9a62c2e7959.json");
}

/**
 * Firebase App 단일 인스턴스 보장
 * @return {App} Firebase App
 */
function getFirebaseAdminApp(): App {
  if (getApps().length > 0) {
    return getApp();
  }

  const serviceAccountPath = resolveFirebaseServiceAccountPath();
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      `Firebase 서비스 계정 파일을 찾을 수 없습니다: ${serviceAccountPath}`
    );
  }

  const serviceAccount = JSON.parse(
    fs.readFileSync(serviceAccountPath, "utf8")
  ) as Parameters<typeof cert>[0];

  return initializeApp({
    credential: cert(serviceAccount),
  });
}

/**
 * Firestore 클라이언트 반환
 * @return {Firestore} Firestore
 */
function getFirestoreClient(): Firestore {
  return getFirestore(getFirebaseAdminApp());
}

/**
 * 빈 문자열을 null로 정규화
 * @param {unknown} value 원본 값
 * @return {string | null} trim 결과 또는 null
 */
function toNullableTrimmedString(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * 필수 문자열 검증
 * @param {unknown} value 원본 값
 * @param {string} fallback 대체 문자열
 * @return {string} 문자열
 */
function toRequiredTrimmedString(value: unknown, fallback: string): string {
  const trimmed = toNullableTrimmedString(value);
  return trimmed || fallback;
}

/**
 * 숫자값 정규화
 * @param {unknown} value 원본 값
 * @param {number} fallback 기본값
 * @return {number} 정수
 */
function toInteger(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

/**
 * 배열 태그 정규화
 * @param {unknown} value 원본 값
 * @return {string[] | null} 태그 배열 또는 null
 */
function toNullableTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tags = value
    .map((item) => toNullableTrimmedString(item))
    .filter((item): item is string => Boolean(item));
  return tags.length > 0 ? tags : null;
}

/**
 * Firestore timestamp/date/string을 ISO 문자열로 변환
 * @param {unknown} value 원본 값
 * @return {string | null} ISO 문자열 또는 null
 */
function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as {toDate?: unknown}).toDate === "function"
  ) {
    const date = (value as {toDate: () => Date}).toDate();
    return date.toISOString();
  }

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * 문자열 기반 결정적 UUID 생성
 * @param {string} namespace 네임스페이스
 * @param {string} value 원본 식별자
 * @return {string} UUID
 */
function createDeterministicUuid(namespace: string, value: string): string {
  let seed = 0;
  const source = `${namespace}:${value}`;
  for (let i = 0; i < source.length; i++) {
    seed = Math.imul(seed ^ source.charCodeAt(i), 2654435761) >>> 0;
  }

  let hex = "";
  let state = seed || 1;
  while (hex.length < 32) {
    state = (Math.imul(state ^ 0x9e3779b9, 1664525) + 1013904223) >>> 0;
    hex += state.toString(16).padStart(8, "0");
  }

  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);

  return [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20, 32).join(""),
  ].join("-");
}

/**
 * 본문 HTML에서 첫 이미지 URL 추출
 * @param {string | null} content 게시글 본문
 * @return {string | null} 첫 이미지 URL
 */
function extractMainImageUrl(content: string | null): string | null {
  if (!content) return null;
  const match = content.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match?.[1]?.trim() || null;
}

/**
 * Supabase 에러 텍스트 정규화
 * @param {unknown} error 원본 에러
 * @return {string} 직렬화된 에러 문자열
 */
function formatSupabaseError(error: unknown): string {
  if (!error) return "unknown error";

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object") {
    const typed = error as SupabaseLikeError;
    const normalized = {
      message: typed.message || null,
      code: typed.code || null,
      details: typed.details || null,
      hint: typed.hint || null,
    };
    return JSON.stringify(normalized);
  }

  return String(error);
}

/**
 * comment_likes 테이블 존재 여부 확인
 * @return {Promise<boolean>} 존재 여부
 */
async function hasCommentLikesTable(): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const {error} = await supabase
    .from(SUPABASE_COMMENT_LIKES_TABLE)
    .select("comment_id")
    .limit(1);

  if (!error) return true;

  const errorText = formatSupabaseError(error);
  if (
    errorText.includes("Could not find the table") ||
    errorText.includes("relation") ||
    errorText.includes("does not exist") ||
    errorText.includes("PGRST205")
  ) {
    return false;
  }
  throw new Error(
    `comment_likes 테이블 확인 실패 [${SUPABASE_COMMENT_LIKES_TABLE}]: ` +
      errorText
  );
}

/**
 * users 테이블의 유효한 id 목록 조회
 * @return {Promise<Set<string>>} 사용자 ID 집합
 */
async function fetchExistingUserIds(): Promise<Set<string>> {
  const supabase = createSupabaseServerClient();
  const ids = new Set<string>();
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const to = from + SUPABASE_BATCH_SIZE - 1;
    const {data, error} = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id")
      .range(from, to);

    if (error) {
      throw new Error(
        `users 조회 실패 [${SUPABASE_USERS_TABLE}]: ` +
          formatSupabaseError(error)
      );
    }

    const rows = Array.isArray(data) ? data : [];
    for (const row of rows as Array<{id?: unknown}>) {
      const id = toNullableTrimmedString(row.id);
      if (id) ids.add(id);
    }

    hasMore = rows.length === SUPABASE_BATCH_SIZE;
    from += SUPABASE_BATCH_SIZE;
  }

  return ids;
}

/**
 * FK에 맞게 author_id 정규화
 * @param {unknown} rawAuthorId 원본 authorId
 * @param {Set<string>} existingUserIds users.id 집합
 * @return {object} 정규화 결과
 */
function normalizeAuthorId(
  rawAuthorId: unknown,
  existingUserIds: Set<string>
): {authorId: string | null; nulled: boolean} {
  const authorId = toNullableTrimmedString(rawAuthorId);
  if (!authorId) {
    return {authorId: null, nulled: false};
  }
  if (existingUserIds.has(authorId)) {
    return {authorId, nulled: false};
  }
  return {authorId: null, nulled: true};
}

/**
 * 행 목록을 배치 단위로 upsert
 * @param {string} table 대상 테이블
 * @param {unknown[]} rows 행 목록
 * @param {string} onConflict 충돌 컬럼
 * @return {Promise<number>} 처리 건수
 */
async function upsertRows(
  table: string,
  rows: unknown[],
  onConflict: string
): Promise<number> {
  if (rows.length === 0) return 0;

  const supabase = createSupabaseServerClient();
  let total = 0;
  for (let i = 0; i < rows.length; i += SUPABASE_BATCH_SIZE) {
    const batch = rows.slice(i, i + SUPABASE_BATCH_SIZE);
    const query = supabase.from(table) as never;
    const {error} = await (query as {
      upsert: (
        values: unknown[],
        options: {onConflict: string; ignoreDuplicates: boolean}
      ) => PromiseLike<{error: {message: string} | null}>;
    }).upsert(batch, {
      onConflict,
      ignoreDuplicates: false,
    });
    if (error) {
      throw new Error(
        `Supabase upsert 실패 [${table}]: ${formatSupabaseError(error)}`
      );
    }
    total += batch.length;
  }

  return total;
}

/**
 * 특정 컬럼 값 목록 기준 기존 행 삭제
 * @param {string} table 대상 테이블
 * @param {string} column 컬럼명
 * @param {string[]} ids 삭제 대상 값 목록
 * @return {Promise<number>} 삭제 요청 건수
 */
async function deleteRowsByColumn(
  table: string,
  column: string,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) return 0;

  const supabase = createSupabaseServerClient();
  let total = 0;
  for (let i = 0; i < ids.length; i += SUPABASE_BATCH_SIZE) {
    const batch = ids.slice(i, i + SUPABASE_BATCH_SIZE);
    const {error} = await supabase.from(table).delete().in(column, batch);
    if (error) {
      throw new Error(
        `Supabase delete 실패 [${table}]: ${formatSupabaseError(error)}`
      );
    }
    total += batch.length;
  }

  return total;
}

/**
 * 행 목록 삽입
 * @param {string} table 대상 테이블
 * @param {unknown[]} rows 행 목록
 * @return {Promise<number>} 처리 건수
 */
async function insertRows(table: string, rows: unknown[]): Promise<number> {
  if (rows.length === 0) return 0;

  const supabase = createSupabaseServerClient();
  let total = 0;
  for (let i = 0; i < rows.length; i += SUPABASE_BATCH_SIZE) {
    const batch = rows.slice(i, i + SUPABASE_BATCH_SIZE);
    const query = supabase.from(table) as never;
    const {error} = await (query as {
      insert: (
        values: unknown[]
      ) => PromiseLike<{error: {message: string} | null}>;
    }).insert(batch);
    if (error) {
      throw new Error(
        `Supabase insert 실패 [${table}]: ${formatSupabaseError(error)}`
      );
    }
    total += batch.length;
  }

  return total;
}

/**
 * Firestore boards를 Supabase posts/comments/likes로 마이그레이션
 * @return {Promise<MigrateBoardsToSupabaseResult>} 결과
 */
export async function migrateBoardsToSupabase():
Promise<MigrateBoardsToSupabaseResult> {
  const firestore = getFirestoreClient();
  const boardSnapshots = await firestore
    .collection(FIRESTORE_BOARDS_COLLECTION)
    .get();
  const commentLikesEnabled = await hasCommentLikesTable();
  const existingUserIds = await fetchExistingUserIds();

  const postRows: SupabasePostRow[] = [];
  const postLikeRows: SupabasePostLikeRow[] = [];
  const commentRows: SupabaseCommentRow[] = [];
  const commentLikeRows: SupabaseCommentLikeRow[] = [];
  let skippedCommentLikes = 0;
  let skippedPostLikes = 0;
  let nulledPostAuthors = 0;
  let nulledCommentAuthors = 0;

  for (const boardDoc of boardSnapshots.docs) {
    const boardData = boardDoc.data() as FirestoreBoardData;
    const postId = createDeterministicUuid("post", boardDoc.id);
    const normalizedPostAuthor = normalizeAuthorId(
      boardData.authorId,
      existingUserIds
    );
    if (normalizedPostAuthor.nulled) {
      nulledPostAuthors += 1;
    }

    const likeSnapshots = await boardDoc.ref.collection("likeList").get();
    const boardLikeRows = likeSnapshots.docs
      .map((likeDoc) => {
        const data = likeDoc.data() as JsonRecord;
        const userId = toNullableTrimmedString(data.uid);
        const isLiked = data.isLiked === true;
        if (!userId || !isLiked) return null;
        if (!existingUserIds.has(userId)) {
          skippedPostLikes += 1;
          return null;
        }
        return {
          post_id: postId,
          user_id: userId,
          created_at: toIsoString(data.createdAt),
        } satisfies SupabasePostLikeRow;
      })
      .filter((row): row is SupabasePostLikeRow => Boolean(row));

    postLikeRows.push(...boardLikeRows);

    const content = toNullableTrimmedString(boardData.content);
    postRows.push({
      id: postId,
      author_id: normalizedPostAuthor.authorId,
      title: toRequiredTrimmedString(boardData.title, "(제목 없음)"),
      content,
      likes_count: boardLikeRows.length || toInteger(boardData.likes, 0),
      created_at: toIsoString(boardData.createdAt),
      updated_at: toIsoString(boardData.updatedAt),
      main_image_url: extractMainImageUrl(content),
      category: toNullableTrimmedString(boardData.category),
      tags: toNullableTags(boardData.tags),
      view_count: 0,
    });

    const commentSnapshots = await boardDoc.ref.collection("comments").get();
    for (const commentDoc of commentSnapshots.docs) {
      const commentData = commentDoc.data() as FirestoreCommentData;
      const commentId = createDeterministicUuid(
        "comment",
        `${boardDoc.id}/${commentDoc.id}`
      );
      const normalizedCommentAuthor = normalizeAuthorId(
        commentData.authorId,
        existingUserIds
      );
      if (normalizedCommentAuthor.nulled) {
        nulledCommentAuthors += 1;
      }
      const commentCreatedAt = toIsoString(commentData.createdAt);
      const commentUpdatedAt =
        toIsoString(commentData.updatedAt) || commentCreatedAt;

      commentRows.push({
        id: commentId,
        post_id: postId,
        author_id: normalizedCommentAuthor.authorId,
        content: toRequiredTrimmedString(commentData.content, "(내용 없음)"),
        parent_id: null,
        created_at: commentCreatedAt,
        updated_at: commentUpdatedAt,
      });

      const commentLikeSnapshots = await commentDoc.ref
        .collection("likeList")
        .get();
      const enabledCommentLikeRows = commentLikeSnapshots.docs
        .map((likeDoc) => {
          const data = likeDoc.data() as JsonRecord;
          const userId = toNullableTrimmedString(data.uid);
          const isLiked = data.isLiked === true;
          if (!userId || !isLiked) return null;
          if (!existingUserIds.has(userId)) {
            skippedCommentLikes += 1;
            return null;
          }
          return {
            comment_id: commentId,
            user_id: userId,
            created_at: toIsoString(data.createdAt),
          } satisfies SupabaseCommentLikeRow;
        })
        .filter((row): row is SupabaseCommentLikeRow => Boolean(row));

      if (commentLikesEnabled) {
        commentLikeRows.push(...enabledCommentLikeRows);
      } else {
        skippedCommentLikes += enabledCommentLikeRows.length;
      }
    }
  }

  await upsertRows(SUPABASE_POSTS_TABLE, postRows, "id");

  const postIds = postRows.map((row) => row.id);
  await deleteRowsByColumn(SUPABASE_POST_LIKES_TABLE, "post_id", postIds);
  const insertedPostLikes = await insertRows(
    SUPABASE_POST_LIKES_TABLE,
    postLikeRows
  );

  const upsertedComments = await upsertRows(
    SUPABASE_COMMENTS_TABLE,
    commentRows,
    "id"
  );

  let insertedCommentLikes = 0;
  if (commentLikesEnabled) {
    const commentIds = commentRows.map((row) => row.id);
    await deleteRowsByColumn(
      SUPABASE_COMMENT_LIKES_TABLE,
      "comment_id",
      commentIds
    );
    insertedCommentLikes = await insertRows(
      SUPABASE_COMMENT_LIKES_TABLE,
      commentLikeRows
    );
  }

  return {
    ok: true,
    sourceCollection: FIRESTORE_BOARDS_COLLECTION,
    targetPostsTable: SUPABASE_POSTS_TABLE,
    targetPostLikesTable: SUPABASE_POST_LIKES_TABLE,
    targetCommentsTable: SUPABASE_COMMENTS_TABLE,
    targetCommentLikesTable: commentLikesEnabled ?
      SUPABASE_COMMENT_LIKES_TABLE :
      null,
    boards: boardSnapshots.size,
    postsUpserted: postRows.length,
    postLikesInserted: insertedPostLikes,
    commentsUpserted: upsertedComments,
    commentLikesInserted: insertedCommentLikes,
    skippedCommentLikes,
    skippedPostLikes,
    nulledPostAuthors,
    nulledCommentAuthors,
  };
}
