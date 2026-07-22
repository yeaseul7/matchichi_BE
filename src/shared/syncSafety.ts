import {createSupabaseServerClient} from "./shelterAnimalSupabase.js";

const DEFAULT_LEASE_SECONDS = 2 * 60 * 60;

type RpcError = {message: string} | null;
type RpcResult = {data: unknown; error: RpcError};

/**
 * 생성 타입이 없는 운영 RPC를 안전하게 호출
 * @param {object} supabase 클라이언트
 * @param {string} functionName RPC 함수명
 * @param {object} args RPC 인자
 * @return {Promise<object>} RPC 결과
 */
async function callRpc(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  functionName: string,
  args: Record<string, unknown>
): Promise<RpcResult> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    parameters: Record<string, unknown>
  ) => Promise<RpcResult>;
  return rpc(functionName, args);
}

/**
 * Cloud Run 인스턴스 간 중복 실행을 막는 Supabase lease
 * @param {string} jobName 작업 식별자
 * @param {Function} operation 보호할 작업
 * @return {Promise<*>} 작업 결과
 */
export async function withSyncLease<T>(
  jobName: string,
  operation: () => Promise<T>
): Promise<T> {
  const supabase = createSupabaseServerClient();
  const ownerToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const {data, error} = await callRpc(supabase, "acquire_sync_job_lease", {
    p_job_name: jobName,
    p_owner_token: ownerToken,
    p_lease_seconds: DEFAULT_LEASE_SECONDS,
  });

  if (error) {
    throw new Error(`동기화 잠금 획득 실패 [${jobName}]: ${error.message}`);
  }
  if (data !== true) {
    throw new Error(`동일 작업이 이미 실행 중입니다: ${jobName}`);
  }

  try {
    return await operation();
  } finally {
    const {error: releaseError} = await callRpc(
      supabase,
      "release_sync_job_lease",
      {
        p_job_name: jobName,
        p_owner_token: ownerToken,
      }
    );
    if (releaseError) {
      console.error(
        `동기화 잠금 해제 실패 [${jobName}]: ${releaseError.message}`
      );
    }
  }
}

/**
 * stale 후보를 기록하고 서로 다른 2회 실행에서 연속 확인된 ID만 반환
 * @param {string} jobName 작업 식별자
 * @param {string} runId 실행 식별자
 * @param {string[]} staleIds 이번 실행의 stale ID
 * @return {Promise<string[]>} 삭제 가능한 연속 stale ID
 */
export async function observeStaleCandidates(
  jobName: string,
  runId: string,
  staleIds: string[]
): Promise<string[]> {
  const supabase = createSupabaseServerClient();
  const {data, error} = await callRpc(
    supabase,
    "record_sync_stale_candidates",
    {
      p_job_name: jobName,
      p_run_id: runId,
      p_record_ids: staleIds,
    }
  );

  if (error) {
    throw new Error(`stale 후보 기록 실패 [${jobName}]: ${error.message}`);
  }
  if (!Array.isArray(data)) return [];
  return data.map((id: unknown) => String(id));
}
