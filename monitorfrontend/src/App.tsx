import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import ChatTester from './pages/ChatTester'
import KPIDashboard from './pages/KPIDashboard'
import TurnTraces from './pages/TurnTraces'
import SessionInspector from './pages/SessionInspector'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ChatTester />} />
          <Route path="metrics" element={<KPIDashboard />} />
          <Route path="traces" element={<TurnTraces />} />
          <Route path="session" element={<SessionInspector />} />
          <Route path="session/:sessionId" element={<SessionInspector />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
