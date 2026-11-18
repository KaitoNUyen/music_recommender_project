import { Routes, Route } from 'react-router-dom'
import { ToastProvider } from './context/ToastContext.jsx'
import { AudioPlayerProvider } from './context/AudioPlayerContext.jsx'
import { PlaylistProvider } from './context/PlaylistContext.jsx'
import ErrorBoundary from './components/common/ErrorBoundary.jsx'
import Header from './components/layout/Header.jsx'
import Footer from './components/layout/Footer.jsx'
import GlobalAudioBar from './components/music/GlobalAudioBar.jsx'
import ToastContainer from './components/common/ToastContainer.jsx'

import Home from './pages/Home.jsx'
import PlaylistStudio from './pages/PlaylistStudio.jsx'
import TasteProfilePage from './pages/TasteProfilePage.jsx'
import ModelStatusPage from './pages/ModelStatusPage.jsx'

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AudioPlayerProvider>
          <PlaylistProvider>
            <div className="app-shell">
              <Header />

              <main className="app-main-content">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/playlist-studio" element={<PlaylistStudio />} />
                  <Route path="/taste-profile" element={<TasteProfilePage />} />
                  <Route path="/model" element={<ModelStatusPage />} />
                </Routes>
              </main>

              <Footer />

              {/* Floating Bottom Audio Bar & Toast Stack */}
              <GlobalAudioBar />
              <ToastContainer />
            </div>
          </PlaylistProvider>
        </AudioPlayerProvider>
      </ToastProvider>
    </ErrorBoundary>
  )
}
