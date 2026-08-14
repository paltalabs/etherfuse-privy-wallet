import { usePrivy } from '@privy-io/react-auth'
import { useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router'
import { useCore } from '../core/context'

const NAV_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/send', label: 'Send' },
  { to: '/receive', label: 'Receive' },
  { to: '/onramp', label: 'On-ramp' },
  { to: '/offramp', label: 'Off-ramp' },
  { to: '/earn', label: 'Earn' },
  { to: '/activity', label: 'Activity' },
]

/** `GDQP…DSB5`-style truncation for a Stellar public key. */
function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

export function Layout() {
  const { logout } = usePrivy()
  const { walletAddress } = useCore()
  const queryClient = useQueryClient()

  // Every query key (['wallet'], ['activity'], ['ramp','onboarding'], ['vault','position'])
  // is user-agnostic, and the QueryClient is a single module-scoped instance for the app's
  // whole lifetime (main.tsx) — so without an explicit clear, a different merchant logging
  // in afterward in the same tab would see the previous merchant's cached responses render
  // synchronously on mount, before the background refetch resolves.
  function handleLogout() {
    queryClient.clear()
    void logout()
  }

  return (
    <div>
      <header className="topbar">
        <span className="app-name">Paltalabs</span>
        {walletAddress && <span className="mono muted">{truncateAddress(walletAddress)}</span>}
        <button className="btn" onClick={handleLogout}>
          Log out
        </button>
      </header>
      <nav className="navbar">
        {NAV_LINKS.map(({ to, label }) => (
          <NavLink key={to} to={to} end={to === '/'}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
