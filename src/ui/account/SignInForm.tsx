import { useState, type FormEvent } from 'react'
import { validatePassword } from '../../account/password-policy'
import { EmailSchema, UsernameSchema } from '../../account/protocol'

export interface AccessInput { email: string; password: string; username: string; remember: boolean }
export function SignInForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: AccessInput, signup: boolean) => Promise<void> }) {
  const [signup, setSignup] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget, data = new FormData(form)
    const input = { email: String(data.get('email')), password: String(data.get('password')), username: String(data.get('username') ?? ''), remember: data.get('remember') === 'on' }
    const message = !EmailSchema.safeParse(input.email).success ? 'Enter a valid email address.' : !validatePassword(input.password).valid ? 'Use at least 15 characters and at most 1024 UTF-8 bytes for your password.' : signup && !UsernameSchema.safeParse(input.username).success ? 'Use 3 to 24 lowercase letters, numbers or underscores for your public screen name.' : ''
    setError(message)
    if (message) { requestAnimationFrame(() => form.querySelector<HTMLElement>('[role="alert"]')?.focus()); return }
    // Uncontrolled password inputs are read once and cleared before asynchronous work
    const password = form.elements.namedItem('password') as HTMLInputElement
    password.value = ''
    await onSubmit(input, signup)
  }
  return <section><h2>{signup ? 'Create account' : 'Sign in'}</h2><form onSubmit={event => void submit(event)} noValidate>
    {error && <div role="alert" tabIndex={-1}>{error}</div>}
    <label>Email<input aria-label="Email" autoComplete="email" name="email" type="email" required/></label><p>Your email stays private.</p>
    {signup && <label>Public screen name<input aria-label="Public screen name" autoComplete="username" name="username" pattern="[a-z0-9_]{3,24}" required/><small>3 to 24 lowercase letters, numbers or underscores. This name is public.</small></label>}
    <label>Password<input aria-label="Password" autoComplete={signup ? 'new-password' : 'current-password'} name="password" type="password" required/><small>At least 15 characters. Spaces and Unicode are welcome.</small></label>
    <label className="account-check"><input name="remember" type="checkbox"/>Remember this device</label><p>Only remember a device you trust.</p>
    <button disabled={busy} type="submit">{signup ? 'Create account and send email' : 'Sign in'}</button>
    <button disabled={busy} type="button" onClick={() => { setSignup(!signup); setError('') }}>{signup ? 'Back to sign in' : 'Create account'}</button>
  </form></section>
}
