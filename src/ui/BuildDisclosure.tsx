import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Icon } from './icons'
import './build-disclosure.css'

export function BuildDisclosure({ label, children, className = '', ...props }: ComponentPropsWithRef<'details'> & { readonly label: ReactNode }) {
  // Keep native disclosure state and forward refs so source-recovery actions can open and focus the same element
  return <details {...props} className={`build-disclosure ${className}`}>
    <summary className="build-disclosure__summary"><span>{label}</span><Icon name="chevron-down"/></summary>
    <div className="build-disclosure__body">{children}</div>
  </details>
}
