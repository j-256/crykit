import { useSyncExternalStore } from 'react'
import { version } from '../../package.json'
import { clearServiceNotice, readServiceNotice, serviceSupportLink, subscribeServiceNotice } from '../account/service-notice'
import { IconButton } from './components'
import './cloud-service-notice.css'

export function CloudServiceNotice() {
  const notice = useSyncExternalStore(subscribeServiceNotice, readServiceNotice, () => undefined)
  if (!notice) return null
  const revision = document.querySelector<HTMLMetaElement>('meta[name="crykit-preview"]')?.content ?? version
  return <aside className="cloud-service-notice" role="alert">
    <div><strong>{notice.code === 'RATE_LIMITED' ? 'Requests temporarily limited' : 'Cloud service paused'}</strong>
      <p>{notice.code === 'RATE_LIMITED' ? 'Requests are temporarily limited to protect CryKit.' : 'Cloud operations are paused by a service usage safeguard.'} You can keep editing on this device.</p>
      {notice.retryAt !== undefined && <p>Try again after <time dateTime={new Date(notice.retryAt).toISOString()}>{new Date(notice.retryAt).toLocaleString()}</time>.</p>}
      <a href={serviceSupportLink(notice, revision)}>Contact us</a>
      {notice.requestId && <details><summary>Details for support</summary><p>Reference: <code>{notice.requestId}</code></p></details>}
    </div>
    <IconButton icon="close" label="Dismiss service notice" onClick={clearServiceNotice}/>
  </aside>
}
