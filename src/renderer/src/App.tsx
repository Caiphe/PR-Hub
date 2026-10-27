import { ReviewForm } from './components/ReviewForm'

function App(): React.JSX.Element {
  return (
    <main className="shell">
      <header className="app-header">
        <h1>PR Hub</h1>
        <p className="muted">Review a pull request against its task.</p>
      </header>
      {/* Wired to the review runner in Prompt 3. */}
      <ReviewForm onSubmit={(input) => console.log('review requested', input)} />
    </main>
  )
}

export default App
