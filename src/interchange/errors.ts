export type InterchangeErrorCode =
  | 'unsupported-format'
  | 'invalid-json'
  | 'invalid-xml'
  | 'invalid-zip'
  | 'unsafe-archive'
  | 'schema-mismatch'
  | 'import-conflict'
  | 'revision-conflict'
  | 'storage-failure'
  | 'not-found'

export class AppDataError extends Error {
  readonly code: InterchangeErrorCode
  readonly diagnosticId: string
  readonly occurredAt: string
  readonly recoverable: boolean
  readonly userMessage: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: InterchangeErrorCode,
    userMessage: string,
    options: {
      recoverable?: boolean
      details?: Readonly<Record<string, unknown>>
      cause?: unknown
    } = {},
  ) {
    super(userMessage, { cause: options.cause })
    this.name = 'AppDataError'
    this.code = code
    this.diagnosticId = globalThis.crypto?.randomUUID?.() ?? `error-${Date.now().toString(36)}`
    this.occurredAt = new Date().toISOString()
    this.recoverable = options.recoverable ?? true
    this.userMessage = userMessage
    this.details = options.details
  }
}

export function asAppDataError(
  error: unknown,
  fallback: Pick<AppDataError, 'code' | 'userMessage' | 'recoverable'>,
): AppDataError {
  if (error instanceof AppDataError) return error
  return new AppDataError(fallback.code, fallback.userMessage, {
    recoverable: fallback.recoverable,
    cause: error,
  })
}
