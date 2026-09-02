import {createHash} from "node:crypto";
import type {Request} from "express";
import {createSupabaseServerClient} from "./shelterAnimalSupabase.js";

export interface SearchAllowance {
  allowed: boolean;
  limit: number;
  used: number;
  authenticated: boolean;
}

/**
 * 사용자 또는 IP의 일일 텍스트 검색 횟수를 원자적으로 차감합니다.
 * @param {Request} req Express 요청
 * @return {Promise<SearchAllowance>} 검색 허용 결과
 */
export async function consumeTextSearchAllowance(
  req: Request
): Promise<SearchAllowance> {
  const supabase = createSupabaseServerClient();
  const token = getBearerToken(req);
  let userId: string | null = null;

  if (token) {
    const {data, error} = await supabase.auth.getUser(token);
    if (!error) userId = data.user?.id ?? null;
  }

  const authenticated = Boolean(userId);
  const limit = authenticated ? 30 : 2;
  const rawIdentifier = userId ? `user:${userId}` : `ip:${req.ip}`;
  const identifier = createHash("sha256").update(rawIdentifier).digest("hex");
  const {data, error} = await supabase.rpc("consume_ai_search_usage", {
    p_usage_identifier: identifier,
    p_daily_limit: limit,
  } as never);

  if (error) {
    throw new Error(`검색 사용량 확인 실패: ${error.message}`);
  }

  const rawResult = data as unknown;
  const result = (Array.isArray(rawResult) ? rawResult[0] : rawResult) as
    {allowed?: boolean; used_count?: number} | null;
  return {
    allowed: Boolean(result?.allowed),
    limit,
    used: Number(result?.used_count ?? limit),
    authenticated,
  };
}

/**
 * Authorization 헤더에서 Bearer 토큰을 읽습니다.
 * @param {Request} req Express 요청
 * @return {string | null} Bearer 토큰
 */
function getBearerToken(req: Request): string | null {
  const authorization = req.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice("bearer ".length).trim() || null;
}
