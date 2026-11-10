export function PrivacyTermsLink() {
  // Keep account form input and unlocked workspace state intact while reading the static page
  return <a href={`${import.meta.env.BASE_URL}privacy/`} target="_blank" rel="noopener noreferrer" aria-label="Privacy, upload, and recovery terms (opens in a new tab)">privacy, upload, and recovery terms</a>
}
