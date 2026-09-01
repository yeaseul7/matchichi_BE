/**
 * 서버 포트를 반환합니다.
 * @return {number} 서버 포트
 */
export function getPort(): number {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT는 1~65535 범위의 정수여야 합니다.");
  }
  return port;
}

/**
 * 필수 환경변수를 반환합니다.
 * @param {string} name 환경변수 이름
 * @return {string} 공백이 제거된 환경변수 값
 */
export function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 환경변수가 설정되지 않았습니다.`);
  }
  return value;
}

/**
 * 운영 또는 Cloud Run 런타임 여부를 반환합니다.
 * @return {boolean} 운영 런타임 여부
 */
export function isProductionRuntime(): boolean {
  return Boolean(process.env.K_SERVICE) ||
    process.env.NODE_ENV === "production";
}
