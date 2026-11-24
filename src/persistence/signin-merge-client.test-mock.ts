// Coordinator state-machine tests keep their deterministic captured-source fixture
// The separate client tests exercise reserved preparation, manifests, and private installation
export const createSigninMergeClient = async (_database: unknown, token: Parameters<typeof import('../workspace/signin-merge-client').createSigninMergeClient>[1], _operationId: string, source: import('../workspace/guest-repository').GuestCopySource, _identity: unknown, account: import('../workspace/reviewed-replacement').ReviewedAccountData, check: () => Promise<void>, _progress: unknown, signal: AbortSignal, createWorker: () => Worker) => {
  const worker = source.locator ? createWorker() : undefined
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const copy = createGuestCopyService(async () => { await check(); return source }, () => signal.throwIfAborted())
  const review = await copy.previewSigninMergeReview(token, account)
  return { preview: review.preview, prepare: (receipt: import('./account-activation-attachments').AccountSyncAttachmentValue) => copy.prepareReviewedSigninMerge(token, review, receipt), async dispose() { worker?.terminate(); await review.dispose(); await copy.dispose() } }
}
