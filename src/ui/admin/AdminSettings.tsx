import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AdminClient } from './admin-client'
import { adminErrorMessage } from './admin-client'
import { byteUnits, exactUnitValue, parseUnitBytesDetailed, type ByteUnit } from './admin-math'
import { AdminHelp, StatusBadge } from './admin-help'
import { ObservationNote, size, type ActionOpener, type Settings } from './admin-view'

type Draft = Omit<Settings, 'maxAccountBytes' | 'projectCapacityBytes'> & {
  maxAccountBytes: number | null
  projectCapacityBytes: number | null
}
const switches = [
  [
    'registrationPaused',
    'Registration',
    'Pausing prevents new accounts; existing accounts keep access.',
  ],
  ['uploadsPaused', 'Uploads', 'Pausing stops server uploads; local edits remain on devices.'],
  [
    'sharingPaused',
    'New sharing',
    'Pausing stops new hosted publication; existing hosted shares remain readable.',
  ],
  [
    'emailPaused',
    'Outbound email',
    'Queued email waits until resumed. Expired or cancelled mail is not sent; sends in progress cannot be recalled.',
  ],
] as const
const keys = ['maxAccountBytes', 'projectCapacityBytes'] as const
type SettingKey = (typeof keys)[number]
function settingLabel(key: SettingKey): string {
  return key === 'maxAccountBytes' ? 'Maximum account quota' : 'Project capacity'
}
function settingValue(value: boolean | number | null): string {
  if (typeof value === 'boolean') return value ? 'Paused' : 'Running'
  if (value === null) return 'Invalid'
  return size(value)
}

function CapacityBytesField({
  label,
  bytes,
  observed,
  maximum,
  minimum,
  disabled,
  resetKey,
  onChange,
}: {
  label: string
  bytes: number | null
  observed: number
  maximum: number
  minimum: number
  disabled: boolean
  resetKey: number
  onChange(value: number | null): void
}) {
  const id = useId()
  const [unit, setUnit] = useState<ByteUnit>('MiB')
  const [text, setText] = useState(() => exactUnitValue(observed, 'MiB'))
  const previousBytes = useRef(bytes)
  const localBytes = useRef<number | null | undefined>(undefined)
  const previousReset = useRef(resetKey)
  useEffect(() => {
    // Keep raw local typing until the numeric draft changes independently or reset is explicit
    if (previousReset.current !== resetKey) {
      previousReset.current = resetKey
      previousBytes.current = bytes
      localBytes.current = undefined
      setText(exactUnitValue(bytes ?? observed, unit))
    } else if (previousBytes.current !== bytes) {
      previousBytes.current = bytes
      if (localBytes.current !== bytes) setText(exactUnitValue(bytes ?? observed, unit))
      localBytes.current = undefined
    }
  }, [bytes, observed, resetKey, unit])
  const parsed = parseUnitBytesDetailed(text, unit)
  const invalid = bytes === null || bytes < minimum || bytes > maximum
  const roundedDraft = parsed.roundedFrom && parsed.bytes !== null ? `${parsed.bytes.toLocaleString()} ${parsed.bytes === 1 ? 'byte' : 'bytes'}` : null
  const error = parsed.error === 'unsafe'
      ? 'This value exceeds the maximum safe whole-byte count.'
      : parsed.error === 'format'
        ? 'Enter a nonnegative decimal number.'
        : invalid
          ? `The resulting whole-byte value must be from ${size(minimum)} through deployment capacity (${size(maximum)}).`
          : ''
  return (
    <div className="admin-control admin-byte-control">
      <div className="admin-label-row"><AdminHelp label={label} text={label === 'Project capacity' ? 'The effective owner ceiling for accounted application storage, bounded by deployment capacity. It is not a provider allowance or billing limit.' : 'A separate per-account ceiling. Lowering it preserves existing data but may block new uploads.'} /></div>
      <label className="admin-visually-hidden" htmlFor={id}>{label}</label>
      <span className="admin-byte-input">
        <input
          id={id}
          inputMode="decimal"
          value={text}
          aria-invalid={invalid}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value
            setText(next)
            const parsedNext = parseUnitBytesDetailed(next, unit).bytes
            localBytes.current = parsedNext
            onChange(parsedNext)
          }}
        />
        <select
          aria-label={`${label} unit`}
          value={unit}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value as ByteUnit
            setUnit(next)
            if (bytes !== null) {
              setText(exactUnitValue(bytes, next))
            } else {
              const parsedNext = parseUnitBytesDetailed(text, next).bytes
              localBytes.current = parsedNext
              onChange(parsedNext)
            }
          }}
        >
          {byteUnits.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </span>
      <p>
        Observed: {size(observed)} · Draft: {bytes === null ? 'Invalid' : roundedDraft ?? size(bytes)}
      </p>
      {roundedDraft && <p>Rounded up to {roundedDraft}.</p>}
      {error && (
        <p className="admin-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export default function AdminSettings({
  client,
  openAction,
  refreshKey = 0,
}: {
  client: AdminClient
  openAction: ActionOpener
  refreshKey?: number
}) {
  const [observed, setObserved] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  const observedRef = useRef<Settings | null>(null)
  const sequence = useRef(0)
  // Preserve only local edits across reads; server changes to untouched keys remain authoritative
  const reload = useCallback(
    async (discardDraft = false) => {
      const current = ++sequence.current
      setLoading(true)
      setError('')
      try {
        const next = await client.get<Settings>('settings')
        if (sequence.current === current) {
          const previous = observedRef.current
          setDraft((currentDraft) => {
            if (discardDraft || !previous || !currentDraft) return next
            const localChanges = Object.fromEntries(
              keys
                .filter((key) => currentDraft[key] !== previous[key])
                .map((key) => [key, currentDraft[key]]),
            ) as Partial<Draft>
            return { ...next, ...localChanges }
          })
          setObserved(next)
          observedRef.current = next
          setStale(false)
        }
      } catch (reason) {
        if (sequence.current === current) {
          setError(adminErrorMessage(reason))
          setStale(true)
        }
      } finally {
        if (sequence.current === current) setLoading(false)
      }
    },
    [client],
  )
  useEffect(() => {
    void reload()
    return () => {
      sequence.current++
    }
  }, [reload, refreshKey])
  const changed = observed && draft ? keys.filter((key) => draft[key] !== observed[key]) : []
  const invalid =
    !observed ||
    !draft ||
    draft.maxAccountBytes === null ||
    draft.projectCapacityBytes === null ||
    draft.maxAccountBytes < 0 ||
    draft.projectCapacityBytes <= 0 ||
    draft.maxAccountBytes > observed.deploymentCapacity ||
    draft.projectCapacityBytes > observed.deploymentCapacity
  const refresh = () => {
    if (!changed?.length) void reload()
  }
  return (
    <section>
      <h1 tabIndex={-1}>Service settings</h1>
      <p>
        Owner controls for account admission and application capacity. Provider plans, Access
        policies and billing are managed separately.
      </p>
      {changed?.length ? (
        <button
          type="button"
          onClick={() => {
            setDraft(observed)
            setResetKey((value) => value + 1)
            void reload(true)
          }}
          disabled={loading}
        >
          Discard draft and refresh
        </button>
      ) : (
        <button type="button" onClick={refresh} disabled={loading}>
          Refresh settings
        </button>
      )}
      {loading && <p role="status">Loading settings...</p>}
      {error && (
        <p className="admin-error" role="alert">
          Settings read failed: {error}.{' '}
          {observed
            ? 'The last observed values remain visible; preview is disabled until a successful refresh.'
            : 'Retry the read before editing.'}
        </p>
      )}
      {observed && draft && (
        <>
          <ObservationNote value={observed} />
          <p>
            Observed revision {observed.revision} · Deployment capacity{' '}
            {size(observed.deploymentCapacity)}
          </p>
          <div className="admin-settings">
            <section className="admin-panel">
              <h2>Service controls</h2>
              {switches.map(([key, label, consequence]) => (
                <div className="admin-switch" key={key}>
                  <div className="admin-switch-heading"><strong>{label}</strong><StatusBadge value={observed[key] ? 'Paused' : 'Running'} /></div>
                  <p>{consequence}</p>
                  <button type="button" className={observed[key] ? '' : 'admin-action--warning'} disabled={loading || stale} onClick={(event) => openAction(
                    event.currentTarget,
                    { kind: 'service', id: 'service' }, observed.revision,
                    { type: 'service.settings', patch: { [key]: !observed[key] } }, 'maintenance',
                  )}>{observed[key] ? 'Resume' : 'Pause'} {label.toLowerCase()}</button>
                </div>
              ))}
            </section>
            <section className="admin-panel">
              <h2>Capacity</h2>
              <CapacityBytesField
                label="Maximum account quota"
                bytes={draft.maxAccountBytes}
                observed={observed.maxAccountBytes}
                maximum={observed.deploymentCapacity}
                minimum={0}
                disabled={loading}
                resetKey={resetKey}
                onChange={(next) =>
                  setDraft((current) => current && { ...current, maxAccountBytes: next })
                }
              />
              <CapacityBytesField
                label="Project capacity"
                bytes={draft.projectCapacityBytes}
                observed={observed.projectCapacityBytes}
                maximum={observed.deploymentCapacity}
                minimum={1}
                disabled={loading}
                resetKey={resetKey}
                onChange={(next) =>
                  setDraft((current) => current && { ...current, projectCapacityBytes: next })
                }
              />
              <p>
                Lower limits preserve stored data and can block new capacity increases. Fractional conversions round up to whole bytes. Unit selection changes only the display.
              </p>
            </section>
          </div>
          <section className="admin-panel admin-settings-review">
            <h2>Review draft</h2>
            {changed?.length ? (
              <ul>
                {changed.map((key) => (
                  <li key={key}>
                    {settingLabel(key)}: {settingValue(observed[key])} → {settingValue(draft[key])}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No changes to preview.</p>
            )}
            <div className="admin-actions">
              <button
                type="button"
                disabled={!changed?.length || invalid || stale || loading}
                onClick={(event) => {
                  if (!invalid && draft && observed && changed?.length) {
                    const patch = Object.fromEntries(changed.map((key) => [key, draft[key]]))
                    openAction(
                      event.currentTarget,
                      { kind: 'service', id: 'service' },
                      observed.revision,
                      { type: 'service.settings', patch },
                      'maintenance',
                    )
                  }
                }}
              >
                Preview settings change
              </button>
              <button
                type="button"
                disabled={!changed?.length || loading}
                onClick={() => { setDraft(observed); setResetKey((value) => value + 1) }}
              >
                Reset draft
              </button>
            </div>
            <p>Changes require the server preview and Access confirmation before they apply.</p>
          </section>
        </>
      )}
    </section>
  )
}
