import { Route, Routes } from 'react-router'
import { AuthGate } from './components/AuthGate'
import { Layout } from './components/Layout'
import { Activity } from './screens/Activity'
import { Dashboard } from './screens/Dashboard'
import { Earn } from './screens/Earn'
import { KycReturn } from './screens/KycReturn'
import { OffRamp } from './screens/OffRamp'
import { OnRamp } from './screens/OnRamp'
import { Receive } from './screens/Receive'
import { Send } from './screens/Send'

function App() {
  return (
    <AuthGate>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/send" element={<Send />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/onramp" element={<OnRamp />} />
          <Route path="/offramp" element={<OffRamp />} />
          <Route path="/earn" element={<Earn />} />
          <Route path="/activity" element={<Activity />} />
        </Route>
        <Route path="/ramp/kyc-return" element={<KycReturn />} />
      </Routes>
    </AuthGate>
  )
}

export default App
