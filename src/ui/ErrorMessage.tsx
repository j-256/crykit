const APP_ERROR_DIAGNOSTIC_SUFFIX = /^(.*?)( Error code [a-z-]+; diagnostic [\w-]+\.)$/s

/** Keep the recovery message readable without losing the identifier needed for support */
export function ErrorMessage({ message }: { readonly message: string }) {
  const parts = APP_ERROR_DIAGNOSTIC_SUFFIX.exec(message)
  if (!parts) return <span>{message}</span>
  return <><span>{parts[1]}</span><details className="error-details"><summary>Diagnostic details</summary><code>{parts[2]?.trim()}</code></details></>
}
