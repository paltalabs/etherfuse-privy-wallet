import { Link } from 'react-router'

/**
 * Landing page for Etherfuse's hosted `/idv` flow's `return_url`
 * (`OnboardingStartRequestSchema`'s `POST /ramp/onboarding/kyc-launch`
 * response; the API derives this exact path server-side as
 * `${CORS_ORIGIN}/ramp/kyc-return`, `api/src/app.ts:152`). The launch form
 * opens the hosted flow in a SEPARATE tab (`target="_blank"`,
 * `core/hooks/ramp.ts`'s launch mechanics) — this page loads in THAT tab
 * once verification is submitted. The original wallet tab is unaffected: it
 * keeps polling `GET /ramp/onboarding` on its own
 * (`useOnboardingStatus`'s 5s poll while `verifying`) and picks up the
 * approval by itself, so this tab has nothing left to do but tell the user
 * it's safe to close it.
 */
export function KycReturn() {
  return (
    <div className="card centered">
      <h1>Verification submitted</h1>
      <p className="muted">
        You can close this tab and go back to your wallet — it will update automatically once verification
        completes.
      </p>
      <Link to="/onramp">Back to wallet</Link>
    </div>
  )
}
