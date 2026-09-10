/*
 * A render error contained to the part of the app that threw.
 *
 * Written because there was none: a single bad render unmounted the whole tree, and
 * what the user saw was a blank white page with an unsaved diagram in it and no way
 * back except a reload that lost the work. The canvas and the panel beside it fail for
 * unrelated reasons, so they fail separately -- a panel that cannot render a node is
 * worth a message inside the panel, not the loss of the drawing.
 *
 * The message is shown rather than swallowed. A boundary that renders "something went
 * wrong" and nothing else costs the one piece of information that makes the report
 * actionable, and this tool is used by engineers.
 */

import { Component } from 'react'
import { TriangleAlert } from 'lucide-react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    /* Kept, because the boundary is what stops this reaching the console as an
       uncaught error -- and the component stack is the only part that says *where*. */
    console.error('Render failed', error, info?.componentStack)
    this.props.onError?.(error)
  }

  /* A boundary holds its error until something changes. For the inspector that is the
     selected node: a panel that cannot render one node should come back for the next,
     rather than staying broken for the rest of the session. */
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-full w-full items-start justify-center overflow-auto bg-white p-4">
        <div className="max-w-md">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-twilio-error">
            <TriangleAlert size={14} aria-hidden="true" />
            {this.props.title ?? 'This part of the app stopped'}
          </p>
          <p className="mt-1 text-xs text-twilio-gray-60">
            {this.props.hint ??
              'The rest of the page is still live, so nothing on the canvas has been lost.'}
          </p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-twilio-gray-20 bg-twilio-gray-10 p-2 font-mono text-[10px] text-twilio-slate">
            {error.message || String(error)}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="nodrag mt-2 rounded-md border border-twilio-gray-20 px-2 py-1 text-xs text-twilio-navy transition-colors hover:border-twilio-blue hover:text-twilio-blue"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}
