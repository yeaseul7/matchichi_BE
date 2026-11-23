/* eslint-disable require-jsdoc, valid-jsdoc */
export class ImageRequestError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

/** 환경변수를 제한 범위 안의 정수로 읽습니다. */
export function imageLimit(
  name: string, fallback: number, max: number
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name}은 1~${max} 정수여야 합니다.`);
  }
  return value;
}

/** 추론 대기를 제한해 입력 이미지가 무제한 메모리에 쌓이지 않게 합니다. */
export class ImageWorkLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private concurrency: number, private maxWaiting: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) {
        throw new ImageRequestError("이미지 처리 중입니다. 잠시 후 재시도하세요.", 429);
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
