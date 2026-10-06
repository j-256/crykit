import { MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { Icon } from './icons'

interface BuildTitleInputProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled: boolean
  readonly formId: string
  readonly required?: boolean
  readonly fallback?: string
  readonly hint?: string
}

export function BuildTitleInput({ value, onChange, disabled, formId, required = false, fallback = 'New Build', hint }: BuildTitleInputProps) {
  return <h1 aria-label={value.trim() || fallback} className="build-title-input">
    {/* The header lives outside the editor form, so keep native submission and validation associated by ID */}
    <input aria-description={hint} aria-label="Build title" className="build-title-input__field" disabled={disabled} form={formId} maxLength={MAX_SHORT_TEXT_LENGTH} onChange={event => onChange(event.target.value)} placeholder={fallback} required={required} title={hint} type="text" value={value}/>
    <Icon className="build-title-input__icon" name="edit"/>
  </h1>
}
